"""Utility functions for AWS Strands integration."""

import base64
import logging
import urllib.request
from typing import Any, Dict, List, Optional, Set

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


def _mime_to_format(mime_type: Optional[str], allowed: Set[str]) -> Optional[str]:
    """Parse a MIME type into a short format string.

    For example ``"image/png"`` -> ``"png"``, ``"application/pdf"`` -> ``"pdf"``.
    Returns ``None`` if *mime_type* is absent or the parsed format is not in
    *allowed* — callers should skip the content block rather than guess.
    """
    if not mime_type:
        logger.warning("No MIME type provided, cannot determine format")
        return None
    # Take the part after the last '/'
    fmt = mime_type.rsplit("/", 1)[-1].lower()
    if fmt in allowed:
        return fmt
    logger.warning(
        "Unsupported MIME type '%s' (parsed format '%s' not in %s)",
        mime_type,
        fmt,
        sorted(allowed),
    )
    return None


def _fetch_url_bytes(url: str) -> Optional[bytes]:
    """Fetch raw bytes from *url* using :mod:`urllib`.

    Returns ``None`` on any failure (network error, timeout, etc.).
    """
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return resp.read()
    except Exception as exc:
        logger.warning("Failed to fetch URL %s: %s", url, exc)
        return None


def _get_mime_type(source: Any) -> Optional[str]:
    """Extract ``mime_type`` from a source object if the attribute exists."""
    return getattr(source, "mime_type", None)


def _resolve_source_bytes(source: Any) -> Optional[bytes]:
    """Resolve bytes from an AG-UI content source.

    * :class:`InputContentDataSource` -- base64-decode ``source.value``.
    * :class:`InputContentUrlSource` -- fetch bytes via :func:`_fetch_url_bytes`.
    """
    if isinstance(source, InputContentDataSource):
        try:
            return base64.b64decode(source.value)
        except Exception as e:
            logger.warning(f"Failed to decode base64 content: {e}")
            return None
    if isinstance(source, InputContentUrlSource):
        return _fetch_url_bytes(source.value)
    logger.warning(f"Unknown content source type: {type(source).__name__}, cannot resolve bytes")
    return None


def convert_agui_content_to_strands(content: List[Any]) -> List[Dict[str, Any]]:
    """Convert an AG-UI ``InputContent`` list to Strands ``ContentBlock`` dicts.

    Supported content types:

    * :class:`TextInputContent` -> ``{"text": "..."}``
    * :class:`ImageInputContent` -> ``{"image": {"format": ..., "source": {"bytes": ...}}}``
    * :class:`DocumentInputContent` -> ``{"document": {"format": ..., "name": "document", "source": {"bytes": ...}}}``
    * :class:`VideoInputContent` -> ``{"video": {"format": ..., "source": {"bytes": ...}}}``
    * :class:`AudioInputContent` -- skipped with a warning (Strands has no audio support).
    * Unknown types -- skipped with a warning.
    """
    blocks: List[Dict[str, Any]] = []

    for item in content:
        if isinstance(item, TextInputContent):
            blocks.append({"text": item.text})

        elif isinstance(item, ImageInputContent):
            raw = _resolve_source_bytes(item.source)
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
            raw = _resolve_source_bytes(item.source)
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
            raw = _resolve_source_bytes(item.source)
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
                raw_bytes = _fetch_url_bytes(item.url)
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

    return blocks


def flatten_content_to_text(content: Any) -> str:
    """Extract plain text from AG-UI message content.

    * If *content* is a ``str``, return it as-is.
    * If *content* is a ``list``, join all :class:`TextInputContent` ``.text``
      values with spaces.
    * If *content* is ``None``, return ``""``.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            item.text
            for item in content
            if isinstance(item, TextInputContent)
        ]
        return " ".join(parts)
    return ""


def create_strands_app(
    agent: "Any",
    path: str = "/",
    ping_path: str | None = "/ping",
    origins: Optional[List[str]] = None,
) -> "Any":
    """Create a FastAPI app with a single Strands agent endpoint and optional ping endpoint.

    Args:
        agent: The StrandsAgent instance
        path: Path for the agent endpoint (default: "/")
        ping_path: Path for the ping endpoint (default: "/ping"). Pass None to disable.
        origins: Allowed CORS origins. Defaults to ``["*"]`` (wildcard) for local
            development. Credentials are only enabled when explicit, non-wildcard
            origins are supplied — a wildcard origin can never be combined with
            ``allow_credentials=True``.
    """
    from fastapi import FastAPI
    from .endpoint import add_strands_fastapi_endpoint, add_ping

    app = FastAPI(title=f"AWS Strands - {agent.name}")

    # Add CORS middleware
    from fastapi.middleware.cors import CORSMiddleware
    cors_origins = origins or ["*"]
    is_wildcard = "*" in cors_origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=bool(origins) and not is_wildcard,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Add the agent endpoint
    add_strands_fastapi_endpoint(app, agent, path)

    # Add ping endpoint if path is provided
    if ping_path is not None:
        add_ping(app, ping_path)

    return app
