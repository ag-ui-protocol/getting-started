"""MCP (Model Context Protocol) event bridging for ag_ui_crewai.

CrewAI gained first-class MCP support in 1.4.0: ``Agent(mcps=[...])`` accepting
config objects, ``crewai.mcp.MCPServer{Stdio,HTTP,SSE}``, and a family of
``MCP*Event`` types emitted on the crewai event bus. This module is the single
translation seam that maps those crewai events onto AG-UI protocol events:

* MCP *tool executions* -> ``TOOL_CALL_*`` events, so an MCP tool call renders
  in the UI like any other tool call. A discrete execution is surfaced
  atomically on completion/failure as ``TOOL_CALL_START`` -> ``TOOL_CALL_ARGS``
  -> ``TOOL_CALL_END`` -> ``TOOL_CALL_RESULT`` (see ``_tool_call_events`` for why
  atomic-at-completion, not start/end correlation). A FAILED execution ALSO
  emits a ``CUSTOM`` ``mcp_tool_execution_failed`` event so a client can tell a
  failure apart from a success (the result content alone cannot be trusted to).
* MCP *lifecycle* events (server connect started/completed/failed, config-fetch
  failure, and the tool-execution "started" signal) -> ``CUSTOM`` events, which
  the UI can surface as activity without confusing them with real tool calls.

The translator is stateless (dispatches on ``event.type`` and reads fields via
``getattr``; it mints fresh ids per call, so it is not pure), and is shared
verbatim by BOTH bridge transports:
the StreamFrame frame-translator (``_frames.StreamFrameTranslator``, crewai
>= 1.6) and the legacy event-bus listener (``endpoint.setup_listeners``, crewai
1.4-1.5). Statelessness also keeps it free of any per-run correlation map that
could leak across runs or races on the process-wide listener, which protects
cancellation/teardown.

Capability detection is runtime-only: ``crewai_mcp_available`` probes
``crewai.mcp.MCPServerStdio`` -- the clean 1.4.0 signal -- rather than
version-gating on a version string. ``Agent.mcps`` is deliberately NOT probed:
it exists from crewai 1.0.0 as ``list[str]`` and cannot distinguish 1.0 from
1.4. Below 1.4 the probe fails, ``register_mcp_listeners`` logs one warning and
is a clean no-op.

Wire-shape note: the granular ``TOOL_CALL_START``/``ARGS``/``END``/``RESULT``
shape is the protocol-canonical representation of a discrete (non-streaming)
tool call and matches the START/CONTENT/END triples the six non-crewai
integrations emit. The StreamFrame translator defaults streaming text /
LLM-tool-call emission to ``chunks``; MCP executions are discrete (name + full
args + result arrive together), so triples are the natural fit here regardless
of how the chunks-vs-triples decision lands for streaming LLM tool calls.
"""

import json
import logging
import uuid
from typing import Any, Callable, List

from ag_ui.core import EventType
from ag_ui.core.events import (
    BaseEvent,
    CustomEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)

from ._capabilities import CAPABILITIES

_LOGGER = logging.getLogger(__name__)

# crewai MCP event ``type`` discriminators. These are the stable ``Literal``
# values on the crewai ``MCP*Event`` classes (crewai/events/types/mcp_events.py).
# Dispatching on the string keeps ``translate_mcp_event`` decoupled from
# importing crewai, so the translation logic is unit-testable without crewai
# (let alone crewai>=1.4) installed.
MCP_CONNECTION_STARTED = "mcp_connection_started"
MCP_CONNECTION_COMPLETED = "mcp_connection_completed"
MCP_CONNECTION_FAILED = "mcp_connection_failed"
MCP_TOOL_EXECUTION_STARTED = "mcp_tool_execution_started"
MCP_TOOL_EXECUTION_COMPLETED = "mcp_tool_execution_completed"
MCP_TOOL_EXECUTION_FAILED = "mcp_tool_execution_failed"
MCP_CONFIG_FETCH_FAILED = "mcp_config_fetch_failed"

# The full set, used by ``is_mcp_event`` to widen the StreamFrame sink's
# source gate (MCP events are emitted with the agent/crew as ``source``, not the
# Flow, so the sink must park them by TYPE rather than by source identity).
MCP_EVENT_TYPES = frozenset(
    {
        MCP_CONNECTION_STARTED,
        MCP_CONNECTION_COMPLETED,
        MCP_CONNECTION_FAILED,
        MCP_TOOL_EXECUTION_STARTED,
        MCP_TOOL_EXECUTION_COMPLETED,
        MCP_TOOL_EXECUTION_FAILED,
        MCP_CONFIG_FETCH_FAILED,
    }
)

