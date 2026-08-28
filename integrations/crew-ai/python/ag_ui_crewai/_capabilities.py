"""Runtime capability detection for the CrewAI AG-UI bridge.

crewai's public surface shifted across the 0.x -> 1.x boundary. Rather than
gate code paths on ``crewai.__version__`` (brittle — a version string is not a
feature probe, and users run forks / pre-releases), we RESOLVE each crewai
symbol we depend on here, trying the 1.x location first and falling back to the
0.x location. The probe runs exactly ONCE at import time and its results are
cached on the module-level ``CAPABILITIES`` object.

``crewai.__version__`` is used ONLY for human-facing warning text and the docs
capability table — never as a code-path gate.

Posture: "we support that feature; for this specific one you need crewai >= X."

One deliberate exception: ``litellm`` is a DIRECT dependency whose version this
package controls, so the OpenAI Responses event vocabulary is covered by a
declared version RANGE (see ``pyproject.toml``) rather than by probing litellm's
private event-model registry. crewai capability detection stays probe-based.

This module is a LEAF: it imports only ``crewai`` / ``litellm`` and the stdlib,
so ``events`` / ``sdk`` / ``endpoint`` / ``crews`` can all import from it at
module-load time without a circular dependency (mirrors ``_env``).
"""

from __future__ import annotations

import importlib
import importlib.util
import inspect
import logging
from dataclasses import dataclass, field
from typing import Any, get_args

from ag_ui.core import EventType

_LOGGER = logging.getLogger(__name__)


def _safe_getattr(obj: Any, name: str) -> Any:
    """``getattr`` that cannot propagate a caller's property exception.

    Capability probing walks arbitrary user objects, where a raising property must
    read as "absent" rather than failing the query.
    """
    try:
        return getattr(obj, name, None)
    except Exception:  # noqa: BLE001 - a raising property is "not present"
        return None


def _safe_hasattr(obj: Any, name: str) -> bool:
    """``hasattr`` that cannot propagate a caller's property exception.

    Presence, not truthiness: ``GeminiCompletion`` declares
    ``thinking_config: Any = None``, so an "is not None" check would report the
    native provider as absent.
    """
    try:
        return hasattr(obj, name)
    except Exception:  # noqa: BLE001 - a raising property is "not usable"
        return False


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
        except (ImportError, ModuleNotFoundError):
            # Only "module genuinely not here" is a soft miss (fall through to
            # the next candidate). A DIFFERENT error raised while importing an
            # existing module — e.g. a real bug inside ``crewai.events`` (a
            # SyntaxError, an AttributeError from a broken re-export, a failing
            # top-level side effect) — must NOT be swallowed: doing so
            # misreports a genuinely broken install as "install crewai>=1.0".
            # ``ModuleNotFoundError`` is an ``ImportError`` subclass; both are
            # listed for clarity.
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
# StreamFrame streaming contract resolution
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

# The scoped stream-sink API (``crewai.events.stream_context``) landed together
# with ``StreamFrame`` in 1.6. The bridge registers its OWN sink so the frame
# translator receives the RAW AG-UI / lifecycle event object (source + exact
# payload) rather than the ``to_serializable``-mangled ``frame.data`` snapshot.
# ``publish_stream_event`` invokes every sink
# synchronously on ``emit``, so a sink parked by ``event_id`` is guaranteed
# populated before the corresponding frame is dequeued.
_STREAM_CONTEXT_MODULE, _STREAM_CONTEXT_MODULE_NAME = _first_module(
    ["crewai.events.stream_context"]
)
add_stream_sink = (
    getattr(_STREAM_CONTEXT_MODULE, "add_stream_sink", None)
    if _STREAM_CONTEXT_MODULE is not None
    else None
)
reset_stream_sinks = (
    getattr(_STREAM_CONTEXT_MODULE, "reset_stream_sinks", None)
    if _STREAM_CONTEXT_MODULE is not None
    else None
)

# The StreamFrame path needs BOTH the frame type and the sink API. They ship
# together (1.6), but require both so a partial install falls back cleanly.
_stream_frame_available = (
    StreamFrame is not None
    and callable(add_stream_sink)
    and callable(reset_stream_sinks)
)


def flow_supports_stream_frames(flow: Any) -> bool:
    """Return True when ``flow`` can be driven via the StreamFrame contract.

    Two conditions, both required:

    * The installed crewai exposes ``StreamFrame`` (resolved once at import) —
      i.e. crewai >= 1.6. On 1.0-1.5 this is ``None`` and we fall back.
    * This SPECIFIC flow object exposes ``astream`` — real crewai ``Flow``
      instances do, but the test doubles in ``tests/test_task_cancellation.py``
      implement only ``kickoff_async`` and MUST keep taking the legacy path so
      their cancellation / timeout coverage is unaffected.
    """
    return _stream_frame_available and hasattr(flow, "astream")


def flow_supports_conversational_stream(flow: Any) -> bool:
    """Return whether ``flow`` exposes CrewAI's public turn stream API."""
    return (
        _stream_frame_available
        and _safe_getattr(flow, "conversational") is True
        and callable(_safe_getattr(flow, "stream_turn"))
    )


