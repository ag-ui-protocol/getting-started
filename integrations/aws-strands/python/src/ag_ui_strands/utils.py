"""Utility functions for AWS Strands integration."""

import base64
import hashlib
import http.client
import ipaddress
import logging
import re
import socket
import time
import urllib.request
import warnings
from dataclasses import dataclass, field
from functools import partial
from typing import Any, Callable, Dict, List, Optional, Set
from urllib.parse import quote, urlsplit, urlunsplit

from ag_ui.core import (
    AudioInputContent,
    BinaryInputContent,
    DocumentInputContent,
    ImageInputContent,
    TextInputContent,
    VideoInputContent,
)
from ag_ui.core.types import InputContentDataSource, InputContentUrlSource

logger = logging.getLogger(__name__)

# Allowed formats per media type for Strands ContentBlock
_IMAGE_FORMATS: Set[str] = {"png", "jpeg", "gif", "webp"}
_DOCUMENT_FORMATS: Set[str] = {"pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"}
_VIDEO_FORMATS: Set[str] = {"flv", "mkv", "mov", "mpeg", "mpg", "mp4", "three_gp", "webm", "wmv"}


# Common MIME subtype aliases that don't directly match the allowed format strings.
# e.g. "text/plain" splits to "plain" but the allowed format is "txt".
_MIME_FORMAT_ALIASES: Dict[str, str] = {
    "plain": "txt",
    "x-markdown": "md",
    "markdown": "md",
    "jpg": "jpeg",
    "msword": "doc",
    "vnd.ms-excel": "xls",
    "vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
}


def _mime_to_format(mime_type: Optional[str], allowed: Set[str]) -> Optional[str]:
    """Parse a MIME type into a short format string.

    For example ``"image/png"`` -> ``"png"``, ``"application/pdf"`` -> ``"pdf"``.
    Returns ``None`` if *mime_type* is absent or the parsed format is not in
    *allowed* — callers should skip the content block rather than guess.
    """
    if not mime_type:
        logger.warning("No MIME type provided, cannot determine format")
        return None
    # Strip MIME parameters (e.g. "; charset=utf-8") before parsing the subtype
    fmt = mime_type.split(";", 1)[0].strip().rsplit("/", 1)[-1].lower()
    # Resolve well-known aliases before checking the allowed set
    fmt = _MIME_FORMAT_ALIASES.get(fmt, fmt)
    if fmt in allowed:
        return fmt
    logger.warning(
        "Unsupported MIME type '%s' (parsed format '%s' not in %s)",
        mime_type,
        fmt,
        sorted(allowed),
    )
    return None


class UrlFetchPolicyError(Exception):
    """Raised when a URL is rejected by the fetch policy (scheme or network range)."""


#: Schemes a fetch may ever use.  Only ``http`` and ``https`` get a transport
#: pinned to the addresses the policy validated (see
#: :class:`_PinnedConnectionMixin`); every other scheme urllib can open would
#: resolve the host a second time on its own, which is exactly the rebinding
#: window the pinning closes.  A policy may narrow this set but not widen it.
_PINNABLE_SCHEMES: frozenset = frozenset({"http", "https"})