# The 7 crewai MCP event class names, re-homed at ``crewai.events`` in 1.x. Held
# as strings so listener registration can resolve them lazily (only on crewai
# >= 1.4, gated by the probe).
_MCP_EVENT_CLASS_NAMES = (
    "MCPConnectionStartedEvent",
    "MCPConnectionCompletedEvent",
    "MCPConnectionFailedEvent",
    "MCPToolExecutionStartedEvent",
    "MCPToolExecutionCompletedEvent",
    "MCPToolExecutionFailedEvent",
    "MCPConfigFetchFailedEvent",
)

# Warn-once dedup, keyed by message (mirrors the spirit of the endpoint's other
# one-shot warnings). A long-running server that registers many endpoints emits
# each distinct MCP warning at most once.
_WARNED: set = set()


def is_mcp_event(event: Any) -> bool:
    """Return True when ``event`` is a crewai MCP event we translate."""
    return getattr(event, "type", None) in MCP_EVENT_TYPES


# Max container nesting ``_json_safe`` descends before flattening the rest to a
# placeholder. Well above any realistic MCP payload, well below CPython's
# recursion limit, so pathologically deep input degrades instead of raising.
_JSON_SAFE_MAX_DEPTH = 64


def _json_safe(value: Any, _ancestors: frozenset = frozenset(), _depth: int = 0) -> Any:
    """Coerce an arbitrary value into a bounded, JSON-native Python structure.

    This is the single serialization-hardening primitive for the whole module:
    ``_args_delta`` / ``_result_content`` / ``_custom`` all route through it, so
    the "cannot raise" contract is guaranteed in ONE place rather than by
    scattered ``try/except`` guards. The output contains only ``dict`` / ``list``
    / ``str`` / ``int`` / ``float`` / ``bool`` / ``None``, so a subsequent
    ``json.dumps`` (or ``encoder.encode``) on it can neither hit a non-JSON type
    NOR recurse unboundedly.

    Three guards make it total:

    * A non-primitive, non-container leaf (an ``Exception``, a ``datetime``) is
      ``str``-coerced -- shallow, so it cannot itself recurse.
    * ``_ancestors`` tracks the ids of containers on the CURRENT path, so a
      circular reference becomes ``"<circular>"``. A shared (non-cyclic)
      reference is NOT flagged (the path set is copied per descent).
    * ``_depth`` bounds nesting at ``_JSON_SAFE_MAX_DEPTH``; past it a container
      becomes the CONSTANT ``"<max-depth>"`` (never ``str(container)``, which
      would re-enter C-level recursion), so deep acyclic input cannot exhaust the
      stack.
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if id(value) in _ancestors:
        return "<circular>"
    if _depth >= _JSON_SAFE_MAX_DEPTH:
        return "<max-depth>"
    if isinstance(value, dict):
        nxt = _ancestors | {id(value)}
        return {str(k): _json_safe(v, nxt, _depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        nxt = _ancestors | {id(value)}
        return [_json_safe(v, nxt, _depth + 1) for v in value]
    return str(value)


def _text(value: Any) -> str:
    """Coerce a value to ``str`` for a required AG-UI string field.

    ``None`` -> ``""`` so an explicit ``tool_name=None`` (crewai types it ``str``,
    but a fork / bug could pass ``None``) never trips pydantic validation on the
    required ``ToolCallStartEvent.tool_call_name``.
    """
    return "" if value is None else str(value)


def _args_delta(tool_args: Any) -> str:
    """Serialise MCP tool args to the ``ToolCallArgsEvent.delta`` string.

    Only crewai's own ``None`` default (a tool invoked with no args) becomes
    ``"{}"``; a real falsy value is preserved (``{}`` stays ``{}``, ``0``/``""``
    are serialised verbatim). Routing through ``_json_safe`` first bounds depth
    and cycles, so ``json.dumps`` on the result cannot raise (contract upheld in
    one place).
    """
    return json.dumps(_json_safe({} if tool_args is None else tool_args))


def _result_content(value: Any) -> str:
    """Coerce an MCP tool result / error to ``ToolCallResultEvent.content``.

    ``content`` must be a ``str``. ``None`` (a tool that returned nothing)
    becomes ``""`` rather than the literal ``"null"``. Strings pass through
    verbatim; everything else is JSON-encoded via ``_json_safe`` (bounded,
    cannot raise).
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(_json_safe(value))