# --------------------------------------------------------------------------
# conversational message roles
# --------------------------------------------------------------------------
# CrewAI's conversational history is TYPED: ``ConversationMessage.role`` is a
# closed literal, and a state deriving from ``ConversationState`` types its
# ``messages`` as ``list[ConversationMessage]``. AG-UI's own role vocabulary is
# wider (``developer`` among them), and one unheld role anywhere in a seeded
# history fails validation for the WHOLE turn.
#
# Read the accepted set off the installed literal rather than hardcoding one
# release's answer. When the symbol is absent or reshaped, fall back to the four
# roles CrewAI has documented for the conversational surface, which keeps every
# role that already worked working.
_FALLBACK_CONVERSATIONAL_MESSAGE_ROLES = frozenset(
    {"user", "assistant", "system", "tool"}
)
_CONVERSATIONAL_MODULE, _CONVERSATIONAL_MODULE_NAME = _first_module(
    ["crewai.experimental.conversational"]
)
ConversationMessageRole = (
    getattr(_CONVERSATIONAL_MODULE, "ConversationMessageRole", None)
    if _CONVERSATIONAL_MODULE is not None
    else None
)
_probed_conversational_message_roles = frozenset(
    role for role in get_args(ConversationMessageRole) if isinstance(role, str)
)
_conversational_message_roles = (
    _probed_conversational_message_roles or _FALLBACK_CONVERSATIONAL_MESSAGE_ROLES
)


def conversational_message_roles() -> frozenset[str]:
    """The message roles CrewAI's conversational history can hold."""
    return _conversational_message_roles


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


# --------------------------------------------------------------------------
# Reasoning resolution
# --------------------------------------------------------------------------
# Three channels carry model reasoning: the litellm chat-completions streaming
# delta (``reasoning_content`` / ``thinking_blocks`` -- provider-agnostic, always
# available since litellm is a direct dep), crewai's native
# ``LLMThinkingChunkEvent`` (its Gemini provider, crewai >= 1.10.1), and the
# OpenAI Responses API (resolved further down). The thinking event
# lives at ``crewai.events.types.llm_events`` (1.x) / ``crewai.utilities.events.
# llm_events`` (0.x) and is NOT re-exported at the events-package root. Resolved
# here (before ``_detect``) so both the capability snapshot and the frame-path
# sink gate share ONE probe.
_LLM_EVENTS_MODULE, _ = _first_module(
    ["crewai.events.types.llm_events", "crewai.utilities.events.llm_events"]
)
LLMThinkingChunkEvent = (
    getattr(_LLM_EVENTS_MODULE, "LLMThinkingChunkEvent", None)
    if _LLM_EVENTS_MODULE is not None
    else None
)
_thinking_event_available = LLMThinkingChunkEvent is not None

# Third channel: the OpenAI Responses API. OpenAI's reasoning models expose their
# reasoning SUMMARIES only there -- chat-completions carries none, for any of
# them -- so surfacing an OpenAI trace needs a separate streaming path. The
# channel resolves off litellm's PUBLIC ``aresponses`` entrypoint; the event
# vocabulary it streams is covered by this package's declared litellm range (see
# the ``litellm`` requirement in ``pyproject.toml``), not by probing litellm's
# private event-model registry.
_RESPONSES_ENTRYPOINT = (
    getattr(litellm, "aresponses", None) if _litellm_available else None
)


def responses_entrypoint():
    """Return litellm's async Responses-API entrypoint, or ``None``.

    Resolved once at import; callers probe the RETURN VALUE rather than a
    version, so a litellm without the entrypoint degrades to chat-completions.
    """
    return _RESPONSES_ENTRYPOINT


_responses_api_available = callable(_RESPONSES_ENTRYPOINT)


def any_reasoning_channel(
    *,
    litellm_available: bool,
    thinking_event_available: bool,
    responses_api_available: bool,
) -> bool:
    """Whether reasoning can surface at all, given which channels resolved.

    Reasoning is available whenever ANY channel is live, never gated to one
    provider or one transport: a build with only the native thinking event, or
    only the Responses API, still surfaces REASONING_*. Kept as one predicate so
    the declaration cannot drift back to a single-channel gate.
    """
    return litellm_available or thinking_event_available or responses_api_available


#: ``reasoning.reason`` when the capability is unavailable. Reasoning drops out
#: only when ALL THREE channels are absent (no litellm delta, no native thinking
#: event, no Responses API), so the reason names that condition rather than
#: blaming any single channel.
NO_REASONING_CHANNEL = "no_reasoning_channel_available"


# --------------------------------------------------------------------------
# Checkpointing resolution
# --------------------------------------------------------------------------
# crewai's checkpointing pieces landed in different releases, so each is
# resolved/probed independently (never gated on ``__version__``) and its
# enabling version named in the warning text. ``from_checkpoint`` (1.13)
# predates ``CheckpointConfig`` (1.14), so the two are probed separately: on
# 1.13.x the kwarg exists but no config can be built, and the bridge stays on
# the no-checkpoint path.
CHECKPOINT_ENABLING_VERSIONS: dict[str, str] = {
    "from_checkpoint": "1.13.0",
    "checkpoint_config": "1.14.0",
    "fork": "1.14.2",
    "checkpoint_events": "1.14.3",
    "restore_from_state_id": "1.14.5",
}

_CREWAI_MODULE, _ = _first_module(["crewai"])
_Flow = getattr(_CREWAI_MODULE, "Flow", None) if _CREWAI_MODULE else None
_Crew = getattr(_CREWAI_MODULE, "Crew", None) if _CREWAI_MODULE else None
_conversational_stream_available = bool(
    _stream_frame_available
    and _Flow is not None
    and callable(_safe_getattr(_Flow, "stream_turn"))
)

# ``BaseAgent`` is the base every crewai agent derives from, including a user's
# own subclass, so it is the wider net for "this attribute is an agent".
# ``crewai.Agent`` is the fallback for a build that does not expose it.
_BASE_AGENT_MODULE, _ = _first_module(["crewai.agents.agent_builder.base_agent"])
_Agent = (
    getattr(_BASE_AGENT_MODULE, "BaseAgent", None) if _BASE_AGENT_MODULE else None
) or (getattr(_CREWAI_MODULE, "Agent", None) if _CREWAI_MODULE else None)