@dataclass(frozen=True)
class UrlFetchPolicy:
    """Policy applied to every server-side URL fetch.

    The defaults are deliberately restrictive: only ``http``/``https`` are
    fetched, addresses outside the public internet (loopback, private,
    link-local — notably the ``169.254.169.254`` cloud metadata endpoint —
    multicast and reserved ranges) are refused, the response body is capped,
    and one run gets a bounded number of fetches, a cumulative byte ceiling
    and a cumulative time ceiling.  Relaxing address checks is opt-in by
    passing a custom policy, but link-local ranges (including common cloud
    metadata endpoints) remain blocked, and ``allowed_schemes`` can only be
    narrowed to a subset of :data:`_PINNABLE_SCHEMES`, never widened.

    ``max_bytes`` and ``timeout`` bound a single fetch; ``max_attachments``,
    ``max_total_bytes`` and ``max_total_seconds`` bound everything one run
    fetches together.  ``timeout`` is a socket inactivity timeout, so it does
    not bound a slow trickle on its own; ``max_total_seconds`` is what stops
    one, checked between reads.  A fetch already blocked in ``recv`` when the
    run deadline passes can overshoot it by up to the socket timeout, which
    is itself clamped to the time the run has left.
    """

    allowed_schemes: frozenset = field(default_factory=lambda: frozenset({"http", "https"}))
    allow_private_networks: bool = False
    max_bytes: int = 25 * 1024 * 1024
    timeout: float = 30.0
    max_attachments: int = 10
    max_total_bytes: int = 50 * 1024 * 1024
    max_total_seconds: float = 60.0

    def __post_init__(self) -> None:
        unpinnable = sorted(
            str(scheme) for scheme in self.allowed_schemes
            if str(scheme).lower() not in _PINNABLE_SCHEMES
        )
        if unpinnable:
            raise ValueError(
                f"UrlFetchPolicy cannot allow {unpinnable}: only "
                f"{sorted(_PINNABLE_SCHEMES)} are fetched over a transport pinned "
                "to a validated address, and any other scheme would resolve the "
                "host again at connection time"
            )


DEFAULT_URL_FETCH_POLICY = UrlFetchPolicy()


@dataclass
class _FetchBudget:
    """Ceilings shared by every URL fetch made for one run.

    A per-item cap bounds one attachment; this bounds the whole request, so a
    long attachment list or a server trickling bytes cannot hold the
    conversion open indefinitely.
    """

    policy: Optional[UrlFetchPolicy] = None
    fetches: int = 0
    bytes_read: int = 0
    started: float = field(default_factory=time.monotonic)

    def __post_init__(self) -> None:
        self.policy = self.policy or DEFAULT_URL_FETCH_POLICY

    def remaining_seconds(self) -> float:
        return self.policy.max_total_seconds - (time.monotonic() - self.started)

    def remaining_bytes(self) -> int:
        return max(0, self.policy.max_total_bytes - self.bytes_read)

    def start_fetch(self) -> None:
        """Claim a slot for one more fetch, or refuse the run's budget."""
        if self.fetches >= self.policy.max_attachments:
            raise UrlFetchPolicyError(
                f"run already fetched its limit of {self.policy.max_attachments} URLs"
            )
        if self.remaining_seconds() <= 0:
            raise UrlFetchPolicyError(
                f"run exceeded its {self.policy.max_total_seconds} second total fetch time"
            )
        if self.remaining_bytes() <= 0:
            raise UrlFetchPolicyError(
                f"run exceeded its {self.policy.max_total_bytes} byte total fetch size"
            )
        self.fetches += 1

    def account(self, read: int) -> None:
        self.bytes_read += read


