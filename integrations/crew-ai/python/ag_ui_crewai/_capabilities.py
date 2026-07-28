"""Runtime capability detection for the CrewAI AG-UI bridge (CPK-7718).

crewai's public surface shifted across the 0.x -> 1.x boundary. Rather than
gate code paths on ``crewai.__version__`` (brittle — a version string is not a
feature probe, and users run forks / pre-releases), we RESOLVE each crewai
symbol we depend on here, trying the 1.x location first and falling back to the
0.x location. The probe runs exactly ONCE at import time and its results are
cached on the module-level ``CAPABILITIES`` object.

``crewai.__version__`` is used ONLY for human-facing warning text and the docs
capability table — never as a code-path gate.

Posture: "we support that feature; for this specific one you need crewai >= X."

This module is a LEAF: it imports only ``crewai`` / ``litellm`` and the stdlib,
so ``events`` / ``sdk`` / ``endpoint`` / ``crews`` can all import from it at
module-load time without a circular dependency (mirrors ``_env``).
"""

from __future__ import annotations

import importlib
import logging
from dataclasses import dataclass, field
from typing import Any

_LOGGER = logging.getLogger(__name__)


def _crewai_version() -> str:
    try:
        import crewai

        return getattr(crewai, "__version__", "unknown")
    except Exception:  # pragma: no cover - crewai is a hard dependency
        return "unknown"


def _first_module(candidates: list[str]) -> tuple[Any, str | None]:
    """Import the first importable module from ``candidates``.

    Returns ``(module, dotted_name)`` for the first hit, or ``(None, None)`` if
    none import. Used to resolve a symbol home that moved between crewai
    releases without version-gating.
    """
    for name in candidates:
        try:
            return importlib.import_module(name), name
        except Exception:  # noqa: BLE001 - any import failure is "not here"
            continue
    return None, None


def _resolve_attrs(module: Any, names: list[str]) -> dict[str, Any]:
    return {n: getattr(module, n, None) for n in names}


# --------------------------------------------------------------------------
# Event system resolution
# --------------------------------------------------------------------------
# crewai 1.0.0 DELETED ``crewai.utilities.events`` and re-homed the event bus,
# the flow/method lifecycle events, and the listener base at ``crewai.events``.
# ``BaseEvent`` is no longer re-exported at the package root — it lives at
# ``<events>.base_events.BaseEvent`` under either parent. We try the 1.x home
# first, then the 0.x home, so the bridge keeps working across the declared
# ``crewai>=1.0`` floor AND a 0.x install (belt-and-suspenders).
_EVENTS_MODULE, _EVENTS_MODULE_NAME = _first_module(
    ["crewai.events", "crewai.utilities.events"]
)

_LIFECYCLE_EVENT_NAMES = [
    "crewai_event_bus",
    "FlowStartedEvent",
    "FlowFinishedEvent",
    "MethodExecutionStartedEvent",
    "MethodExecutionFinishedEvent",
    "BaseEventListener",
]

if _EVENTS_MODULE is not None:
    _events_attrs = _resolve_attrs(_EVENTS_MODULE, _LIFECYCLE_EVENT_NAMES)
else:  # pragma: no cover - crewai without an events module is unsupported
    _events_attrs = dict.fromkeys(_LIFECYCLE_EVENT_NAMES, None)

crewai_event_bus = _events_attrs["crewai_event_bus"]
FlowStartedEvent = _events_attrs["FlowStartedEvent"]
FlowFinishedEvent = _events_attrs["FlowFinishedEvent"]
MethodExecutionStartedEvent = _events_attrs["MethodExecutionStartedEvent"]
MethodExecutionFinishedEvent = _events_attrs["MethodExecutionFinishedEvent"]
BaseEventListener = _events_attrs["BaseEventListener"]

# ``BaseEvent`` moved with the events package but is NOT re-exported at the
# root; it stays at ``<events pkg>.base_events.BaseEvent``. The
# ``base_event_listener`` submodule likewise stays under the resolved parent.
_BASE_EVENTS_MODULE, _ = _first_module(
    ["crewai.events.base_events", "crewai.utilities.events.base_events"]
)
BaseEvent = getattr(_BASE_EVENTS_MODULE, "BaseEvent", None) if _BASE_EVENTS_MODULE else None