def _kwarg_in_signature(func: Any, name: str) -> bool:
    """True when ``func`` declares a parameter ``name`` (or accepts ``**kwargs``).

    Used to probe whether a crewai release grew a given keyword argument
    without gating on the version string. A ``**kwargs`` catch-all counts as
    "accepts it": passing an unknown kwarg through ``**kwargs`` is safe.
    """
    if func is None:
        return False
    try:
        params = inspect.signature(func).parameters
    except (TypeError, ValueError):  # pragma: no cover - C builtins etc.
        return False
    if name in params:
        return True
    return any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())


# ``CheckpointConfig`` is re-exported at the crewai root (1.14+); its canonical
# home is ``crewai.state.checkpoint_config``. Try the root first, then the
# module, so a partial / future re-org still resolves.
CheckpointConfig = getattr(_CREWAI_MODULE, "CheckpointConfig", None) if _CREWAI_MODULE else None
_CKPT_STATE_MODULE, _CKPT_STATE_MODULE_NAME = _first_module(["crewai.state"])
if CheckpointConfig is None and _CKPT_STATE_MODULE is not None:
    CheckpointConfig = getattr(_CKPT_STATE_MODULE, "CheckpointConfig", None)

# ``JsonProvider`` / ``SqliteProvider`` live on ``crewai.state`` (NOT the crewai
# root, verified on the 1.15.7 wheel).
JsonProvider = getattr(_CKPT_STATE_MODULE, "JsonProvider", None) if _CKPT_STATE_MODULE else None
SqliteProvider = getattr(_CKPT_STATE_MODULE, "SqliteProvider", None) if _CKPT_STATE_MODULE else None

# The Checkpoint*Event lifecycle types live at
# ``crewai.events.types.checkpoint_events`` (not re-exported at the
# ``crewai.events`` root on 1.15.x). Resolved for callers that surface them;
# the persistence wiring here does not depend on them.
_CKPT_EVENTS_MODULE, _CKPT_EVENTS_MODULE_NAME = _first_module(
    ["crewai.events.types.checkpoint_events"]
)
_checkpoint_events_available = _CKPT_EVENTS_MODULE is not None and (
    getattr(_CKPT_EVENTS_MODULE, "CheckpointCompletedEvent", None) is not None
)

# ``from_checkpoint`` / ``restore_from_state_id`` are probed on ``Flow`` (the
# bridge only checkpoints flows; the crew endpoint wraps its crew in a
# ``ChatWithCrewFlow``). These are the CLASS-level probes for the capability
# table / warnings; the per-flow guard below re-probes the SPECIFIC instance so
# test doubles that implement only ``kickoff_async(self, inputs=None)`` stay on
# the no-checkpoint path.
_flow_from_checkpoint_supported = _kwarg_in_signature(
    getattr(_Flow, "kickoff_async", None), "from_checkpoint"
)
_flow_restore_from_state_id_supported = _kwarg_in_signature(
    getattr(_Flow, "kickoff_async", None), "restore_from_state_id"
)
_checkpoint_fork_supported = callable(getattr(_Flow, "fork", None)) or callable(
    getattr(_Crew, "fork", None)
)
# Checkpointing needs a config type AND at least one provider to build one. The
# ``from_checkpoint`` kwarg alone (crewai 1.13) is inert without them.
_checkpoint_config_available = CheckpointConfig is not None and (
    JsonProvider is not None or SqliteProvider is not None
)
# The full persistence path is usable when we can both build a config and pass
# it: i.e. the config type, a provider, and the kwarg are all present.
_checkpointing_available = _checkpoint_config_available and _flow_from_checkpoint_supported


def flow_supports_checkpointing(flow: Any) -> bool:
    """Return True when THIS flow can be checkpointed via ``from_checkpoint``.

    Two conditions, both required (mirrors ``flow_supports_stream_frames``):

    * the installed crewai can build a ``CheckpointConfig`` and exposes the
      ``from_checkpoint`` kwarg (crewai >= 1.14 for both), and
    * this SPECIFIC flow object exposes a driving method (``astream`` or
      ``kickoff_async``) whose signature actually accepts ``from_checkpoint``.

    The per-flow re-probe is what keeps the cancellation test doubles in
    ``tests/test_task_cancellation.py`` (which implement only
    ``kickoff_async(self, inputs=None)``) on the no-checkpoint path, so their
    27 cancellation / timeout tests are unaffected.
    """
    if not _checkpointing_available:
        return False
    for method_name in ("astream", "kickoff_async"):
        if _kwarg_in_signature(getattr(flow, method_name, None), "from_checkpoint"):
            return True
    return False