def _is_blocked_address(
    ip: "ipaddress._BaseAddress", allow_private_networks: bool = False
) -> bool:
    """Return ``True`` for any address that must not be reached server-side."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    # Cloud metadata and other link-local services are never legitimate URL
    # content sources, even when an application opts into its private network.
    if ip.is_link_local:
        return True
    if allow_private_networks:
        return False
    return (
        ip.is_loopback
        or ip.is_private
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or not ip.is_global
    )


def _resolved_addresses(host: str, port: Optional[int]) -> List["ipaddress._BaseAddress"]:
    """Resolve *host* to IP addresses, accepting IP literals as-is."""
    literal = host.strip("[]")
    try:
        return [ipaddress.ip_address(literal)]
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise UrlFetchPolicyError(f"Cannot resolve host '{host}': {exc}") from exc
    addresses = []
    for info in infos:
        try:
            addresses.append(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
    if not addresses:
        raise UrlFetchPolicyError(f"Cannot resolve host '{host}' to an IP address")
    return addresses


def _validate_and_resolve_fetch_url(
    url: str,
    policy: Optional[UrlFetchPolicy] = None,
) -> List["ipaddress._BaseAddress"]:
    """Validate *url* and return the exact addresses approved by *policy*."""
    policy = policy or DEFAULT_URL_FETCH_POLICY
    parts = urlsplit(url)
    scheme = (parts.scheme or "").lower()
    if scheme not in policy.allowed_schemes:
        raise UrlFetchPolicyError(
            f"URL scheme '{scheme}' is not allowed "
            f"(allowed: {sorted(policy.allowed_schemes)})"
        )
    if parts.username is not None or parts.password is not None:
        raise UrlFetchPolicyError("URL userinfo credentials are not supported")
    host = parts.hostname
    if not host:
        raise UrlFetchPolicyError("URL has no host")
    addresses = _resolved_addresses(host, parts.port)
    for ip in addresses:
        if _is_blocked_address(ip, policy.allow_private_networks):
            raise UrlFetchPolicyError(
                f"URL host '{host}' resolves to non-public address {ip}, "
                "which is blocked by the URL fetch policy"
            )
    return addresses


def _validate_fetch_url(url: str, policy: Optional[UrlFetchPolicy] = None) -> None:
    """Validate *url* against *policy*; raise :class:`UrlFetchPolicyError` if refused."""
    _validate_and_resolve_fetch_url(url, policy)


def _connect_to_validated_addresses(
    addresses: List["ipaddress._BaseAddress"],
    port: int,
    timeout=socket._GLOBAL_DEFAULT_TIMEOUT,
    source_address=None,
):
    """Connect directly to validated IP literals without another DNS lookup."""
    last_error = None
    for ip in addresses:
        family = socket.AF_INET6 if isinstance(ip, ipaddress.IPv6Address) else socket.AF_INET
        sock = None
        try:
            sock = socket.socket(family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            destination = (str(ip), port, 0, 0) if family == socket.AF_INET6 else (str(ip), port)
            sock.connect(destination)
            return sock
        except OSError as exc:
            last_error = exc
            if sock is not None:
                sock.close()
    if last_error is not None:
        raise last_error
    raise OSError("No validated address is available for the connection")


class _PinnedConnectionMixin:
    """Route an HTTP client's socket to its pre-validated address set."""

    def _pin_addresses(self, addresses: List["ipaddress._BaseAddress"]) -> None:
        self._validated_addresses = addresses
        self._create_connection = self._create_pinned_connection

    def _create_pinned_connection(
        self,
        address,
        timeout=socket._GLOBAL_DEFAULT_TIMEOUT,
        source_address=None,
    ):
        return _connect_to_validated_addresses(
            self._validated_addresses,
            address[1],
            timeout,
            source_address,
        )


class _PinnedHTTPConnection(_PinnedConnectionMixin, http.client.HTTPConnection):
    """HTTP connection whose transport is pinned to validated IP addresses."""

    def __init__(self, host, *, validated_addresses, **kwargs):
        super().__init__(host, **kwargs)
        self._pin_addresses(validated_addresses)


class _PinnedHTTPSConnection(_PinnedConnectionMixin, http.client.HTTPSConnection):
    """HTTPS connection pinned by IP while retaining the hostname for TLS."""

    def __init__(self, host, *, validated_addresses, **kwargs):
        super().__init__(host, **kwargs)
        self._pin_addresses(validated_addresses)


class _PolicyHTTPHandler(urllib.request.HTTPHandler):
    """Validate and pin an HTTP request immediately before connecting."""

    def __init__(self, policy: UrlFetchPolicy):
        super().__init__()
        self._policy = policy

    def http_open(self, req):
        addresses = _validate_and_resolve_fetch_url(req.full_url, self._policy)
        connection = partial(
            _PinnedHTTPConnection,
            validated_addresses=addresses,
        )
        return self.do_open(connection, req)