def _custom(name: str, value: Any) -> CustomEvent:
    return CustomEvent(type=EventType.CUSTOM, name=name, value=_json_safe(value))


def _lifecycle_value(event: Any, fields: tuple) -> dict:
    """Project the named attributes of ``event`` into a plain dict.

    Intentionally forgiving (``getattr`` with ``None`` default) so a minor
    crewai field rename does not crash the bridge -- a missing field surfaces as
    ``None`` in the CUSTOM payload instead.
    """
    return {field: getattr(event, field, None) for field in fields}


def _tool_call_events(
    name: str,
    args: Any,
    *,
    result: Any = None,
    error: Any = None,
    failed: bool = False,
) -> List[BaseEvent]:
    """Build the atomic ``TOOL_CALL_*`` sequence for one MCP tool execution.

    crewai's ``MCPToolExecution{Started,Completed,Failed}Event`` carry no tool
    call id, so a "started" event cannot be correlated to its matching
    "completed"/"failed" event without stateful bookkeeping keyed on
    (server, tool, args) -- fragile under repeated/concurrent calls and prone to
    leaking across runs on the process-wide listener. Instead the call is
    surfaced atomically at completion/failure, where crewai hands us the tool
    name, args, AND result/error together. A fresh ``tool_call_id`` ties the
    events together; the in-flight signal is carried separately by the
    ``mcp_tool_execution_started`` CUSTOM event.

    On failure (``failed=True``) the RESULT carries the error text; the caller
    (``translate_mcp_event``) appends a trailing ``mcp_tool_execution_failed``
    CUSTOM event so a client can distinguish a failure from a success (a RESULT
    alone cannot be trusted to signal failure). This builder returns only the
    four TOOL_CALL_* events.
    """
    tool_call_id = uuid.uuid4().hex
    events: List[BaseEvent] = [
        ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            tool_call_id=tool_call_id,
            tool_call_name=_text(name),
        ),
        ToolCallArgsEvent(
            type=EventType.TOOL_CALL_ARGS,
            tool_call_id=tool_call_id,
            delta=_args_delta(args),
        ),
        ToolCallEndEvent(
            type=EventType.TOOL_CALL_END,
            tool_call_id=tool_call_id,
        ),
        ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            message_id=uuid.uuid4().hex,
            tool_call_id=tool_call_id,
            content=_result_content(error if failed else result),
            role="tool",
        ),
    ]
    return events


def translate_mcp_event(event: Any) -> List[BaseEvent]:
    """Translate a single crewai MCP event into AG-UI events.

    Stateless (mints fresh ids per call, so not pure). Unknown / missing event
    types return ``[]`` (forward-compatible no-op).

    Top-level backstop for the "cannot raise" contract: the field-level guards
    (``_json_safe`` for payloads, ``_text`` for required string fields) cover the
    realistic inputs, and this ``try/except`` is the last line so that ANY
    unforeseen pathological event degrades to a dropped translation (``[]`` +
    one debug line) rather than faulting the run -- on the StreamFrame path an
    escaping exception becomes an ``AGUI_CREWAI_FLOW_ERROR`` for the whole run.
    A masked coding bug still shows up as an empty result in the unit tests,
    which assert exact event sequences.
    """
    try:
        return _translate_mcp_event_impl(event)
    except Exception as exc:  # noqa: BLE001 - last-resort "cannot raise" backstop
        _LOGGER.debug(
            "ag-ui-crewai: failed to translate MCP event %s (%s); dropping.",
            getattr(event, "type", None),
            type(exc).__name__,
        )
        return []