# The event bus split its single ``_handlers`` mapping into ``_sync_handlers``
# / ``_async_handlers`` at 1.0.0 and now dispatches sync handlers on a
# ThreadPoolExecutor instead of inline on the caller's thread. Detect it so the
# endpoint enqueues thread-safely and the test harness snapshots the right
# attribute(s).
_event_bus_offthread = bool(crewai_event_bus is not None and hasattr(crewai_event_bus, "_sync_handlers"))
_event_bus_has_flush = bool(crewai_event_bus is not None and callable(getattr(crewai_event_bus, "flush", None)))


# --------------------------------------------------------------------------
# StreamFrame streaming contract resolution (CPK-7719)
# --------------------------------------------------------------------------
# crewai landed a public, ordered streaming envelope — ``StreamFrame`` and the
# ``AsyncStreamSession`` returned by ``Flow.astream()`` — in 1.6.0 (hardened in
# 1.15.2). It supersedes the event-bus-listener bridge: a scoped stream sink
# converts every emitted event into an ordered frame, and ``aclose()`` gives us
# real cancellation. We RESOLVE the symbol (never version-gate) and, at the call
# site, ALSO probe ``hasattr(flow, "astream")`` per-flow so test doubles that
# implement only ``kickoff_async`` transparently fall back to the legacy path.
#
# On crewai 1.0-1.5 (StreamFrame absent) the bridge falls back to the legacy
# bus-listener path with a one-time warning naming 1.6.
_STREAMING_TYPES_MODULE, _STREAMING_TYPES_MODULE_NAME = _first_module(
    ["crewai.types.streaming"]
)
StreamFrame = (
    getattr(_STREAMING_TYPES_MODULE, "StreamFrame", None)
    if _STREAMING_TYPES_MODULE is not None
    else None
)
_stream_frame_available = StreamFrame is not None


def flow_supports_stream_frames(flow: Any) -> bool:
    """Return True when ``flow`` can be driven via the StreamFrame contract.

    Two conditions, both required (CPK-7719):

    * The installed crewai exposes ``StreamFrame`` (resolved once at import) —
      i.e. crewai >= 1.6. On 1.0-1.5 this is ``None`` and we fall back.
    * This SPECIFIC flow object exposes ``astream`` — real crewai ``Flow``
      instances do, but the test doubles in ``tests/test_task_cancellation.py``
      implement only ``kickoff_async`` and MUST keep taking the legacy path so
      their cancellation / timeout coverage is unaffected.
    """
    return _stream_frame_available and hasattr(flow, "astream")


# --------------------------------------------------------------------------
# crew-chat helper resolution
# --------------------------------------------------------------------------
# The five crew-chat helpers moved from ``crewai.cli.crew_chat`` to
# ``crewai.utilities.crew_chat`` at crewai 1.15.0 (``crewai.cli`` is now a
# deprecation shim that no longer re-exports them). Try the new home first,
# fall back to the old one, so the crew-serving path works across the whole
# ``crewai>=1.0`` floor.
_CREW_CHAT_HELPER_NAMES = [
    "initialize_chat_llm",
    "generate_crew_chat_inputs",
    "generate_crew_tool_schema",
    "build_system_message",
    "create_tool_function",
]
_CREW_CHAT_MODULE, _CREW_CHAT_MODULE_NAME = _first_module(
    ["crewai.utilities.crew_chat", "crewai.cli.crew_chat"]
)
if _CREW_CHAT_MODULE is not None:
    _crew_chat_attrs = _resolve_attrs(_CREW_CHAT_MODULE, _CREW_CHAT_HELPER_NAMES)
else:
    _crew_chat_attrs = dict.fromkeys(_CREW_CHAT_HELPER_NAMES, None)

initialize_chat_llm = _crew_chat_attrs["initialize_chat_llm"]
generate_crew_chat_inputs = _crew_chat_attrs["generate_crew_chat_inputs"]
generate_crew_tool_schema = _crew_chat_attrs["generate_crew_tool_schema"]
build_system_message = _crew_chat_attrs["build_system_message"]
create_tool_function = _crew_chat_attrs["create_tool_function"]
_crew_chat_available = all(v is not None for v in _crew_chat_attrs.values())