class _PolicyHTTPSHandler(urllib.request.HTTPSHandler):
    """Validate and pin an HTTPS request immediately before connecting."""

    def __init__(self, policy: UrlFetchPolicy):
        super().__init__()
        self._policy = policy

    def https_open(self, req):
        addresses = _validate_and_resolve_fetch_url(req.full_url, self._policy)
        connection = partial(
            _PinnedHTTPSConnection,
            validated_addresses=addresses,
        )
        return self.do_open(connection, req, context=self._context)


class _PolicyRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-applies the fetch policy to every redirect target."""

    def __init__(self, policy: UrlFetchPolicy):
        self._policy = policy

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_fetch_url(newurl, self._policy)
        # A redirect must not quietly move the transfer onto cleartext.
        if (
            urlsplit(req.full_url).scheme.lower() == "https"
            and urlsplit(newurl).scheme.lower() == "http"
        ):
            raise UrlFetchPolicyError(
                "redirect downgrades the transfer from https to http"
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open_url(url: str, timeout: float, policy: UrlFetchPolicy):
    """Open *url* with policy checks and address pinning on every hop.

    The opener is assembled by hand rather than with
    :func:`urllib.request.build_opener`, which would also install urllib's
    ``ftp``, ``file`` and ``data`` handlers.  Those open a URL without the
    address pinning the HTTP handlers apply, so keeping them out of the opener
    means a scheme this module does not pin has no transport at all rather
    than an unpinned one.  For the same reason no proxy handler is installed:
    a proxy named in the environment would receive the request in place of the
    address the policy validated.
    """
    opener = urllib.request.OpenerDirector()
    for handler in (
        _PolicyHTTPHandler(policy),
        _PolicyHTTPSHandler(policy),
        _PolicyRedirectHandler(policy),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.HTTPErrorProcessor(),
        # Turns an unhandled scheme into a clear URLError instead of a None
        # response the caller would have to interpret.
        urllib.request.UnknownHandler(),
    ):
        opener.add_handler(handler)
    return opener.open(url, timeout=timeout)


_READ_CHUNK_BYTES = 64 * 1024


def _read_within_budget(resp, cap: int, budget: _FetchBudget) -> bytes:
    """Read at most *cap* bytes, giving up if the run runs out of time.

    Reading in chunks is what makes ``max_total_seconds`` enforceable: the
    socket timeout only fires on inactivity, so a server that sends a little
    data inside every timeout window keeps a single ``read`` call alive for as
    long as it likes.  Checking the run deadline between chunks bounds that.

    Reads one byte past *cap* so the caller can tell a body at the limit from
    one over it.
    """
    # ``read1`` hands back the bytes already received; ``read`` waits for the
    # full amount asked for, which would put the whole body back inside one
    # blocking call and defeat the deadline check below.
    read_chunk = getattr(resp, "read1", None)
    if not callable(read_chunk):
        read_chunk = resp.read
    chunks: List[bytes] = []
    read_total = 0
    while read_total <= cap:
        if budget.remaining_seconds() <= 0:
            raise UrlFetchPolicyError(
                f"run exceeded its {budget.policy.max_total_seconds} second "
                "total fetch time"
            )
        chunk = read_chunk(min(_READ_CHUNK_BYTES, cap + 1 - read_total))
        if not chunk:
            break
        read_total += len(chunk)
        budget.account(len(chunk))
        chunks.append(chunk)
    return b"".join(chunks)


def _fetch_url_bytes(
    url: str,
    policy: Optional[UrlFetchPolicy] = None,
    budget: Optional[_FetchBudget] = None,
) -> Optional[bytes]:
    """Fetch raw bytes from *url* using :mod:`urllib`.

    The URL is validated against *policy* (default:
    :data:`DEFAULT_URL_FETCH_POLICY`) before any request is made and again on
    every redirect hop, so ``file://`` reads and requests to private,
    loopback or cloud-metadata addresses are refused.  The response body is
    capped at ``policy.max_bytes``, or at whatever the run's budget has left
    if that is less.

    *budget* carries the ceilings shared with the other fetches of the same
    run (count, cumulative bytes, cumulative time).  Passing one is how a
    caller converting several attachments bounds their total cost; omitting it
    gives this fetch a budget of its own.

    Non-ASCII characters in the URL path (e.g. CJK filenames) are
    percent-encoded before the request to avoid ``UnicodeEncodeError``.

    Returns ``None`` on any failure (policy violation, network error,
    timeout, oversized body); the reason is logged.
    """
    policy = policy or DEFAULT_URL_FETCH_POLICY
    budget = budget if budget is not None else _FetchBudget(policy)
    url_id = hashlib.sha256(url.encode("utf-8", errors="replace")).hexdigest()[:12]
    try:
        budget.start_fetch()
        _validate_fetch_url(url, policy)
        parts = urlsplit(url)
        # Percent-encode non-ASCII chars in the path; preserve already-valid URL chars.
        # '%' is kept in safe= so that existing percent-encoded sequences (e.g. %20,
        # %2F in presigned URLs) are not double-encoded.  The trade-off is that a
        # literal '%' not followed by two hex digits (e.g. "50%.txt") also passes
        # through unescaped — the re.sub below fixes those up into valid %25 escapes.
        encoded_path = quote(parts.path, safe="/:@!$&'()*+,;=-._~%")
        encoded_path = re.sub(r"%(?![0-9A-Fa-f]{2})", "%25", encoded_path)
        # Apply the same encoding to the query string for non-ASCII values.
        # RFC 3986 allows these characters unencoded in a query component, so they
        # must stay in safe= to avoid rewriting presigned URLs (S3/Azure/GCS) or
        # breaking servers that distinguish encoded vs literal separators.
        encoded_query = quote(parts.query, safe="/:@!$&'()*+,;=-._~?%") if parts.query else ""
        encoded_query = re.sub(r"%(?![0-9A-Fa-f]{2})", "%25", encoded_query) if encoded_query else ""
        safe_url = urlunsplit((
            parts.scheme, parts.netloc, encoded_path,
            encoded_query, parts.fragment,
        ))
        # Never wait past the run deadline for a fetch that has stalled.
        timeout = min(policy.timeout, budget.remaining_seconds())
        cap = min(policy.max_bytes, budget.remaining_bytes())
        with _open_url(safe_url, timeout, policy) as resp:
            data = _read_within_budget(resp, cap, budget)
        if len(data) > cap:
            logger.error(
                "Refusing to fetch URL (url_id=%s): response exceeds the %d byte limit",
                url_id,
                cap,
            )
            return None
        return data
    except UrlFetchPolicyError as exc:
        logger.error("Refusing to fetch URL (url_id=%s): %s", url_id, exc)
        return None
    except Exception as exc:
        logger.warning(
            "Failed to fetch URL (url_id=%s): %s",
            url_id,
            type(exc).__name__,
        )
        return None


def _get_mime_type(source: Any) -> Optional[str]:
    """Extract ``mime_type`` from a source object if the attribute exists."""
    return getattr(source, "mime_type", None)


def _resolve_source_bytes(
    source: Any,
    policy: Optional[UrlFetchPolicy] = None,
    budget: Optional[_FetchBudget] = None,
) -> Optional[bytes]:
    """Resolve bytes from an AG-UI content source.

    * :class:`InputContentDataSource` -- base64-decode ``source.value``.
    * :class:`InputContentUrlSource` -- fetch bytes via :func:`_fetch_url_bytes`,
      under *policy* and the run's *budget*.
    """
    if isinstance(source, InputContentDataSource):
        try:
            return base64.b64decode(source.value)
        except Exception as e:
            logger.warning(f"Failed to decode base64 content: {e}")
            return None
    if isinstance(source, InputContentUrlSource):
        return _fetch_url_bytes(source.value, policy, budget)
    logger.warning(f"Unknown content source type: {type(source).__name__}, cannot resolve bytes")
    return None


def convert_agui_content_to_strands(
    content: List[Any],
    policy: Optional[UrlFetchPolicy] = None,
    budget: Optional[_FetchBudget] = None,
) -> List[Dict[str, Any]]:
    """Convert an AG-UI ``InputContent`` list to Strands ``ContentBlock`` dicts.

    Supported content types:

    * :class:`TextInputContent` -> ``{"text": "..."}``
    * :class:`ImageInputContent` -> ``{"image": {"format": ..., "source": {"bytes": ...}}}``
    * :class:`DocumentInputContent` -> ``{"document": {"format": ..., "name": "document", "source": {"bytes": ...}}}``
    * :class:`VideoInputContent` -> ``{"video": {"format": ..., "source": {"bytes": ...}}}``
    * :class:`AudioInputContent` -- skipped with a warning (Strands has no audio support).
    * Unknown types -- skipped with a warning.

    URL sources are fetched under *policy* (default:
    :data:`DEFAULT_URL_FETCH_POLICY`).  *budget* bounds what the whole run
    fetches; pass the same one to every call made for a single request so the
    ceilings apply across all of its attachments.
    """
    blocks: List[Dict[str, Any]] = []
    if budget is None:
        budget = _FetchBudget(policy)

    for item in content:
        if isinstance(item, TextInputContent):
            blocks.append({"text": item.text})

        elif isinstance(item, ImageInputContent):
            raw = _resolve_source_bytes(item.source, policy, budget)
            if raw is None:
                continue
            fmt = _mime_to_format(_get_mime_type(item.source), _IMAGE_FORMATS)
            if fmt is None:
                continue
            blocks.append({
                "image": {
                    "format": fmt,
                    "source": {"bytes": raw},
                }
            })

        elif isinstance(item, DocumentInputContent):
            raw = _resolve_source_bytes(item.source, policy, budget)
            if raw is None:
                continue
            fmt = _mime_to_format(_get_mime_type(item.source), _DOCUMENT_FORMATS)
            if fmt is None:
                continue
            blocks.append({
                "document": {
                    "format": fmt,
                    "name": "document",
                    "source": {"bytes": raw},
                }
            })

        elif isinstance(item, VideoInputContent):
            raw = _resolve_source_bytes(item.source, policy, budget)
            if raw is None:
                continue
            fmt = _mime_to_format(_get_mime_type(item.source), _VIDEO_FORMATS)
            if fmt is None:
                continue
            blocks.append({
                "video": {
                    "format": fmt,
                    "source": {"bytes": raw},
                }
            })

        elif isinstance(item, AudioInputContent):
            logger.warning(
                "Skipping audio content block: Strands does not support audio input."
            )

        elif isinstance(item, BinaryInputContent):
            # Deprecated type — attempt to map to image block
            raw_bytes = None
            if item.data:
                try:
                    raw_bytes = base64.b64decode(item.data)
                except Exception:
                    logger.warning("Skipping binary content: invalid base64 data")
                    continue
            elif item.url:
                raw_bytes = _fetch_url_bytes(item.url, policy, budget)
            if raw_bytes is None:
                logger.warning("Skipping binary content: could not resolve bytes")
                continue
            fmt = _mime_to_format(item.mime_type, _IMAGE_FORMATS)
            if fmt is None:
                logger.warning("Skipping binary content: unsupported MIME type '%s'", item.mime_type)
                continue
            blocks.append({
                "image": {
                    "format": fmt,
                    "source": {"bytes": raw_bytes},
                }
            })

        else:
            logger.warning("Skipping unknown content type: %s", type(item).__name__)

    # Bedrock rejects a message that contains document blocks but no text block.
    if any("document" in b for b in blocks) and not any("text" in b for b in blocks):
        blocks.insert(0, {"text": " "})

    return blocks


def flatten_content_to_text(content: Any) -> str:
    """Extract plain text from AG-UI message content.

    * If *content* is a ``str``, return it as-is.
    * If *content* is a ``list``, join the text of every text block with
      spaces. Both :class:`TextInputContent` instances and the equivalent
      ``{"type": "text", "text": ...}`` mappings are recognised, since content
      reaching the orchestrator path has not been through model validation.
    * If *content* is ``None``, return ``""``.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, TextInputContent):
                parts.append(item.text)
            elif isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return " ".join(parts)
    return ""