def _translate_mcp_event_impl(event: Any) -> List[BaseEvent]:
    etype = getattr(event, "type", None)

    if etype == MCP_TOOL_EXECUTION_COMPLETED:
        return _tool_call_events(
            getattr(event, "tool_name", ""),
            getattr(event, "tool_args", None),
            result=getattr(event, "result", None),
        )

    if etype == MCP_TOOL_EXECUTION_FAILED:
        events = _tool_call_events(
            getattr(event, "tool_name", ""),
            getattr(event, "tool_args", None),
            error=getattr(event, "error", None),
            failed=True,
        )
        events.append(
            _custom(
                MCP_TOOL_EXECUTION_FAILED,
                {
                    "server_name": getattr(event, "server_name", None),
                    "tool_name": getattr(event, "tool_name", None),
                    "error": getattr(event, "error", None),
                    "error_type": getattr(event, "error_type", None),
                },
            )
        )
        return events

    if etype == MCP_TOOL_EXECUTION_STARTED:
        return [
            _custom(
                MCP_TOOL_EXECUTION_STARTED,
                {
                    "server_name": getattr(event, "server_name", None),
                    "tool_name": getattr(event, "tool_name", None),
                    "tool_args": getattr(event, "tool_args", None),
                },
            )
        ]

    if etype == MCP_CONNECTION_STARTED:
        return [
            _custom(
                MCP_CONNECTION_STARTED,
                _lifecycle_value(
                    event,
                    ("server_name", "server_url", "transport_type", "is_reconnect"),
                ),
            )
        ]

    if etype == MCP_CONNECTION_COMPLETED:
        return [
            _custom(
                MCP_CONNECTION_COMPLETED,
                _lifecycle_value(
                    event,
                    (
                        "server_name",
                        "server_url",
                        "transport_type",
                        "connection_duration_ms",
                        "is_reconnect",
                    ),
                ),
            )
        ]

    if etype == MCP_CONNECTION_FAILED:
        return [
            _custom(
                MCP_CONNECTION_FAILED,
                _lifecycle_value(
                    event, ("server_name", "server_url", "error", "error_type")
                ),
            )
        ]

    if etype == MCP_CONFIG_FETCH_FAILED:
        return [
            _custom(
                MCP_CONFIG_FETCH_FAILED,
                _lifecycle_value(event, ("slug", "error", "error_type")),
            )
        ]

    return []


def crewai_mcp_available() -> bool:
    """Return True when crewai>=1.4 first-class MCP support is importable.

    Probes ``crewai.mcp.MCPServerStdio`` -- the clean 1.4.0 signal.
    Only ``ImportError`` (crewai < 1.4, module absent) is treated as
    "unavailable"; any OTHER exception is a real breakage and is allowed to
    propagate rather than being silently mislabelled as "too old".
    """
    try:
        from crewai.mcp import MCPServerStdio  # noqa: F401  pylint: disable=import-outside-toplevel,unused-import

        return True
    except ImportError:
        return False


def _warn_once(message: str, *args: Any) -> None:
    key = message % args if args else message
    if key in _WARNED:
        return
    _WARNED.add(key)
    _LOGGER.warning(message, *args)


def register_mcp_listeners(
    crewai_event_bus: Any,
    on_mcp_event: Callable[[Any], None],
) -> bool:
    """Register crewai MCP event listeners for the LEGACY bus transport.

    Used by the legacy event-bus transport (crewai 1.4-1.5, where the
    StreamFrame contract is absent). ``on_mcp_event`` is injected by ``endpoint``
    and receives the RAW crewai MCP event; the endpoint resolves the active run
    (MCP events are emitted with the agent/crew as ``source``, not the Flow, so
    it resolves via ``flow_context``), and translates + enqueues ONLY when that
    run has a live queue -- so on the StreamFrame path (no per-run queue; that
    path surfaces MCP via the frame sink) this handler does no wasted
    translation. Passing the raw event (rather than pre-translating here) keeps
    this module free of any import-time crewai / endpoint dependency and lets the
    endpoint skip translation entirely when there is nothing to enqueue.

    Returns True if listeners were registered (crewai>=1.4 MCP present); False
    otherwise. On older crewai a single process-wide warning is logged and the
    call is a clean no-op.
    """
    if not crewai_mcp_available():
        _warn_once(
            "ag-ui-crewai: MCP tool-call surfacing requires crewai>=1.4.0 "
            "(crewai.mcp); installed crewai version is %s. MCP events will not "
            "be surfaced as TOOL_CALL_*/CUSTOM events.",
            CAPABILITIES.crewai_version,
        )
        return False

    try:
        import importlib  # pylint: disable=import-outside-toplevel

        _events = importlib.import_module("crewai.events")
        event_types = [getattr(_events, name, None) for name in _MCP_EVENT_CLASS_NAMES]
        if any(t is None for t in event_types):
            raise ImportError("one or more MCP event classes are missing")
    except ImportError:  # MCP present but the event surface moved/renamed
        _warn_once(
            "ag-ui-crewai: crewai.mcp is present but the MCP event classes could "
            "not be resolved from crewai.events; MCP events will not be surfaced."
        )
        return False

    def _handler(source: Any, event: Any) -> None:  # pylint: disable=unused-argument
        on_mcp_event(event)

    for event_type in event_types:
        crewai_event_bus.on(event_type)(_handler)

    return True