# --------------------------------------------------------------------------
# litellm availability
# --------------------------------------------------------------------------
# crewai moved litellm to the optional ``crewai[litellm]`` extra at 1.0.0. We
# declare ``litellm`` as a DIRECT dependency of ag-ui-crewai (we import
# ``acompletion`` and ``litellm.types`` ourselves) so it resolves regardless of
# crewai extras. Probe it anyway for the capability table / a clear warning.
try:
    import litellm  # noqa: F401

    _litellm_available = True
except Exception:  # pragma: no cover - litellm is a declared direct dep
    _litellm_available = False


@dataclass(frozen=True)
class _Capabilities:
    """Cached, immutable snapshot of the detected crewai capabilities.

    Instantiated exactly once (``CAPABILITIES`` below). ``crewai_version`` is
    for warning text / the docs table only — code paths key off the boolean
    probes and the resolved symbols above, never the version string.
    """

    crewai_version: str
    events_module: str | None
    has_event_bus: bool
    event_bus_offthread: bool
    event_bus_has_flush: bool
    crew_chat_module: str | None
    crew_chat_available: bool
    litellm_available: bool
    stream_frame_available: bool = False
    missing: tuple[str, ...] = field(default_factory=tuple)

    def warn_on_gaps(self) -> None:
        """Emit one WARNING per missing capability, naming the fix.

        Kept idempotent-friendly (call once at import). Each message names the
        crewai version / extra that unlocks the missing capability so operators
        get an actionable signal instead of a deep ImportError later.
        """
        if not self.has_event_bus:
            _LOGGER.warning(
                "ag-ui-crewai could not resolve the crewai event bus "
                "(tried crewai.events, crewai.utilities.events) on crewai %s. "
                "The FastAPI bridge needs it; install crewai>=1.0.",
                self.crewai_version,
            )
        if not self.crew_chat_available:
            _LOGGER.warning(
                "ag-ui-crewai could not resolve the crew-chat helpers (tried "
                "crewai.utilities.crew_chat, crewai.cli.crew_chat) on crewai "
                "%s. The crew-serving endpoint "
                "(add_crewai_crew_fastapi_endpoint) requires them; the flow "
                "endpoint is unaffected.",
                self.crewai_version,
            )
        if not self.litellm_available:
            _LOGGER.warning(
                "ag-ui-crewai could not import litellm on crewai %s. Streaming "
                "completions require it; install litellm (a direct dependency) "
                "or crewai[litellm].",
                self.crewai_version,
            )
        if not self.stream_frame_available:
            # NOT a hard gap — the legacy bus-listener path still works. Emit
            # an INFO-level note (not a WARNING) so operators on 1.0-1.5 know
            # the richer StreamFrame transport unlocks at crewai>=1.6.
            _LOGGER.info(
                "ag-ui-crewai: crewai %s does not expose the StreamFrame "
                "streaming contract (crewai.types.streaming.StreamFrame); the "
                "FastAPI bridge will use the legacy event-bus-listener path. "
                "Upgrade to crewai>=1.6 for the ordered StreamFrame transport.",
                self.crewai_version,
            )


def _detect() -> _Capabilities:
    missing: list[str] = []
    if crewai_event_bus is None:
        missing.append("event_bus")
    if not _crew_chat_available:
        missing.append("crew_chat")
    if not _litellm_available:
        missing.append("litellm")
    caps = _Capabilities(
        crewai_version=_crewai_version(),
        events_module=_EVENTS_MODULE_NAME,
        has_event_bus=crewai_event_bus is not None,
        event_bus_offthread=_event_bus_offthread,
        event_bus_has_flush=_event_bus_has_flush,
        crew_chat_module=_CREW_CHAT_MODULE_NAME,
        crew_chat_available=_crew_chat_available,
        litellm_available=_litellm_available,
        stream_frame_available=_stream_frame_available,
        missing=tuple(missing),
    )
    caps.warn_on_gaps()
    return caps


# Run the probe ONCE at import time and cache the result.
CAPABILITIES = _detect()