def supported_checkpoint_kwargs(method: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    """Filter ``kwargs`` to those the bound ``method`` actually declares.

    The last line of defence at the call site: even after
    ``flow_supports_checkpointing`` gates the build, the frame path calls
    ``astream`` and the legacy path calls ``kickoff_async`` (different methods).
    Filtering per-method means a flow that grew one kwarg but not the other (or
    a test double that grew neither) degrades to a no-op instead of raising
    ``TypeError: unexpected keyword argument``.
    """
    if not kwargs:
        return {}
    try:
        params = inspect.signature(method).parameters
    except (TypeError, ValueError):  # pragma: no cover - C builtins etc.
        return {}
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(kwargs)
    return {k: v for k, v in kwargs.items() if k in params}


# --------------------------------------------------------------------------
# Async human-feedback (HITL) resolution
# --------------------------------------------------------------------------
# crewai's async HITL landed at 1.8: a flow method wrapped with
# ``@human_feedback`` whose provider RAISES ``HumanFeedbackPending`` pauses the
# run; the framework persists the pending state and ``Flow.from_pending(flow_id)``
# + ``flow.resume_async(feedback)`` resume it. The pause / feedback lifecycle
# events live on ``crewai.events.types.flow_events`` and are NOT re-exported at
# the ``crewai.events`` root (verified on the 1.15.7 wheel), so resolve them
# there first, with the root as a fallback for a future re-export.
_FLOW_EVENTS_MODULE, _FLOW_EVENTS_MODULE_NAME = _first_module(
    ["crewai.events.types.flow_events", "crewai.events"]
)
_HITL_EVENT_NAMES = [
    "HumanFeedbackRequestedEvent",
    "HumanFeedbackReceivedEvent",
    "FlowPausedEvent",
    "MethodExecutionPausedEvent",
]
if _FLOW_EVENTS_MODULE is not None:
    _hitl_event_attrs = _resolve_attrs(_FLOW_EVENTS_MODULE, _HITL_EVENT_NAMES)
else:  # pragma: no cover - crewai without a flow-events module is pre-HITL
    _hitl_event_attrs = dict.fromkeys(_HITL_EVENT_NAMES, None)
# Fall back to the crewai.events root for any name the primary module missed.
_EVENTS_ROOT_MODULE, _ = _first_module(["crewai.events"])
if _EVENTS_ROOT_MODULE is not None:
    for _name, _value in list(_hitl_event_attrs.items()):
        if _value is None:
            _hitl_event_attrs[_name] = getattr(_EVENTS_ROOT_MODULE, _name, None)

HumanFeedbackRequestedEvent = _hitl_event_attrs["HumanFeedbackRequestedEvent"]
HumanFeedbackReceivedEvent = _hitl_event_attrs["HumanFeedbackReceivedEvent"]
FlowPausedEvent = _hitl_event_attrs["FlowPausedEvent"]
MethodExecutionPausedEvent = _hitl_event_attrs["MethodExecutionPausedEvent"]

# The pause signal + provider protocol live on ``crewai.flow``.
_FLOW_PKG_MODULE, _ = _first_module(["crewai.flow"])
HumanFeedbackPending = (
    getattr(_FLOW_PKG_MODULE, "HumanFeedbackPending", None) if _FLOW_PKG_MODULE else None
)
HumanFeedbackProvider = (
    getattr(_FLOW_PKG_MODULE, "HumanFeedbackProvider", None) if _FLOW_PKG_MODULE else None
)

# Resume API, probed on the resolved Flow class (``from_pending`` is a
# classmethod, ``resume_async`` an instance coroutine).
_flow_from_pending_supported = callable(getattr(_Flow, "from_pending", None))
_flow_resume_async_supported = callable(getattr(_Flow, "resume_async", None))


def _model_has_field(model: Any, field_name: str) -> bool:
    """True when a Pydantic ``model`` declares ``field_name``."""
    fields = getattr(model, "model_fields", None)
    return bool(fields) and field_name in fields


# ``HumanFeedbackRequestedEvent.request_id`` (crewai 1.12.2+) is the stable,
# non-synthesizable id the bridge maps onto ``AGUIInterrupt.id``. Probe for the
# field rather than the version; below it there is no stable id and HITL is not
# advertised.
_human_feedback_request_id_supported = (
    HumanFeedbackRequestedEvent is not None
    and _model_has_field(HumanFeedbackRequestedEvent, "request_id")
)

# Two levels, so a pause that surfaces as an interrupt is never stranded by a
# too-strict resume gate:
#
# * ``_human_feedback_resume_available`` gates the pause / resume LIFECYCLE. It
#   needs the pause signal, the resume classmethod + coroutine, and the
#   StreamFrame transport (async HITL >=1.8 always ships alongside StreamFrame
#   >=1.6, and the bridge only drives the lifecycle on the frame path). It does
#   NOT require a stable request id: the interrupt id falls back to the flow id
#   (== thread_id), which resume keys by, so 1.8-1.12.1 pauses still resume.
# * ``_human_feedback_available`` is the ADVERTISED capability (stable interrupt
#   ids). It adds the request-event class and its ``request_id`` field (1.12.2+).
#   Below that, the lifecycle still works with flow-id ids and a warning.
_human_feedback_resume_available = (
    HumanFeedbackPending is not None
    and FlowPausedEvent is not None
    and _flow_from_pending_supported
    and _flow_resume_async_supported
    and _stream_frame_available
)
_human_feedback_available = (
    _human_feedback_resume_available
    and HumanFeedbackRequestedEvent is not None
    and _human_feedback_request_id_supported
)

# Named enabling versions for warning text only (never a code-path gate).
HITL_ENABLING_VERSIONS: dict[str, str] = {
    "human_feedback": "1.8.0",
    "request_id": "1.12.2",
    "stream_frame": "1.6.0",
}


def flow_supports_human_feedback(flow: Any) -> bool:
    """Return True when THIS flow can pause / resume via async human feedback.

    Mirrors ``flow_supports_stream_frames`` / ``flow_supports_checkpointing``:
    the installed crewai must expose the async-HITL API (probed above) AND this
    specific flow must expose the resume coroutine and the frame transport, so
    the ``kickoff_async``-only test doubles in ``tests/test_task_cancellation.py``
    stay off the HITL path.
    """
    if not _human_feedback_resume_available:
        return False
    return callable(getattr(flow, "resume_async", None)) and hasattr(flow, "astream")


# --------------------------------------------------------------------------
# crewai-files multimodal input resolution
# --------------------------------------------------------------------------
# crewai's ``input_files=`` (1.9.0+) is inert without the separate
# ``crewai-files`` distribution (the ``crewai[file-processing]`` extra). Probe
# the distribution, not ``crewai.__version__``; ``find_spec`` is side-effect free.
try:
    _crewai_files_available = importlib.util.find_spec("crewai_files") is not None
except (ImportError, ValueError):  # pragma: no cover - defensive
    _crewai_files_available = False

# One-shot dedup guard for the lazy multimodal warning (reset in tests).
_multimodal_files_gap_warned = False


def warn_multimodal_files_gap() -> None:
    """Warn once when non-image media arrives without the crewai-files extra.

    Images ride ``image_url`` and work on any vision provider, so this is not
    fired for them. Audio/video/document are forwarded as ``image_url`` too,
    which many providers reject; native support needs the extra.
    """
    global _multimodal_files_gap_warned
    if CAPABILITIES.crewai_files_available or _multimodal_files_gap_warned:
        return
    _multimodal_files_gap_warned = True
    _LOGGER.warning(
        "ag-ui-crewai received non-image media (audio/video/document) but the "
        "optional 'crewai-files' distribution is not installed (crewai %s). It "
        "is forwarded to the chat LLM as an image_url block, which many "
        "providers reject; native support needs crewai>=1.9 with the "
        "'crewai[file-processing]' extra.",
        CAPABILITIES.crewai_version,
    )
# Memory-isolation resolution
# --------------------------------------------------------------------------
# crewai 1.x replaced the 0.x short-term / entity / long-term stores with ONE
# ``Memory`` object over ONE store, namespaced by a ``root_scope`` string that
# ``Crew.create_crew_memory`` derives from the CREW NAME. Nothing in that path
# derives from the AG-UI ``threadId``, so two chats served by the same endpoint
# read and write the same namespace.
#
# The isolation primitive is ``Memory.scope(path)``, which returns a
# ``MemoryScope`` view whose reads and writes are confined to ``path`` and
# below. ``Crew._memory`` is typed ``Memory | MemoryScope | MemorySlice``, so a
# view is a first-class thing to hand a crew, not a hack.
#
# Resolved (never version-gated) so a build without the unified memory API
# degrades to "no isolation, one warning" rather than crashing. The warning is
# emitted at the CALL SITE (``_memory``) rather than from ``warn_on_gaps``: an
# operator who never sets ``memory=True`` has no gap to hear about, and an
# import-time warning for them would be pure noise.
_MEMORY_MODULE, _MEMORY_MODULE_NAME = _first_module(["crewai.memory.unified_memory"])
Memory = getattr(_MEMORY_MODULE, "Memory", None) if _MEMORY_MODULE is not None else None

# crewai's own scope-name sanitizer (``crewai.memory.utils``). Used so a
# bridge-built scope segment is normalised exactly the way crewai normalises the
# crew-name segment sitting above it. ``_memory`` carries an equivalent fallback
# for builds that do not expose it.
_MEMORY_UTILS_MODULE, _ = _first_module(["crewai.memory.utils"])
sanitize_scope_name = (
    getattr(_MEMORY_UTILS_MODULE, "sanitize_scope_name", None)
    if _MEMORY_UTILS_MODULE is not None
    else None
)

# Both are required: the type (to recognise a crew's memory) and the view
# factory (to derive a per-thread namespace from it).
_memory_scope_available = Memory is not None and callable(
    getattr(Memory, "scope", None)
)


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
    # Reasoning: available whenever ANY channel is live (litellm delta, the
    # native thinking event, or the Responses API), never gated to a single
    # provider. Surfaced for the protocol capability table.
    reasoning_available: bool = False
    native_reasoning_event_available: bool = False
    # ``responses_api_available`` is the CHANNEL's availability: whether litellm
    # exposes the ``aresponses`` entrypoint that opens the stream.
    responses_api_available: bool = False
    stream_frame_available: bool = False
    # Checkpointing: informational; the wiring keys off the resolved
    # symbols / ``flow_supports_checkpointing`` per-flow probe, not these fields.
    checkpoint_config_available: bool = False
    checkpointing_available: bool = False
    flow_from_checkpoint_supported: bool = False
    flow_restore_from_state_id_supported: bool = False
    checkpoint_fork_supported: bool = False
    checkpoint_events_available: bool = False
    checkpoint_state_module: str | None = None
    # Async human-feedback (HITL): informational; the wiring keys off the
    # resolved symbols / ``flow_supports_human_feedback`` per-flow probe.
    flow_events_module: str | None = None
    human_feedback_available: bool = False
    human_feedback_resume_available: bool = False
    human_feedback_request_id_supported: bool = False
    crewai_files_available: bool = False
    # Per-thread memory isolation: informational. ``_memory`` keys off the
    # resolved symbols and warns once at the call site, so this is NOT listed in
    # ``missing`` (which drives import-time warnings that would fire for every
    # operator, including the majority who never enable crew memory).
    memory_scope_available: bool = False
    memory_module: str | None = None
    missing: tuple[str, ...] = field(default_factory=tuple)

    def warn_on_gaps(self) -> None:
        """Emit one message per missing capability, naming the fix.

        WARNING for a real gap; INFO for the StreamFrame transport, whose absence
        only downgrades the bridge to the legacy path (see the last branch).

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
        if self.litellm_available and not self.responses_api_available:
            # NOT a hard gap: reasoning still surfaces on the chat-completions
            # channel for every provider that carries it there, and the flow
            # examples degrade on ``responses_channel_available()``. Named at INFO
            # so an operator who wanted an OpenAI trace learns why it is absent.
            _LOGGER.info(
                "ag-ui-crewai: the installed litellm exposes no 'aresponses' "
                "entrypoint, so the OpenAI Responses channel reports unavailable "
                "and callers stay on chat-completions (which carries no OpenAI "
                "reasoning summaries). Install a litellm inside this package's "
                "declared range.",
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
        if not self.human_feedback_resume_available:
            # NOT a hard gap; chat / tool-based HITL is unaffected. Emit an
            # INFO note so operators know async interrupt (pause / resume) needs
            # the async-HITL API + the StreamFrame transport.
            _LOGGER.info(
                "ag-ui-crewai: crewai %s does not expose the async human-feedback "
                "interrupt API the bridge needs (async @human_feedback pause, "
                "Flow.from_pending/resume_async, StreamFrame); interrupt/resume "
                "is disabled. Upgrade to crewai>=%s for AG-UI interrupts.",
                self.crewai_version,
                HITL_ENABLING_VERSIONS["human_feedback"],
            )
        elif not self.human_feedback_request_id_supported:
            # Lifecycle works, but without a stable per-request id the interrupt
            # id falls back to the flow id (== thread_id). Fine for one pending
            # per thread; upgrade for a stable id across multiple pauses.
            _LOGGER.info(
                "ag-ui-crewai: crewai %s supports async human-feedback but not "
                "HumanFeedbackRequestedEvent.request_id; interrupt ids fall back "
                "to the flow id. Upgrade to crewai>=%s for stable request ids.",
                self.crewai_version,
                HITL_ENABLING_VERSIONS["request_id"],
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
        # Recomputed from the live probes (not the import-time constant) so the
        # snapshot always reflects every channel that actually resolved.
        reasoning_available=any_reasoning_channel(
            litellm_available=_litellm_available,
            thinking_event_available=_thinking_event_available,
            responses_api_available=_responses_api_available,
        ),
        native_reasoning_event_available=_thinking_event_available,
        responses_api_available=_responses_api_available,
        stream_frame_available=_stream_frame_available,
        checkpoint_config_available=_checkpoint_config_available,
        checkpointing_available=_checkpointing_available,
        flow_from_checkpoint_supported=_flow_from_checkpoint_supported,
        flow_restore_from_state_id_supported=_flow_restore_from_state_id_supported,
        checkpoint_fork_supported=_checkpoint_fork_supported,
        checkpoint_events_available=_checkpoint_events_available,
        checkpoint_state_module=_CKPT_STATE_MODULE_NAME,
        flow_events_module=_FLOW_EVENTS_MODULE_NAME,
        human_feedback_available=_human_feedback_available,
        human_feedback_resume_available=_human_feedback_resume_available,
        human_feedback_request_id_supported=_human_feedback_request_id_supported,
        crewai_files_available=_crewai_files_available,
        memory_scope_available=_memory_scope_available,
        memory_module=_MEMORY_MODULE_NAME,
        missing=tuple(missing),
    )
    caps.warn_on_gaps()
    return caps


# Run the probe ONCE at import time and cache the result.
CAPABILITIES = _detect()


# --------------------------------------------------------------------------
# Native-Gemini resolution (informational reasoning fields)
# --------------------------------------------------------------------------
# The thinking-chunk event class + its single availability flag are resolved ONCE
# above (before ``_detect``). Reasoning is now surfaced provider-agnostically via
# the litellm channel and the native event, so ``get_capabilities`` no longer gates
# reasoning on a native-Gemini LLM. The resolver below stays only to populate
# the informational ``nativeGeminiProvider`` / ``resolvedProvider`` fields: the
# native ``LLMThinkingChunkEvent`` (verified on the 1.15.7 wheel, emitted only by
# ``crewai/llms/providers/gemini/completion.py``) is an EXTRA frame-path source,
# not a requirement.

# crewai's canonical name for the native Google Gen AI provider. ``LLM.__new__``
# maps both the ``gemini/`` and ``google/`` model prefixes onto it and stamps it
# on the constructed instance as ``.provider``.
# crewai stamps EITHER name on a native Google Gen AI completion: ``gemini/...``
# resolves to "gemini" and ``google/...`` keeps "google" (verified on 1.15.7 - a
# ``provider="google"`` LLM is a real GeminiCompletion), so both must count.
_NATIVE_GEMINI_PROVIDERS = frozenset({"gemini", "google"})


# Depth cap for ``_resolve_llm``: an object graph with a cycle (an Agent whose
# ``.llm`` points back at itself, or a wrapper pair that references each other)
# would otherwise recurse until RecursionError inside a capability QUERY.

_LLM_RESOLVE_MAX_DEPTH = 8


def _resolve_llm(
    candidate: Any, _depth: int = 0, _path: frozenset[int] = frozenset()
) -> Any:
    """Best-effort unwrap of an object into the crewai LLM instance it holds.

    Accepts an LLM directly, or anything carrying one on a conventional attribute:
    an Agent's ``.llm``, a Crew's ``.agents[*].llm`` / ``.chat_llm`` /
    ``.manager_llm``, a Flow / ``ChatWithCrewFlow`` holding either. Returns ``None``
    when no LLM can be found - the caller reports "not resolvable" rather than
    guessing. Read-only: a callable (a ``@CrewBase`` ``crew`` factory) is never
    invoked, and a property that raises is treated as absent.

    A native-Gemini LLM WINS over any other candidate, because reasoning support is
    the one capability that turns on it. The search is otherwise first-match.

    Cycle safety tracks the ancestor PATH, not a shared visited set: a shared set is
    never unwound, so a node reached down a dead-end branch would stay poisoned for
    every other branch.
    """
    if candidate is None or _depth > _LLM_RESOLVE_MAX_DEPTH:
        return None
    marker = id(candidate)
    if marker in _path:
        return None
    _path = _path | {marker}

    if callable(candidate) and not _safe_hasattr(candidate, "provider"):
        # A ``@CrewBase``'s ``crew`` is a factory method; calling it would execute
        # user code inside a capability query.
        return None
    # A crewai 1.x LLM declares ``provider`` (native classes and the LiteLLM
    # fallback alike), so that is the strongest "this IS the LLM" signal. Older 0.x
    # LLMs may not, which is why the ``model`` fallback below still exists.
    if _safe_hasattr(candidate, "provider"):
        return candidate

    # Otherwise unwrap before falling back to the weaker ``model`` signal: an
    # Agent / Crew / Flow can itself carry a ``model`` attribute, and returning the
    # wrapper would report "not native Gemini" for an LLM we never looked at.
    fallback = None
    agents = _safe_getattr(candidate, "agents")
    candidates: list[Any] = []
    if isinstance(agents, (list, tuple)):
        # ``agents`` first: a Crew keeps its LLMs there, and ``chat_llm`` /
        # ``manager_llm`` are None on a plain Crew.
        candidates.extend(agents)
    for attr in ("llm", "chat_llm", "manager_llm", "crew"):
        nested = _safe_getattr(candidate, attr)
        if nested is not None and nested is not candidate:
            candidates.append(nested)
    for nested in candidates:
        resolved = _resolve_llm(nested, _depth + 1, _path)
        if resolved is None:
            continue
        if _is_native_gemini(resolved):
            # Search EVERY branch for a native-Gemini LLM before settling: an
            # earlier revision returned the first agent's LLM without ever looking
            # at chat_llm / manager_llm.
            return resolved
        if fallback is None:
            fallback = resolved
    if fallback is not None:
        return fallback

    if _safe_hasattr(candidate, "model") and not any(
        _safe_hasattr(candidate, attr)
        for attr in ("agents", "llm", "chat_llm", "manager_llm", "crew")
    ):
        # ``model`` alone is the crewai 0.x LLM signal, but an Agent / Crew / Flow can
        # carry one too; returning such a wrapper would report
        # ``provider_not_native_gemini`` for something that is not an LLM.
        return candidate
    return None


def _is_native_gemini(llm: Any) -> bool:
    """Whether ``llm`` is crewai's NATIVE Google Gen AI completion instance.

    Two structural probes, no version gate and no module-name string match:

    * ``provider == "gemini"`` - stamped by ``LLM.__new__`` only when it routes
      to a native provider class.
    * ``hasattr(llm, "thinking_config")`` - a field declared ONLY on
      ``crewai.llms.providers.gemini.completion.GeminiCompletion`` (verified by
      grep across ``crewai/llms/providers/`` on the 1.15.7 wheel). The LiteLLM
      fallback ``LLM`` and every other native provider lack it.

    Both are needed: a LiteLLM-routed ``gemini/<unlisted-model>`` can still carry
    a gemini-ish provider string but has no thinking plumbing, and a future
    provider could grow a ``thinking_config`` without being Gemini.
    """
    if llm is None:
        return False
    provider = _safe_getattr(llm, "provider")
    if (
        not isinstance(provider, str)
        or provider.strip().casefold() not in _NATIVE_GEMINI_PROVIDERS
    ):
        return False
    return _safe_hasattr(llm, "thinking_config")


def _reasoning_capability(llm: Any = None) -> dict:
    """Build the ``reasoning`` block of the capability declaration.

    Reasoning surfaces as first-class ``REASONING_*`` events, provider-agnostic,
    over three channels. Transport reality differs PER CHANNEL:

    * litellm chat-completions delta (``copilotkit_stream`` reads
      ``reasoning_content`` / ``thinking_blocks`` for any reasoning-capable model:
      deepseek-reasoner, Anthropic extended thinking, Bedrock, xAI,
      gemini-via-litellm, ...) and the OpenAI Responses API
      (``copilotkit_responses``, the ONLY place OpenAI's reasoning models expose
      their reasoning summaries): both emit Bridged reasoning events on the event
      bus, which BOTH transports handle -- the StreamFrame path and the legacy
      bus-listener path.
    * crewai's native Gemini ``LLMThinkingChunkEvent``: StreamFrame-ONLY. The
      only thing that turns it into ``REASONING_*`` is the frame-path scoped sink
      gate plus the frame translator; the legacy bus-listener path has no handler
      for it.

    No channel needs ``emit_raw_events``: reasoning is a mapped channel, never RAW
    passthrough.

    ``supported`` describes the bridge capability, not whether a given model will
    actually reason: a non-reasoning model simply emits nothing (graceful
    no-op). It is True whenever ANY channel is live -- the litellm channel is
    effectively always live (a direct dep).

    Every channel field is read from the ONE frozen ``CAPABILITIES`` snapshot, and
    ``supported`` / ``reason`` are DERIVED from the three fields the block itself
    publishes, so the block cannot advertise a channel it also reports absent (or
    claim support with every channel dark).
    ``nativeGeminiProvider`` / ``resolvedProvider`` are informational: the native
    event is an EXTRA source, not a requirement.
    """
    resolved = _resolve_llm(llm)
    # Provider-agnostic path, on both transports (always live when litellm is
    # installed, which it is as a direct dependency).
    litellm_channel = CAPABILITIES.litellm_available
    # crewai's native Gemini thinking event: an extra, StreamFrame-only source.
    thinking_event = CAPABILITIES.native_reasoning_event_available
    # OpenAI Responses API: the only channel that carries OpenAI reasoning
    # summaries. Capability-probed, not version- or model-name-gated.
    responses_channel = CAPABILITIES.responses_api_available
    supported = any_reasoning_channel(
        litellm_available=litellm_channel,
        thinking_event_available=thinking_event,
        responses_api_available=responses_channel,
    )
    return {
        "supported": supported,
        "litellmChannel": litellm_channel,
        "thinkingEventAvailable": thinking_event,
        "responsesApiChannel": responses_channel,
        "nativeGeminiProvider": _is_native_gemini(resolved),
        # A caller object: a raising property here would escape the whole query.
        "resolvedProvider": _safe_getattr(resolved, "provider"),
        # First-class REASONING_* mapping: reasoning does NOT ride RAW passthrough.
        "requiresEmitRawEvents": False,
        "reason": None if supported else NO_REASONING_CHANNEL,
    }


def get_capabilities(
    *,
    llm: Any = None,
    emission_shape: str | None = None,
    emit_raw_events: bool | None = None,
) -> dict:
    """Return the CrewAI bridge's capability declaration.

    Mirrors the shape of ``ag_ui_langgraph.LangGraphAgent.get_capabilities``
    (``identity`` / ``humanInTheLoop`` / ``state`` / ``transport``) and adds the
    CrewAI-specific blocks the parity lane needs: the resolved wire shape, RAW
    passthrough, reasoning, and Conversational Flow transport.

    No field is derived from ``crewai.__version__`` - the version string appears
    only as informational ``crewaiVersion`` metadata (same rule as the rest of this
    module). Within that, ``transport`` / ``rawEvents`` / ``reasoning`` /
    ``conversationalFlows`` / ``crewChat`` come from runtime probes, while
    ``humanInTheLoop`` and ``state`` are static declarations of what the bridge
    implements today.

    ``emission_shape`` / ``emit_raw_events`` default to re-reading the environment,
    so a declaration fetched without arguments can disagree with an endpoint that
    was registered with explicit ones. Pass the same values the endpoint was
    registered with to describe THAT endpoint.

    Raises
    ------
    ValueError
        If ``emission_shape`` names an unknown shape, or ``emit_raw_events`` is not
        a bool. Both are caller mistakes rather than environment conditions.

    Parameters
    ----------
    llm:
        The LLM, or an object carrying one: an Agent (``.llm``), a Crew
        (``.agents[*].llm``, or ``chat_llm`` / ``manager_llm`` when set), or a Flow
        holding either. Resolution is read-only and never calls a factory.
        Optional for ``reasoning``: reasoning is now provider-agnostic (the
        litellm channel), so it is reported supported regardless of the LLM. An
        LLM only enriches the informational ``nativeGeminiProvider`` /
        ``resolvedProvider`` fields.
    emission_shape / emit_raw_events:
        The values the endpoint was configured with. Defaults (``None``) resolve
        the same way the endpoint factories resolve them, so a caller that
        configured nothing sees what the endpoint will actually emit.
    """
    # ``_config`` is a leaf (``_env`` + stdlib only), imported locally purely to
    # keep this module's "crewai / litellm / stdlib only" property for every path
    # that never calls ``get_capabilities``.
    from ._config import (
        DEFAULT_EMIT_RAW_EVENTS,
        resolve_emission_shape,
        resolve_emit_raw_events,
    )

    resolved_raw = resolve_emit_raw_events(emit_raw_events)
    resolved_shape = resolve_emission_shape(emission_shape)
    text_events = (
        [EventType.TEXT_MESSAGE_CHUNK.value]
        if resolved_shape == "chunks"
        else [
            EventType.TEXT_MESSAGE_START.value,
            EventType.TEXT_MESSAGE_CONTENT.value,
            EventType.TEXT_MESSAGE_END.value,
        ]
    )
    tool_events = (
        [EventType.TOOL_CALL_CHUNK.value]
        if resolved_shape == "chunks"
        else [
            EventType.TOOL_CALL_START.value,
            EventType.TOOL_CALL_ARGS.value,
            EventType.TOOL_CALL_END.value,
        ]
    )
    return {
        "identity": {"type": "crewai", "crewaiVersion": CAPABILITIES.crewai_version},
        "humanInTheLoop": {
            # True because the shipped ``human_in_the_loop`` example round-trips a
            # frontend tool call. What is missing is the interrupt mechanism
            # (crewai's ``@human_feedback`` / flow-level pause), below.
            "supported": True,
            "mechanism": "frontend-tool-calls",
            "interrupts": False,
            "approveWithEdits": False,
        },
        "state": {
            # STATE_SNAPSHOT on every method finish plus progressive snapshots via
            # ``copilotkit_emit_state``; no JSON-Patch deltas, and no server-side
            # persistence across runs.
            "snapshots": True,
            "deltas": False,
            "persistentState": False,
        },
        "transport": {
            "streaming": True,
            # crewai >= 1.6 ordered StreamFrame envelopes, else the legacy
            # event-bus-listener fallback.
            "streamFrames": CAPABILITIES.stream_frame_available,
        },
        "wireShape": {
            # START/CONTENT/END triples by default; "chunks" is a compatibility
            # opt-out. MCP tool executions always use triples (name, args and result
            # arrive together, not streamed), independent of this setting.
            "emissionShape": resolved_shape,
            "textMessages": text_events,
            "toolCalls": tool_events,
            "mcpToolCalls": [
                EventType.TOOL_CALL_START.value,
                EventType.TOOL_CALL_ARGS.value,
                EventType.TOOL_CALL_END.value,
                EventType.TOOL_CALL_RESULT.value,
            ],
        },
        "rawEvents": {
            # RAW needs the StreamFrame transport's scoped sink. This is the
            # process-level probe; the driver also probes each flow for ``astream``,
            # so a flow without it takes the legacy path and emits no RAW.
            "supported": CAPABILITIES.stream_frame_available,
            "enabled": bool(resolved_raw and CAPABILITIES.stream_frame_available),
            "default": DEFAULT_EMIT_RAW_EVENTS,
        },
        "reasoning": _reasoning_capability(llm),
        "conversationalFlows": {
            "supported": _conversational_stream_available,
            "entrypoint": "stream_turn",
            "sessionId": "threadId",
        },
        "crewChat": {"supported": CAPABILITIES.crew_chat_available},
    }
