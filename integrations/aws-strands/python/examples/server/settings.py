"""Configuration shared by the dojo server and the demo apps it mounts.

Deliberately stdlib-only. The demo apps build a Strands agent at import time
and pull in provider SDKs the adapter package does not ship, so the tests can
load this module by path without any of that.
"""
import os
import re

CORS_ORIGINS_VAR = "CORS_ALLOW_ORIGINS"
PORT_VAR = "PORT"

WILDCARD = "*"

# What a browser sends from a sandboxed iframe, a file:// page, or some
# redirects. Starlette matches it like any other entry, but it names no site,
# so credentials granted for it are granted to anyone who can send the header.
# Hence its place in the no-credentials set beside the wildcard.
NON_ATTRIBUTABLE_ORIGIN = "null"

_NO_CREDENTIALS = frozenset({WILDCARD, NON_ATTRIBUTABLE_ORIGIN})

_DECIMAL_PORT = re.compile(r"[1-9][0-9]*")

DEFAULT_PORT = 8000

# The demo routes the dojo server mounts, in mount order. Both the mount calls
# and the route listing at `/` are generated from this, so a demo added in one
# place cannot go missing from the other. Both README tables are checked
# against it by the tests.
DEMO_PATHS = (
    "/a2ui-dynamic-schema",
    "/a2ui-fixed-schema",
    "/a2ui-recovery",
    "/agentic-chat",
    "/agentic-chat-reasoning",
    "/agentic-chat-citations",
    "/agentic-chat-multimodal",
    "/backend-tool-rendering",
    "/agentic-generative-ui",
    "/shared-state",
    "/human-in-the-loop",
    "/interrupt",
    "/predictive-state-updates",
    "/tool-based-generative-ui",
    "/multi-agent",
)


def mount_name(path: str) -> str:
    """The Starlette route name for a demo path.

    One derived slug serves three purposes: the route name, the key in the
    listing at `/`, and the stem of the `server.api` attribute asked for at
    mount time.
    Starlette would resolve a display label just as well; what the slug buys is
    one name to keep in step instead of three.
    """
    return path.strip("/").replace("-", "_")


def app_attribute(path: str) -> str:
    """The name `server.api` exports a demo's app under."""
    return f"{mount_name(path)}_app"


def configured_origins() -> list[str]:
    """The origins CORS_ALLOW_ORIGINS names, empty when it is unset or blank.

    Entries are normalised and de-duplicated, never validated. A malformed
    entry stays in the list, where it simply matches nothing; removing it could
    empty a list the operator did fill in, and an empty list falls back to the
    wildcard, which grants strictly more than was asked for.
    """
    named = (normalise_origin(origin) for origin in os.getenv(CORS_ORIGINS_VAR, "").split(","))
    return list(dict.fromkeys(origin for origin in named if origin))


def names_nothing() -> bool:
    """Whether CORS_ALLOW_ORIGINS is unset or holds only whitespace.

    The one case that may fall back to the wildcard. An operator who wrote
    something, even something unusable, asked for a restriction, and widening
    that to "any origin" would be the opposite of what they asked for.
    """
    return not os.getenv(CORS_ORIGINS_VAR, "").strip()


def normalise_origin(origin: str) -> str:
    """One allowlist entry, in the spelling a browser would send.

    A browser Origin is a lowercase scheme://host[:port] carrying no path, and
    Starlette compares the header to the entry exactly. A trailing slash or a
    capital letter therefore matches nothing, and does it silently, so both are
    repaired here rather than failed closed on: they are always typos.

    Repair never widens. If trimming would leave nothing, or would leave the
    wildcard when the operator did not write the wildcard, the entry is kept as
    written so it matches nothing. Otherwise "/" would trim to empty and drop
    out of the list, and "*/" would trim to "*", and either one turns a typo
    into "allow every origin".
    """
    text = origin.strip()
    if text == WILDCARD:
        return WILDCARD
    trimmed = text.rstrip("/").lower()
    if not trimmed or trimmed == WILDCARD:
        return text.lower()
    return trimmed


def cors_origins() -> list[str]:
    """Browser origins to allow, from CORS_ALLOW_ORIGINS (comma-separated).

    An unset, blank, or all-blank value falls back to the `"*"` wildcard, which
    is the intended local-development default and the same fallback
    `create_strands_app` applies. It does mean no value of the variable
    expresses "allow no cross-origin request"; a deployment that needs that
    builds its apps with `cors_enabled=False` rather than setting this.

    Every layer has to be given the same answer. The dojo app and each demo
    mounted inside it install their own CORS middleware, and the mounted one
    runs first: a demo left on the wildcard default answers a disallowed
    origin with `Access-Control-Allow-Origin: *`, then the dojo app's
    middleware adds `Access-Control-Allow-Credentials: true` on its way out.
    Neither layer produces that pair alone, and the wildcard lets any origin
    read whatever the demo serves without a preflight.
    """
    if names_nothing():
        return [WILDCARD]
    configured = configured_origins()
    if configured:
        return configured
    # Something was written, but nothing survived splitting it: a lone comma,
    # say. Keep the raw value as a single entry, which matches no browser
    # request. An empty list would not do: `create_strands_app` reads that as
    # "no preference" and falls back to the wildcard, which is the widening
    # this whole function exists to prevent.
    return [os.getenv(CORS_ORIGINS_VAR, "").strip()]


def allow_credentials(origins: list[str]) -> bool:
    """Whether CORS credentials may be enabled for *origins*.

    Neither a wildcard nor the non-attributable origin can be combined with
    credentials: the first names every site, the second names none, so in both
    cases granting credentials grants them to anyone who can produce the
    header. `create_strands_app` applies the same rule, so the two layers agree
    on the lists the demos pass it. It does not normalise what it is given, so
    a caller handing it raw origins can still see the two differ.
    """
    return bool(origins) and not _NO_CREDENTIALS.intersection(origins)


def resolve_port(raw: str | None, default: int = DEFAULT_PORT) -> int:
    """The port to listen on, from a raw PORT value.

    Unset or blank takes *default*; anything else has to be a plain decimal
    port. `int(os.getenv("PORT", "8000"))` is not enough: a blank value raises
    `invalid literal for int()`, which names neither the variable nor what it
    wanted; `0` is accepted, which binds an arbitrary free port, so the server
    comes up healthy at an address nothing is configured to reach; and `int`
    also accepts `1_0` as 10 and non-ASCII digits, so a typo becomes a
    different port rather than an error.

    The TypeScript examples' `demoPort` behaves the same way at the edges that
    matter: unset or blank falls back, out of range is refused, and the message
    names the variable and the value. It is not the same grammar: `Number`
    takes `1e3` and `0x1f`, `int` takes `1_0` and `0100`, and this accepts none
    of them, because a port is written in plain decimal digits and nothing else.
    """
    if raw is None or not raw.strip():
        return default
    text = raw.strip()
    if _DECIMAL_PORT.fullmatch(text):
        port = int(text)
        # No lower bound: the pattern already forbids a leading zero, so the
        # smallest number it can produce is 1.
        if port <= 65535:
            return port
    raise ValueError(
        f"{PORT_VAR} must be decimal digits with no leading zero, giving a "
        f"number between 1 and 65535, got {raw!r}"
    )


def port_from_env(default: int = DEFAULT_PORT) -> int:
    """`resolve_port` applied to the PORT environment variable."""
    return resolve_port(os.getenv(PORT_VAR), default)