def create_strands_app(
    agent: "Any",
    path: str = "/",
    ping_path: str | None = "/ping",
    origins: Optional[List[str]] = None,
    auth: Optional[Callable[..., Any]] = None,
    allow_methods: Optional[List[str]] = None,
    allow_headers: Optional[List[str]] = None,
    cors_enabled: Optional[bool] = None,
) -> "Any":
    """Create a FastAPI app with a single Strands agent endpoint and optional ping endpoint.

    The agent endpoint is unauthenticated unless *auth* is supplied. For
    backward compatibility, permissive wildcard CORS remains enabled when no
    CORS option is supplied, but that implicit fallback emits a
    :class:`FutureWarning` and will be removed in a future release.

    Args:
        agent: The StrandsAgent instance
        path: Path for the agent endpoint (default: "/")
        ping_path: Path for the ping endpoint (default: "/ping"). Pass None to disable.
        origins: Allowed CORS origins. A non-empty list configures those origins
            and silences the implicit-wildcard warning. ``None`` and ``[]``
            preserve the legacy ``["*"]`` fallback. Pass the exact origins your
            frontend is served from, e.g. ``["http://localhost:3000"]``, or pass
            ``["*"]`` to explicitly acknowledge wildcard CORS. Credentials are
            only enabled for explicit, non-wildcard origins — a wildcard origin
            can never be combined with ``allow_credentials=True``.
        auth: Optional FastAPI dependency callable used to authenticate requests
            to the agent endpoint. It should raise
            :class:`fastapi.HTTPException` to reject a request, e.g.::

                def require_token(authorization: str | None = Header(default=None)):
                    if authorization != f"Bearer {os.environ['AGENT_TOKEN']}":
                        raise HTTPException(status_code=401, detail="Unauthorized")

                app = create_strands_app(agent, auth=require_token)

            The ping endpoint stays unauthenticated so health probes keep working.
        allow_methods: CORS methods to allow. ``None`` defaults to ``["*"]``
            for backward compatibility; ``[]`` allows none.
        allow_headers: CORS request headers to allow. ``None`` defaults to
            ``["*"]`` for backward compatibility; ``[]`` allows none beyond
            CORS-safelisted request headers.
        cors_enabled: Explicit CORS switch. Pass ``False`` to add no CORS
            middleware, even if *origins* is supplied. Pass ``True`` to retain
            CORS explicitly; when *origins* is empty, this uses ``["*"]`` without
            emitting the implicit-wildcard warning. ``None`` preserves the
            legacy behavior and warns when *origins* is empty.
    """
    from fastapi import FastAPI
    from .endpoint import add_strands_fastapi_endpoint, add_ping

    app = FastAPI(title=f"AWS Strands - {agent.name}")

    if cors_enabled is None and not origins:
        warnings.warn(
            "Implicit wildcard CORS is insecure and deprecated. Pass origins=[...] "
            "to allow only trusted browser origins, origins=['*'] to explicitly "
            "retain wildcard CORS, or cors_enabled=False to disable CORS. The "
            "implicit wildcard default will be removed in a future release.",
            FutureWarning,
            stacklevel=2,
        )

    # Preserve the legacy permissive CORS behavior unless explicitly disabled.
    if cors_enabled is not False:
        from fastapi.middleware.cors import CORSMiddleware
        cors_origins = origins or ["*"]
        is_wildcard = "*" in cors_origins
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=bool(origins) and not is_wildcard,
            allow_methods=allow_methods if allow_methods is not None else ["*"],
            allow_headers=allow_headers if allow_headers is not None else ["*"],
        )

    # Add the agent endpoint
    add_strands_fastapi_endpoint(app, agent, path, auth=auth)

    # Add ping endpoint if path is provided
    if ping_path is not None:
        add_ping(app, ping_path)

    return app
