"""AWS Strands Agent adapter for AG-UI.

Translates Strands streaming events into the AG-UI event protocol.
"""

import asyncio
import base64
import hashlib
import inspect
import json
import logging
import uuid
from datetime import datetime, timezone
from importlib.metadata import version as distribution_version
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from strands import Agent as StrandsAgentCore
from strands.session import SessionManager
from strands.types.interrupt import InterruptResponseContent

# Params handled explicitly by StrandsAgent — excluded from auto-forwarding.
# "messages" is excluded: per-thread agents start with no history;
# AG-UI injects messages at runtime via RunAgentInput.
# "hooks" is excluded: Agent stores hooks as a HookRegistry after init, not
# the original list the constructor expects — forwarding it causes a TypeError.
# "session_manager" is excluded: it is supplied per-thread via
# StrandsAgentConfig.session_manager_provider (see run()). Forwarding a
# template-level session_manager would make every thread share one session_id.
_AGUI_EXPLICIT_PARAMS = {
    "self",
    "model",
    "system_prompt",
    "tools",
    "messages",
    "hooks",
    "session_manager",
}


def _extract_agent_kwargs(agent: StrandsAgentCore) -> dict:
    """Build kwargs for StrandsAgentCore by introspecting its constructor signature.

    Tries ``self.<name>`` first, falls back to ``self._<name>`` — Strands stores
    some init params with an underscore prefix (e.g. ``retry_strategy`` lives at
    ``self._retry_strategy``). This keeps the adapter forward-compatible with
    any future param that follows either naming convention.
    """
    kwargs = {}
    for name in inspect.signature(StrandsAgentCore.__init__).parameters:
        if name in _AGUI_EXPLICIT_PARAMS:
            continue
        if hasattr(agent, name):
            value = getattr(agent, name)
        elif hasattr(agent, f"_{name}"):
            value = getattr(agent, f"_{name}")
        else:
            continue
        if value is None:
            continue
        # state is an AgentState container; extract the underlying plain dict
        if name == "state" and hasattr(value, "get"):
            value = value.get()
        kwargs[name] = value
    return kwargs


# Upper bound on the per-agent wire->native map held in session state. Bounds
# growth from frontend calls that never receive a client result (abandoned HITL)
# and so are never consumed/pruned. Generous — a thread rarely has this many
# outstanding frontend calls at once.
_WIRE_MAP_MAX = 512

# Upper bound on the per-agent tool-call metadata map held in session state.
# It bounds abandoned entries (tool calls whose result never returns)
# so state cannot grow without bound.
_TOOL_CALL_MAP_MAX = 512

# Sentinel handed back to a paused ``tool_context.interrupt()`` when the client
# cancels (``ResumeEntry.status == "cancelled"``) rather than resolving. The
# tool receives this in place of a real answer and can treat it as a denial.
INTERRUPT_CANCELLED = {"cancelled": True}

# Reserved native-interrupt name prefix for interrupts this adapter's approval
# hook raises. Anything else is a generic native interrupt.
_TOOL_APPROVAL_NAME_PREFIX = "ag_ui:tool_call:"


def _strands_uses_presence_based_interrupt_responses(installed_version: str) -> bool:
    """Return the interrupt-response contract of a Strands SDK version."""
    try:
        major, minor = map(int, installed_version.split(".", 2)[:2])
    except ValueError as exc:
        raise RuntimeError(
            "Cannot determine interrupt response semantics for "
            f"strands-agents version {installed_version!r}"
        ) from exc
    return (major, minor) >= (1, 19)


# Strands 1.15 through 1.18 returns a recorded response only when it is truthy.
# Version 1.19 changed that predicate to presence (``response is not None``).
_STRANDS_USES_PRESENCE_BASED_INTERRUPT_RESPONSES = (
    _strands_uses_presence_based_interrupt_responses(
        distribution_version("strands-agents")
    )
)


def _tool_approval_response_schema() -> dict:
    """The response contract advertised for a tool-approval interrupt.

    Single source for both the schema published on the AG-UI ``Interrupt`` and
    the resume-payload validation, so a resume can still be checked when the
    AG-UI bookkeeping did not survive a process restart.
    """
    return {
        "type": "object",
        "properties": {"approved": {"type": "boolean"}},
        "required": ["approved"],
    }


def _is_tool_approval_interrupt(native_interrupt: Any) -> bool:
    """True when a native Strands interrupt came from the approval hook."""
    name = getattr(native_interrupt, "name", None)
    return (
        isinstance(name, str)
        and name.startswith(_TOOL_APPROVAL_NAME_PREFIX)
        and isinstance(getattr(native_interrupt, "reason", None), dict)
    )


def _wrap_resume_response(status: str, payload: Any) -> dict:
    """Package a ``ResumeEntry`` for Strands' ``interruptResponse`` shape.

    Supported Strands releases read a recorded answer either by truthiness
    (1.15 through 1.18) or by presence (1.19+). Forwarding a raw falsy payload
    can therefore re-raise the same interrupt and re-run the tool body on the
    compatibility floor. Always hand Strands a truthy envelope; the tool
    implementation unwraps it via ``.get("cancelled")`` / ``.get("response")``.
    """
    if status == "cancelled":
        return dict(INTERRUPT_CANCELLED)
    return {"response": payload}


def _native_resume_response(entry: Any, native_interrupt: Any) -> Any:
    """Return the answer Strands records when this entry is forwarded.

    One definition, read both by the batch the run forwards and by the replay
    comparison below, so the two cannot disagree about what was submitted.
    """
    if _is_tool_approval_interrupt(native_interrupt):
        return {"approved": False} if entry.status == "cancelled" else entry.payload
    return _wrap_resume_response(entry.status, entry.payload)


def _replays_recorded_answers(interrupt_state: Any, resume_entries: Any) -> bool:
    """True when this batch re-submits exactly the answers the checkpoint holds.

    Strands records the submitted answers before it reruns hooks and the parked
    tool execution, and clears the checkpoint only once that work succeeds. So a
    hook failure, or a crash after session persistence, can restore a checkpoint
    that is activated with every interrupt already answered. That thread has no
    way forward: fresh input is refused because the checkpoint is active, and a
    resume finds nothing open to address. Handing Strands the identical batch is
    the way out, because it lets the SDK finish the parked execution. The
    checkpoint itself must be left alone: clearing it would discard exactly that
    parked execution. Anything short of an exact replay stays refused.
    """
    recorded = getattr(interrupt_state, "interrupts", {}) or {}
    if not recorded or len(resume_entries) != len(recorded):
        return False
    addressed: set[str] = set()
    for entry in resume_entries:
        interrupt_id = getattr(entry, "interrupt_id", None)
        native_interrupt = recorded.get(interrupt_id)
        if native_interrupt is None or interrupt_id in addressed:
            return False
        addressed.add(interrupt_id)
        if not _native_interrupt_is_answered(native_interrupt):
            return False
        if native_interrupt.response != _native_resume_response(
            entry, native_interrupt
        ):
            return False
    return True


def _get_strands_session_manager(agent: Any) -> Any:
    """Return the agent's Strands ``SessionManager``, or ``None``.

    Strands stores it publicly as ``session_manager``; some versions keep a
    private ``_session_manager`` alias.
    """
    return getattr(agent, "session_manager", None) or getattr(
        agent, "_session_manager", None
    )


def _strands_interrupt_to_agui(strands_interrupt: Any) -> "Interrupt":
    """Map a native Strands ``Interrupt`` onto an AG-UI ``Interrupt``.

    Interrupts raised by this adapter's approval hook use its reserved
    ``ag_ui:tool_call:`` name prefix and map to AG-UI tool-call approvals.
    All other native interrupts retain their generic name and reason payload.
    """
    s_id = getattr(strands_interrupt, "id", "")
    name = getattr(strands_interrupt, "name", None) or "interrupt"
    raw_reason = getattr(strands_interrupt, "reason", None)

    if _is_tool_approval_interrupt(strands_interrupt):
        tool_name = raw_reason.get("tool_name", "unknown")
        return Interrupt(
            id=s_id,
            reason="tool_call",
            message=f"Approve call to {tool_name}?",
            tool_call_id=raw_reason.get("tool_use_id"),
            response_schema=_tool_approval_response_schema(),
            metadata={
                "tool_name": tool_name,
                "tool_input": raw_reason.get("tool_input", {}),
            },
        )

    return Interrupt(
        id=s_id,
        reason=name,
        message=None,
        tool_call_id=None,
        response_schema=None,
        metadata={"reason": raw_reason} if raw_reason is not None else None,
    )


def _native_interrupt_is_answered(interrupt: Any) -> bool:
    """True when this interrupt already carries an answer Strands will hand back.

    Match the installed SDK's own ``ToolContext.interrupt`` predicate. Strands
    1.15 through 1.18 uses truthiness; 1.19 and later uses presence, with
    ``None`` as the unanswered default.
    """
    response = getattr(interrupt, "response", None)
    if _STRANDS_USES_PRESENCE_BASED_INTERRUPT_RESPONSES:
        return response is not None
    return bool(response)


def _open_native_interrupts(interrupts: Any) -> dict:
    """Return the entries of ``interrupts`` still awaiting a human, keyed by id.

    The native interrupt state is the only record of what is still in flight, and
    every "is anything still open?" decision reads it through this one predicate,
    so the pause this run reports and the resume the next one submits cannot
    disagree and strand a client between them.
    """
    return {
        interrupt_id: interrupt
        for interrupt_id, interrupt in (interrupts or {}).items()
        if not _native_interrupt_is_answered(interrupt)
    }


def _extract_interrupts(agent: Any, terminal_result: Any) -> list:
    """Return the native Strands interrupts for a paused run, or ``[]``.

    Prefers the terminal ``AgentResult`` (``stop_reason == "interrupt"`` with a
    populated ``interrupts``); falls back to the live agent's
    ``_interrupt_state`` so a pause is still detected if the result event was
    consumed by the stream's early-break path.
    """
    if terminal_result is not None:
        if getattr(terminal_result, "stop_reason", None) == "interrupt":
            interrupts = getattr(terminal_result, "interrupts", None) or []
            if interrupts:
                return list(interrupts)
    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is not None and getattr(interrupt_state, "activated", False):
        open_interrupts = _open_native_interrupts(
            getattr(interrupt_state, "interrupts", {})
        )
        if not open_interrupts:
            # The checkpoint is still activated yet every interrupt is answered
            # under the installed SDK's semantics, so this run reports success
            # while the agent may remain parked.
            logger.debug(
                "Native interrupt state is activated but every interrupt is "
                "answered; reporting no pending interrupts"
            )
        return list(open_interrupts.values())
    return []


def _interrupt_session_required_error() -> "RunErrorEvent":
    return RunErrorEvent(
        type=EventType.RUN_ERROR,
        message=(
            "A SessionManager is required for a mixed frontend-proxy/native "
            "interrupt checkpoint"
        ),
        code="INTERRUPT_SESSION_REQUIRED",
    )


def _interrupt_session_capability_error() -> "RunErrorEvent":
    return RunErrorEvent(
        type=EventType.RUN_ERROR,
        message=(
            "Mixed frontend-proxy/native interrupt state requires session_id, "
            "a stable agent_id, and a session_repository exposing "
            "list_messages() and update_message()"
        ),
        code="INTERRUPT_SESSION_CAPABILITY_ERROR",
    )


def _interrupt_reconciliation_error() -> "RunErrorEvent":
    return RunErrorEvent(
        type=EventType.RUN_ERROR,
        message="Active interrupt tool result reconciliation failed",
        code="INTERRUPT_RECONCILIATION_ERROR",
    )


def _interrupt_resume_error(message: str) -> "RunErrorEvent":
    return RunErrorEvent(
        type=EventType.RUN_ERROR,
        message=message,
        code="INTERRUPT_RESUME_ERROR",
    )


def _preflight_resume_entries(
    agent: Any,
    resume_entries: Any,
    pending_ag_ui: dict[str, Any] | None = None,
) -> "RunErrorEvent | None":
    """Validate the complete submitted resume batch without mutating state."""
    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is None or not getattr(interrupt_state, "activated", False):
        return _interrupt_resume_error(
            "Cannot resume without an active native interrupt checkpoint"
        )
    if not isinstance(resume_entries, list) or not resume_entries:
        return _interrupt_resume_error(
            "A submitted resume must contain at least one entry"
        )

    open_interrupts = _open_native_interrupts(
        getattr(interrupt_state, "interrupts", {})
    )
    # An active checkpoint whose every interrupt is answered is a thread the SDK
    # parked mid-resume (see _replays_recorded_answers). The interrupts an exact
    # replay may address are the answered ones it is replaying.
    if _replays_recorded_answers(interrupt_state, resume_entries):
        addressable = dict(getattr(interrupt_state, "interrupts", {}) or {})
    else:
        addressable = open_interrupts
    seen_ids: set[str] = set()
    for entry in resume_entries:
        interrupt_id = getattr(entry, "interrupt_id", None)
        if not isinstance(interrupt_id, str) or not interrupt_id.strip():
            return _interrupt_resume_error(
                "Resume entries must contain a non-blank interrupt id"
            )
        if interrupt_id in seen_ids:
            return _interrupt_resume_error(
                f"Resume contains duplicate interrupt id: {interrupt_id}"
            )
        seen_ids.add(interrupt_id)
        interrupt = addressable.get(interrupt_id)
        if interrupt is None:
            return _interrupt_resume_error(
                f"Resume references an interrupt that is not open: {interrupt_id}"
            )

    missing_ids = set(addressable) - seen_ids
    if missing_ids:
        return RunErrorEvent(
            type=EventType.RUN_ERROR,
            message=(
                f"Partial resume: missing interrupt IDs {sorted(missing_ids)}. "
                "All open interrupts must be addressed."
            ),
            code="PARTIAL_RESUME",
        )

    pending_ag_ui = pending_ag_ui or {}
    for entry in resume_entries:
        ag_ui_interrupt = pending_ag_ui.get(entry.interrupt_id)

        if ag_ui_interrupt and getattr(ag_ui_interrupt, "expires_at", None):
            expiry = datetime.fromisoformat(ag_ui_interrupt.expires_at)
            if datetime.now(timezone.utc) > expiry:
                return RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=f"Interrupt '{entry.interrupt_id}' has expired.",
                    code="INTERRUPT_EXPIRED",
                )

        schema = (
            getattr(ag_ui_interrupt, "response_schema", None)
            if ag_ui_interrupt
            else None
        )
        if not schema and _is_tool_approval_interrupt(
            addressable.get(entry.interrupt_id)
        ):
            # AG-UI bookkeeping can be lost to a restart while the native
            # interrupt is restored. A tool approval's contract is fixed, so
            # validate against it rather than waving the payload through.
            schema = _tool_approval_response_schema()

        if entry.status != "resolved" or not schema:
            continue

        payload = entry.payload
        if schema.get("type") != "object":
            continue
        if not isinstance(payload, dict):
            return RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=(
                    f"Invalid payload for interrupt '{entry.interrupt_id}': "
                    "expected an object."
                ),
                code="INVALID_PAYLOAD",
            )
        required = schema.get("required", [])
        missing_keys = [key for key in required if key not in payload]
        if missing_keys:
            return RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=(
                    f"Invalid payload for interrupt '{entry.interrupt_id}': "
                    f"missing required keys {missing_keys}."
                ),
                code="INVALID_PAYLOAD",
            )
        type_error = _validate_object_payload_property_types(schema, payload)
        if type_error:
            return RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=(
                    f"Invalid payload for interrupt '{entry.interrupt_id}': "
                    f"{type_error}"
                ),
                code="INVALID_PAYLOAD",
            )
    return None


def _error_events(
    input_data: "RunAgentInput",
    message: str,
    code: str,
) -> tuple[Any, Any]:
    """Return (RunStartedEvent, RunErrorEvent) tuple for early-exit error paths.

    Use with: yield ev1; yield ev2 where (ev1, ev2) = _error_events(...)
    """
    return (
        RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        ),
        RunErrorEvent(
            type=EventType.RUN_ERROR,
            message=message,
            code=code,
        ),
    )

logger = logging.getLogger(__name__)
from ag_ui.core import (
    AssistantMessage,
    CustomEvent,
    EventType,
    FunctionCall,
    Interrupt,
    MessagesSnapshotEvent,
    RawEvent,
    ReasoningEncryptedValueEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    ResumeEntry,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunFinishedInterruptOutcome,
    RunFinishedSuccessOutcome,
    RunStartedEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCall,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    ToolMessage,
    UserMessage,
)

from ag_ui_a2ui_toolkit import split_a2ui_schema_context

from .a2ui_tool import (
    A2UI_STREAM_KEY,
    is_auto_injected_a2ui_tool,
    plan_a2ui_injection,
)
from .client_proxy_tool import _is_proxy, sync_proxy_tools
from .session_reconcile import (
    AG_UI_TOOL_CALL_MAP_STATE_KEY,
    AG_UI_WIRE_MAP_STATE_KEY,
    _supports_repository_reconciliation,
    active_proxy_placeholder_ids,
    has_placeholder_results,
    reconcile_frontend_tool_results,
    resolve_native_ids,
)
from .config import (
    StrandsAgentConfig,
    ToolCallContext,
    ToolResultContext,
    ToolStreamEventContext,
    maybe_await,
    normalize_predict_state,
)
from .utils import convert_agui_content_to_strands, flatten_content_to_text


def _resume_fingerprint(resume_entries: list[ResumeEntry]) -> str:
    """Return an order-independent idempotency fingerprint for ``resume[]``.

    A resume addresses a set of pending interrupts, so clients may submit the
    same entries in a different order when replaying a request. Canonicalizing
    both payload object keys and entry order prevents that harmless difference
    from re-invoking the model or tools.
    """
    canonical_entries = [
        (entry.interrupt_id, entry.status, entry.payload)
        for entry in resume_entries
    ]
    canonical_entries.sort(
        key=lambda entry: json.dumps(
            entry, sort_keys=True, default=str, separators=(",", ":")
        )
    )
    serialized = json.dumps(
        canonical_entries, sort_keys=True, default=str, separators=(",", ":")
    )
    return hashlib.md5(  # noqa: S324 -- non-security idempotency key
        serialized.encode(), usedforsecurity=False
    ).hexdigest()


def _validate_object_payload_property_types(
    schema: dict[str, Any], payload: dict[str, Any]
) -> str | None:
    """Validate supplied primitive object properties from a JSON Schema.

    This intentionally complements, rather than replaces, the lightweight
    required-field validation in ``run()``. It supports the primitive types
    used by adapter-issued schemas without adding a full JSON Schema runtime.
    """
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return None

    for field, field_schema in properties.items():
        if field not in payload or not isinstance(field_schema, dict):
            continue
        expected_type = field_schema.get("type")
        if not isinstance(expected_type, str):
            continue
        if _json_schema_type_matches(payload[field], expected_type):
            continue
        article = "an" if expected_type in {"object", "array"} else "a"
        return f"field '{field}' must be {article} {expected_type}."

    return None


def _json_schema_type_matches(value: Any, expected_type: str) -> bool:
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "null":
        return value is None
    # Unsupported JSON Schema constructs remain the caller's responsibility.
    return True


def _coerce_text(content: Any) -> str:
    """Best-effort string view of an AG-UI message content field."""
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    return str(content)


def _coerce_id(value: Any) -> str:
    """Return ``value`` if it is a non-empty string, else a fresh UUID."""
    return value if isinstance(value, str) and value else str(uuid.uuid4())


# Separator for namespacing a sub-agent's tool call ids under the parent tool
# call that owns them. Two agents mint toolUseIds independently, so an inner id
# can be byte-identical to a parent one; without a namespace the inner result
# would resolve the PARENT's tool card (and vice versa). "::" is not produced by
# any Strands/Bedrock id generator, so the prefix is unambiguous.
_INNER_TOOL_ID_SEP = "::"


# Keys Strands' event loop injects into the *payload* of any event carrying a
# ``delta``: ``ModelStreamEvent.prepare()`` does ``self.update(invocation_state)``
# (strands/types/_events.py), which merges the live ``Agent`` object, telemetry
# handles and cycle bookkeeping into the event dict. None of it is model output,
# and ``agent`` in particular carries the system prompt, the full message history
# and the model config — it must never reach a browser. Stripped by name so the
# RAW payload keeps only the provider's own fields.
_RAW_INVOCATION_STATE_KEYS = frozenset(
    {
        "agent",
        "event_loop_cycle_id",
        "event_loop_cycle_trace",
        "event_loop_cycle_span",
        "event_loop_parent_span",
        "event_loop_parent_cycle_id",
        "request_state",
    }
)

# Terminal lifecycle events that carry no payload a frontend can use.
# ``result`` is ``AgentResultEvent`` (an ``AgentResult`` holding
# ``EventLoopMetrics``) and ``stop`` is ``EventLoopStopEvent`` (a tuple of the
# same). Both are the end-of-run marker already represented by RUN_FINISHED, so
# forwarding them would be duplicate noise even if they were serializable.
_RAW_TERMINAL_KEYS = frozenset({"result", "stop"})

# Keys the dispatch chain in ``run`` already owns. Each of their branches is
# *conditionally* entered — ``"data" in event and event["data"]``,
# ``"reasoningText" in event and event.get("reasoning")``,
# ``"current_tool_use" in event and event["current_tool_use"]`` — so a payload
# whose guard evaluates false matches no branch and, with the RAW fallback in
# place, falls through to it.
#
# That conflates two different situations the fallback must keep apart:
#
#   unmapped            the adapter has no branch for this event at all, so
#                       forwarding it as RAW is the whole point of issue #2291
#   mapped-but-declined a branch exists and deliberately withheld the payload
#
# Only the first is RAW-eligible. Without this set the second leaks whatever
# the guard exists to suppress: reasoning text with ``reasoning`` off,
# encrypted ``reasoningRedactedContent``, and the ``reasoning_signature``
# verification token would each be republished verbatim over RAW — the exact
# content the gate withholds — while empty ``data`` and empty
# ``current_tool_use`` updates would add a RAW event carrying no information.
_RAW_SUPPRESSED_KEYS = frozenset(
    {
        "data",
        "reasoningText",
        "reasoningRedactedContent",
        "reasoning_signature",
        "current_tool_use",
    }
)


def _sanitize_raw_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Return a JSON-safe RAW payload for ``event``, or ``None`` to drop it.

    Sanitizing is deliberately an allow-by-serializability filter, never a
    coercion: nothing is stringified to force it through. Coercing (e.g.
    ``json.dumps(..., default=str)``) would ship the ``repr`` of the live
    ``Agent`` — system prompt, conversation history, model configuration — to
    every connected client. A payload that will not encode is dropped instead.
    """
    if any(key in event for key in _RAW_TERMINAL_KEYS):
        return None

    payload = {
        key: value
        for key, value in event.items()
        if key not in _RAW_INVOCATION_STATE_KEYS
    }
    if not payload:
        return None

    try:
        # Strict round-trip: no ``default=`` hook, so any non-JSON-native object
        # raises here rather than being silently rendered. The decoded result is
        # what gets forwarded, guaranteeing only plain JSON types reach the wire.
        return json.loads(json.dumps(payload))
    except (TypeError, ValueError) as exc:
        logger.warning(
            "Dropping unserializable Strands event from RAW forwarding "
            f"(keys={sorted(payload)}): {exc}"
        )
        return None


async def _forward_inner_agent_events(
    inner_event: Any,
    parent_tool_use: Dict[str, Any],
    inner_tool_calls_seen: Dict[str, Dict[str, Any]],
) -> AsyncIterator[Any]:
    """Translate one agent-as-tool inner event into AG-UI tool-call events.

    A Strands generator tool that wraps another ``Agent`` (the agent-as-tool
    pattern) re-yields the inner agent's whole ``stream_async`` output; Strands
    wraps each yield as ``tool_stream_event``. The inner agent's tool calls
    therefore never reach the parent loop's ``current_tool_use`` /
    ``contentBlockStop`` / tool-result branches, so without this the frontend
    sees the sub-agent as an opaque black box (see issue #2304).

    Only the tool-call lifecycle is forwarded, and only onto the wire —
    inner calls are deliberately NOT spliced into ``MessagesSnapshotEvent``
    history, which mirrors the parent conversation Strands actually persists.
    """
    if not isinstance(inner_event, dict):
        return

    parent_id = parent_tool_use.get("toolUseId") or "inner"

    def _namespaced(inner_id: Any) -> str:
        return f"{parent_id}{_INNER_TOOL_ID_SEP}{inner_id or uuid.uuid4()}"

    # Inner tool call, streaming its args in.
    tool_use = inner_event.get("current_tool_use")
    if isinstance(tool_use, dict) and tool_use.get("name"):
        call_id = _namespaced(tool_use.get("toolUseId"))
        raw_input = tool_use.get("input", "")
        raw_str = (
            raw_input
            if isinstance(raw_input, str)
            else json.dumps(raw_input, default=str)
        )
        entry = inner_tool_calls_seen.get(call_id)
        if entry is None:
            entry = inner_tool_calls_seen[call_id] = {
                "name": tool_use["name"],
                "sent_len": 0,
                "ended": False,
                # Which parent tool call owns this inner call. The dict is
                # shared across every parent agent-as-tool call in the run, so
                # the contentBlockStop handler below needs this to avoid
                # closing a sibling parent's inner call.
                "parent_id": parent_id,
            }
            yield ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=call_id,
                tool_call_name=tool_use["name"],
            )
        if len(raw_str) > entry["sent_len"]:
            yield ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=call_id,
                delta=raw_str[entry["sent_len"] :],
            )
            entry["sent_len"] = len(raw_str)
        return

    # Inner content block closed — close the newest still-open inner call
    # *belonging to this parent*. Mirrors the parent loop, which also closes one
    # call per contentBlockStop.
    #
    # The scoping is load-bearing: ``inner_tool_calls_seen`` is shared across
    # every agent-as-tool call in the run, and Strands executes a parallel tool
    # batch concurrently, so two sub-agents interleave their streams here. An
    # unscoped "newest still-open call" search lets parent A's stop close
    # parent B's inner call — B's tool card resolves early and A's never gets a
    # TOOL_CALL_END at all, leaving it spinning forever on the frontend.
    model_chunk = inner_event.get("event")
    if isinstance(model_chunk, dict) and "contentBlockStop" in model_chunk:
        for call_id, entry in reversed(list(inner_tool_calls_seen.items())):
            if entry.get("parent_id") != parent_id:
                continue
            if not entry["ended"]:
                entry["ended"] = True
                yield ToolCallEndEvent(
                    type=EventType.TOOL_CALL_END,
                    tool_call_id=call_id,
                )
                break
        return

    # Inner tool results.
    message = inner_event.get("message")
    if isinstance(message, dict) and message.get("role") == "user":
        for item in message.get("content") or []:
            if not isinstance(item, dict) or "toolResult" not in item:
                continue
            tool_result = item["toolResult"]
            if not isinstance(tool_result, dict):
                continue
            call_id = _namespaced(tool_result.get("toolUseId"))
            # Only resolve calls this forwarder actually opened, so a result we
            # never announced can't leave a dangling tool card on the frontend.
            if call_id not in inner_tool_calls_seen:
                continue
            texts = [
                block["text"]
                for block in tool_result.get("content") or []
                if isinstance(block, dict) and "text" in block
            ]
            raw_text = "".join(texts)
            try:
                result_data = json.loads(raw_text)
            except (json.JSONDecodeError, TypeError):
                result_data = raw_text
            yield ToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                tool_call_id=call_id,
                message_id=str(uuid.uuid4()),
                content=json.dumps(result_data, default=str),
                # role intentionally omitted — same as the parent-level result
                # path, so the frontend closes the spinner without writing the
                # inner call into conversation history.
            )


def _build_snapshot_messages(input_messages: List[Any]) -> List[Any]:
    """Convert ``RunAgentInput.messages`` to AG-UI message objects.

    Used to seed the running ``MessagesSnapshotEvent`` payload so each
    snapshot carries the full thread history (prior turns + whatever
    this turn produces).
    """
    out: List[Any] = []
    for msg in input_messages or []:
        role = getattr(msg, "role", None)
        if role not in ("user", "assistant", "tool"):
            continue
        msg_id = _coerce_id(getattr(msg, "id", None))
        if role == "user":
            raw = msg.content
            # Preserve list content (multimodal) as-is; only stringify unexpected types.
            content = raw if isinstance(raw, (str, list)) else _coerce_text(raw)
            out.append(UserMessage(id=msg_id, role="user", content=content))
        elif role == "assistant":
            tool_calls_list = None
            raw_tool_calls = getattr(msg, "tool_calls", None)
            if raw_tool_calls:
                tool_calls_list = []
                for tc in raw_tool_calls:
                    fn = getattr(tc, "function", None)
                    if isinstance(fn, dict):
                        fn_name = fn.get("name") or "unknown"
                        fn_args = fn.get("arguments") or "{}"
                    else:
                        fn_name = getattr(fn, "name", None) or "unknown"
                        fn_args = getattr(fn, "arguments", None) or "{}"
                    tc_id = _coerce_id(getattr(tc, "id", None))
                    tool_calls_list.append(
                        ToolCall(
                            id=tc_id,
                            type="function",
                            function=FunctionCall(
                                name=str(fn_name),
                                arguments=str(fn_args),
                            ),
                        )
                    )
            out.append(
                AssistantMessage(
                    id=msg_id,
                    role="assistant",
                    content=_coerce_text(msg.content),
                    tool_calls=tool_calls_list,
                )
            )
        elif role == "tool":
            tool_call_id = getattr(msg, "tool_call_id", "")
            if not isinstance(tool_call_id, str):
                tool_call_id = ""
            out.append(
                ToolMessage(
                    id=msg_id,
                    role="tool",
                    content=_coerce_text(msg.content),
                    tool_call_id=tool_call_id,
                    # This is an AG-UI -> AG-UI rebuild of the client's own message, so
                    # preserve its error/encrypted_value on the snapshot echo instead of
                    # silently dropping the client's own fields.
                    error=getattr(msg, "error", None),
                    encrypted_value=getattr(msg, "encrypted_value", None),
                )
            )
    return out


def _build_strands_history(input_messages: List[Any]) -> List[Dict[str, Any]]:
    """Convert ``RunAgentInput.messages`` to Strands native ``Messages``.

    Strands has only ``user`` and ``assistant`` roles; tool calls and
    tool results live as ``toolUse`` / ``toolResult`` ContentBlocks.
    Reconciling the cached agent's ``self.messages`` with this list
    before invoking ``stream_async(None)`` ensures the LLM sees the
    real conversation state — including frontend tool results — rather
    than a fresh prompt that re-fires the same tool every turn.
    """
    out: List[Dict[str, Any]] = []
    pending_tool_results: List[Dict[str, Any]] = []

    def flush_tool_results() -> None:
        if not pending_tool_results:
            return
        out.append({"role": "user", "content": list(pending_tool_results)})
        pending_tool_results.clear()

    for msg in input_messages or []:
        role = getattr(msg, "role", None)
        if role == "tool":
            pending_tool_results.append(
                {
                    "toolResult": {
                        "toolUseId": getattr(msg, "tool_call_id", "") or "",
                        "content": [{"text": _coerce_text(msg.content)}],
                        # Carry the AG-UI failure signal onto Bedrock's toolResult status,
                        # so a client-reported tool failure is not asserted to the model as
                        # a success.
                        "status": "error" if getattr(msg, "error", None) else "success",
                    }
                }
            )
            continue

        flush_tool_results()

        if role == "user":
            content = msg.content
            if isinstance(content, list):
                has_media = any(
                    getattr(item, "type", None) in ("image", "audio", "video", "document")
                    for item in content
                )
                if has_media:
                    blocks = convert_agui_content_to_strands(content)
                    if isinstance(blocks, list) and blocks:
                        out.append({"role": "user", "content": blocks})
                        continue
                text = flatten_content_to_text(content) or ""
                out.append({"role": "user", "content": [{"text": text}]})
            else:
                out.append({"role": "user", "content": [{"text": _coerce_text(content)}]})
        elif role == "assistant":
            blocks: List[Dict[str, Any]] = []
            text = _coerce_text(msg.content)
            if text:
                blocks.append({"text": text})
            raw_tool_calls = getattr(msg, "tool_calls", None) or []
            for tc in raw_tool_calls:
                fn = getattr(tc, "function", None)
                if isinstance(fn, dict):
                    name = fn.get("name") or "unknown"
                    args = fn.get("arguments") or "{}"
                else:
                    name = getattr(fn, "name", None) or "unknown"
                    args = getattr(fn, "arguments", None) or "{}"
                try:
                    parsed = json.loads(args) if isinstance(args, str) else (args or {})
                except (json.JSONDecodeError, TypeError):
                    parsed = {}
                blocks.append(
                    {
                        "toolUse": {
                            "toolUseId": tc.id,
                            "name": name,
                            "input": parsed if isinstance(parsed, dict) else {},
                        }
                    }
                )
            if not blocks:
                blocks = [{"text": ""}]
            out.append({"role": "assistant", "content": blocks})

    flush_tool_results()
    # Normalize so Bedrock's toolUse/toolResult pairing holds even when results
    # arrive out of order, are wedged apart by other messages, or span multiple
    # consecutive tool-call turns (parallel tool calls).
    return _normalize_tool_turns(out)


def _is_tooluse_only_assistant(m):
    return (
        m.get("role") == "assistant"
        and m.get("content")
        and all("toolUse" in b for b in m["content"])
    )


def _is_toolresult_only_user(m):
    return (
        m.get("role") == "user"
        and m.get("content")
        and all("toolResult" in b for b in m["content"])
    )


def _normalize_tool_turns(msgs):
    """Merge same-turn toolUse into one assistant msg and their toolResults
    into the immediately following user msg, dropping any messages wedged
    between a toolUse turn and its toolResults so Bedrock accepts the history.

    Messages that legitimately *follow* a completed toolUse/toolResult pair are
    preserved in place; only messages wedged *between* the toolUse turn and its
    results are dropped.
    """
    out = []
    i = 0
    n = len(msgs)
    while i < n:
        m = msgs[i]
        if not _is_tooluse_only_assistant(m):
            out.append(m)
            i += 1
            continue

        # Collect consecutive toolUse-only assistant messages into one.
        merged_tooluse = list(m["content"])
        j = i + 1
        while j < n and _is_tooluse_only_assistant(msgs[j]):
            merged_tooluse.extend(msgs[j]["content"])
            j += 1
        # Preserve first-seen order and de-duplicate ids: a repeated toolUseId
        # must not later emit a duplicate toolResult (Bedrock rejects that).
        tooluse_ids = []
        seen_ids = set()
        for b in merged_tooluse:
            rid = b["toolUse"]["toolUseId"]
            if rid not in seen_ids:
                seen_ids.add(rid)
                tooluse_ids.append(rid)

        # Scan forward for the matching toolResults. Anything that is not a
        # matching result and appears *before* results are complete is "wedged"
        # and dropped; once every result is collected, the remaining messages
        # are left untouched to be processed in place by the outer loop.
        results_by_id = {}
        k = j
        while k < n and len(results_by_id) < len(tooluse_ids):
            mk = msgs[k]
            if _is_toolresult_only_user(mk):
                for b in mk["content"]:
                    rid = b["toolResult"].get("toolUseId")
                    if rid in seen_ids and rid not in results_by_id:
                        results_by_id[rid] = b
                    # non-matching / duplicate result blocks wedged in are dropped
            # non-toolResult messages wedged before completion are dropped
            k += 1

        # Emit merged assistant(toolUse) + merged user(toolResult) adjacently.
        out.append({"role": "assistant", "content": merged_tooluse})
        ordered = [results_by_id[tid] for tid in tooluse_ids if tid in results_by_id]
        if ordered:
            out.append({"role": "user", "content": ordered})

        # Continue with whatever legitimately follows, in place (no reordering).
        i = k
    return out


# ---------------------------------------------------------------------------
# Interrupt bookkeeping persistence
# ---------------------------------------------------------------------------
#
# ``_pending_interrupts_by_thread`` and ``_last_resume_fingerprint`` are the
# adapter's own bookkeeping (idempotency fingerprint + AG-UI-specific
# interrupt metadata like responseSchema/expiresAt) layered on top of
# Strands' native ``_interrupt_state``. Strands' own SessionManager already
# persists/restores ``_interrupt_state`` (and, on a fresh process, the
# per-thread agent + session are reconstructed before this bookkeeping is
# consulted — see the resume-validation gate in ``run()``), but this
# adapter-only bookkeeping lived purely in a Python dict on the
# ``StrandsAgent`` instance, so a process restart lost it: rules 6/7
# (payload-schema validation, expiresAt enforcement) would silently degrade,
# and a replayed resume request would no longer be recognized as a duplicate
# and could re-invoke the model/tool.
#
# To survive a restart, this bookkeeping is now mirrored into
# ``strands_agent.state`` under a single namespaced key — the same
# per-thread, SessionManager-persisted key-value store the adapter already
# uses for ``agui_context``. On every read, if nothing is cached in-process
# for this thread_id, fall back to what's persisted in state.

_INTERRUPT_BOOKKEEPING_STATE_KEY = "ag_ui_interrupt_bookkeeping"


def _load_persisted_interrupt_bookkeeping(
    strands_agent: Any,
) -> tuple[Dict[str, Interrupt] | None, str | None]:
    """Read the persisted (fingerprint, pending-interrupts) pair from
    ``strands_agent.state``, if present and well-formed.

    Defensive by design: a test double (e.g. a bare ``MagicMock()`` standing
    in for the Strands agent) will happily return another mock from
    ``state.get(...)`` rather than ``None``, so every layer of the expected
    shape is checked explicitly before trusting it. Anything that doesn't
    match is treated as "nothing persisted" rather than raised.
    """
    try:
        state = getattr(strands_agent, "state", None)
        get = getattr(state, "get", None)
        if not callable(get):
            return None, None
        raw = get(_INTERRUPT_BOOKKEEPING_STATE_KEY)
    except Exception:  # noqa: BLE001 — never let bookkeeping restore crash a run
        return None, None

    if not isinstance(raw, dict):
        return None, None

    fingerprint = raw.get("last_resume_fingerprint")
    if fingerprint is not None and not isinstance(fingerprint, str):
        fingerprint = None

    pending_raw = raw.get("pending_interrupts")
    pending: Dict[str, Interrupt] | None = None
    if isinstance(pending_raw, dict):
        pending = {}
        for interrupt_id, data in pending_raw.items():
            if not isinstance(interrupt_id, str) or not isinstance(data, dict):
                continue
            try:
                pending[interrupt_id] = Interrupt.model_validate(data)
            except Exception:  # noqa: BLE001 — skip malformed entries, don't crash
                continue

    return pending, fingerprint


def _persist_interrupt_bookkeeping(
    strands_agent: Any,
    pending: Dict[str, Interrupt] | None,
    fingerprint: str | None,
) -> None:
    """Write the (fingerprint, pending-interrupts) pair to
    ``strands_agent.state`` and flush it through the configured SessionManager.

    Strands' ``AfterInvocation`` persistence hook runs before ``stream_async``
    yields its terminal result, while this adapter can only derive bookkeeping
    from that result. Explicitly syncing after the state write makes the
    metadata durable before the AG-UI run returns. Persistence remains
    best-effort so a broken state/session implementation cannot break the run.
    """
    try:
        state = getattr(strands_agent, "state", None)
        set_fn = getattr(state, "set", None)
        if not callable(set_fn):
            return
        payload = {
            "last_resume_fingerprint": fingerprint,
            "pending_interrupts": (
                {i_id: i.model_dump(mode="json") for i_id, i in pending.items()}
                if pending
                else {}
            ),
        }
        set_fn(_INTERRUPT_BOOKKEEPING_STATE_KEY, payload)
        session_manager = _get_strands_session_manager(strands_agent)
        sync_agent = getattr(session_manager, "sync_agent", None)
        if callable(sync_agent):
            sync_agent(strands_agent)
    except Exception as e:  # noqa: BLE001 — persistence is best-effort
        logger.warning(f"Failed to persist interrupt bookkeeping: {e}")


# ---------------------------------------------------------------------------
# Strands-native interrupt hook
# ---------------------------------------------------------------------------

class StrandsInterruptHook:
    """Interrupts server tools configured with ``interrupt_on_call=True``.

    Registered automatically by :class:`StrandsAgent` when any entry in
    ``config.tool_behaviors`` has ``interrupt_on_call=True``.

    Client-provided proxy tools warn and skip the interrupt because their
    execution must be gated in the client.

    On the **first** call for a configured server-executed tool the hook calls
    ``event.interrupt()``, which raises ``InterruptException`` internally and
    suspends the Strands agent loop. On the **resume** call Strands has already
    written the human response into the interrupt object, so
    ``event.interrupt()`` returns the response payload instead of raising. The
    hook then grants approval only for ``{"approved": True}``; otherwise it
    sets ``event.cancel_tool`` so the tool is skipped.
    """

    def __init__(self, tool_behaviors: "Dict[str, ToolBehavior]") -> None:
        self._tool_behaviors = tool_behaviors

    def register_hooks(self, registry: Any, **kwargs: Any) -> None:
        """Register the BeforeToolCallEvent callback."""
        from strands.hooks.events import BeforeToolCallEvent as _BeforeToolCallEvent
        registry.add_callback(_BeforeToolCallEvent, self._on_before_tool_call)

    def _on_before_tool_call(self, event: Any) -> None:
        """Skip client proxies; interrupt or enforce approval for server tools."""
        tool_name = event.tool_use.get("name", "")
        behavior = self._tool_behaviors.get(tool_name)
        if not behavior or not behavior.interrupt_on_call:
            return
        if _is_proxy(event.selected_tool):
            logger.warning(
                "interrupt_on_call is ignored for client-provided tool '%s'; "
                "gate execution in the client.",
                tool_name,
            )
            return

        # event.interrupt() either:
        #   - raises InterruptException (first call, no response yet) → suspends loop
        #   - returns the human response payload (resume call) → enforce decision
        response = event.interrupt(
            f"{_TOOL_APPROVAL_NAME_PREFIX}{tool_name}",
            reason={
                "tool_name": tool_name,
                "tool_input": event.tool_use.get("input", {}),
                "tool_use_id": event.tool_use.get("toolUseId"),
            },
        )
        # If we reach here we are on the resume path.
        # Enforce a strict payload contract matching the advertised
        # response_schema ({"approved": bool}, required): only a dict with
        # "approved" set to an actual bool of True grants approval. Anything
        # else — a missing key, a non-bool value (e.g. a truthy string like
        # "false", a number, None), or a non-dict response — is treated as
        # an explicit denial rather than being coerced by truthiness.
        approved = (
            isinstance(response, dict)
            and isinstance(response.get("approved"), bool)
            and response["approved"] is True
        )
        if not approved:
            event.cancel_tool = f"User denied approval for '{tool_name}'."



class StrandsAgent:
    """AWS Strands Agent wrapper for AG-UI integration."""

    def __init__(
        self,
        agent: StrandsAgentCore,
        name: str,
        description: str = "",
        config: "StrandsAgentConfig | None" = None,
        hooks: "list | None" = None,
        agents_by_thread: "Dict[str, Any] | None" = None,
    ):
        # Store template agent configuration for creating fresh instances
        self._model = agent.model
        self._system_prompt = agent.system_prompt
        self._tools = (
            list(agent.tool_registry.registry.values())
            if hasattr(agent, "tool_registry")
            else []
        )
        self._agent_kwargs = _extract_agent_kwargs(agent)

        # Hook providers forwarded to each per-thread StrandsAgentCore.
        #
        # Why a dedicated kwarg instead of reading them off the template?
        # Strands initializes ``Agent.hooks`` as a ``HookRegistry`` containing
        # only the registered callbacks — the original list of HookProvider
        # objects is not retained, and the registry also contains callbacks
        # bound to internal Strands objects (conversation manager, retry
        # strategy) that belong to the template and must not be cross-wired
        # into per-thread agents. We therefore take providers directly from
        # the caller and forward them to every per-thread instance so any
        # observability / loop-cap / policy-enforcement hook actually fires.
        self._hooks = list(hooks) if hooks else []

        self.name = name
        self.description = description
        self.config = config or StrandsAgentConfig()

        # Auto-register StrandsInterruptHook when any tool has interrupt_on_call=True.
        # Prepend so it fires before any caller-supplied hooks.
        interrupt_tools = {
            name: b
            for name, b in self.config.tool_behaviors.items()
            if b.interrupt_on_call
        }
        if interrupt_tools:
            self._hooks = [StrandsInterruptHook(interrupt_tools), *self._hooks]

        # Detect the common footgun: session_manager set on the template Agent
        # (stored as `_session_manager` by Strands) with no per-thread provider.
        # Forwarding it would make every AG-UI thread share one session_id.
        template_session_manager = getattr(agent, "_session_manager", None)
        if (
            template_session_manager is not None
            and self.config.session_manager_provider is None
        ):
            logger.warning(
                "session_manager was set on the template Agent but will be ignored: "
                "forwarding it would cause every AG-UI thread to share the same "
                "session_id. Construct per-thread session managers via "
                "StrandsAgentConfig.session_manager_provider instead."
            )

        # Dictionary to store agent instances per thread
        self._agents_by_thread: Dict[str, StrandsAgentCore] = agents_by_thread if agents_by_thread is not None else {}
        # Track proxy tool names registered per thread
        self._proxy_tool_names_by_thread: Dict[str, set] = {}
        # AG-UI interrupt metadata per thread: the answer shape advertised to
        # the client and validated on the way back, the tool card an interrupt
        # belongs to, and an expiry. Never consulted to decide whether anything
        # is pending; the native interrupt state answers that on its own.
        self._pending_interrupts_by_thread: Dict[str, Dict[str, Interrupt]] = {}
        # Fingerprint of last successfully-processed resume per thread (idempotency)
        self._last_resume_fingerprint: Dict[str, str] = {}
        # Guards first-time thread initialization. The session_manager_provider
        # call introduces an async yield point between the "is this thread
        # new?" check and the dict assignment, so concurrent requests for the
        # same new thread_id could otherwise both create an agent and one
        # would clobber the other.
        self._thread_init_lock = asyncio.Lock()

    def _will_emit_tool_snapshot(self, behavior: Any, emit_snapshots: bool) -> bool:
        # ``emit_snapshots`` is the per-run gate (config flag AND not a
        # delta-only payload); callers pass it so snapshot emission stays
        # suppressed on delta payloads that would otherwise wipe prior turns.
        return emit_snapshots and not (
            behavior and behavior.skip_messages_snapshot
        )

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        """Run the Strands agent and yield AG-UI events."""

        # Get or create agent instance for this thread. When a
        # session_manager_provider is configured, the SessionManager handles
        # conversation persistence; otherwise state is held in-memory per thread.
        thread_id = input_data.thread_id or "default"
        if thread_id not in self._agents_by_thread:
            async with self._thread_init_lock:
                # Double-check inside the lock: another coroutine may have
                # completed initialization while we were waiting.
                if thread_id not in self._agents_by_thread:
                    session_manager = None
                    if self.config.session_manager_provider:
                        try:
                            session_manager = await maybe_await(
                                self.config.session_manager_provider(input_data)
                            )
                        except Exception as e:
                            # ERROR (not WARNING): the run is being aborted.
                            # exc_info=True preserves the full traceback so
                            # programming errors (TypeError, NameError, ...)
                            # in the provider surface clearly rather than
                            # looking like an infrastructure problem.
                            logger.error(
                                f"session_manager_provider failed: {e}",
                                exc_info=True,
                            )
                            ev_started, ev_error = _error_events(
                                input_data,
                                f"Failed to initialize session manager: {e}",
                                "SESSION_MANAGER_ERROR",
                            )
                            yield ev_started
                            yield ev_error
                            return
                        # Validate the provider return type at the boundary —
                        # otherwise a forgotten call or wrong type surfaces
                        # deep inside Strands with a confusing traceback.
                        if session_manager is not None and not isinstance(
                            session_manager, SessionManager
                        ):
                            actual = type(session_manager).__name__
                            logger.error(
                                "session_manager_provider returned %s; "
                                "expected a SessionManager instance.",
                                actual,
                            )
                            ev_started, ev_error = _error_events(
                                input_data,
                                f"session_manager_provider returned {actual}; expected a SessionManager instance",
                                "SESSION_MANAGER_INVALID_TYPE",
                            )
                            yield ev_started
                            yield ev_error
                            return
                    if session_manager is None and self.config.session_manager_provider:
                        logger.warning(
                            f"session_manager_provider returned None for thread_id={thread_id}; "
                            "agent will run without session persistence"
                        )
                    # Only forward ``hooks`` when the caller actually
                    # supplied providers. Passing ``hooks=None`` or
                    # ``hooks=[]`` risks being interpreted differently by
                    # future StrandsAgentCore versions (e.g. as "disable
                    # default hooks"), so we omit the kwarg entirely when
                    # there's nothing to forward.
                    core_kwargs = dict(self._agent_kwargs)
                    if self._hooks:
                        core_kwargs["hooks"] = list(self._hooks)
                    self._agents_by_thread[thread_id] = StrandsAgentCore(
                        model=self._model,
                        system_prompt=self._system_prompt,
                        tools=self._tools,
                        session_manager=session_manager,
                        **core_kwargs,
                    )
        strands_agent = self._agents_by_thread[thread_id]

        # A submitted resume must be validated before any adapter mutation
        # (context writes, proxy synchronization, history reconciliation, or
        # metadata pruning). Strands otherwise applies entries one at a time,
        # which lets a later invalid id partially consume the checkpoint.
        resume_entries = getattr(input_data, "resume", None)
        # ``RunAgentInput.resume`` is a list when the field was submitted.
        # Some legacy callers pass mock-like inputs whose undeclared
        # attributes auto-materialize; do not mistake those for a resume.
        resume_submitted = isinstance(resume_entries, list)
        interrupt_state = getattr(strands_agent, "_interrupt_state", None)
        pending_resume_interrupts = self._pending_interrupts_by_thread.get(thread_id)
        resume_fingerprint = self._last_resume_fingerprint.get(thread_id)
        if resume_submitted and (
            pending_resume_interrupts is None or resume_fingerprint is None
        ):
            persisted_pending, persisted_fingerprint = (
                _load_persisted_interrupt_bookkeeping(strands_agent)
            )
            if pending_resume_interrupts is None:
                pending_resume_interrupts = persisted_pending
            if resume_fingerprint is None:
                resume_fingerprint = persisted_fingerprint
        if resume_submitted and (
            not resume_entries
            or (
                interrupt_state is not None
                and getattr(interrupt_state, "activated", False)
            )
        ):
            resume_error = _preflight_resume_entries(
                strands_agent,
                resume_entries,
                pending_resume_interrupts,
            )
            if resume_error is not None:
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield resume_error
                return

        # Rule 4: reject new input against a parked checkpoint before context
        # or tool registries can be updated by a run that will not proceed. The
        # SDK owns the checkpoint, so a checkpoint it still holds active blocks
        # the turn and is left exactly as it stands: deactivating it here would
        # discard the tool use and tool results parked behind it.
        if (
            not resume_submitted
            and getattr(interrupt_state, "activated", False) is True
        ):
            ev_started, ev_error = _error_events(
                input_data,
                "Thread has pending interrupts. Include resume[] to address them.",
                "PENDING_INTERRUPTS",
            )
            yield ev_started
            yield ev_error
            return

        # An inactive checkpoint may be an idempotent replay of a resume that
        # already completed. Resolve that before any per-run mutable setup.
        if resume_submitted and resume_entries and not getattr(
            interrupt_state, "activated", False
        ):
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            fingerprint = _resume_fingerprint(resume_entries)
            if resume_fingerprint == fingerprint:
                yield RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                    outcome=RunFinishedSuccessOutcome(type="success"),
                )
            else:
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message="No pending interrupt for this thread.",
                    code="UNKNOWN_INTERRUPT_ID",
                )
            return

        session_manager = _get_strands_session_manager(strands_agent)
        has_active_interrupt = bool(
            getattr(
                getattr(strands_agent, "_interrupt_state", None),
                "activated",
                False,
            )
        )
        active_proxy_native_ids = active_proxy_placeholder_ids(strands_agent)
        if active_proxy_native_ids:
            if session_manager is None:
                session_error = _interrupt_session_required_error()
            elif not _supports_repository_reconciliation(
                session_manager, strands_agent
            ):
                session_error = _interrupt_session_capability_error()
            else:
                session_error = None
            if session_error is not None:
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield session_error
                return

        # Forward ``RunAgentInput.context`` to the per-thread Strands agent's
        # state so user tools can read it (e.g. catalog/component schemas
        # injected by the CopilotKit FE for A2UI rendering). Mirrors the
        # langgraph integration where tools read ``runtime.state["copilotkit"]
        # ["context"]``. Stored as a plain list of ``{description, value}``
        # dicts to satisfy ``JSONSerializableDict`` validation.
        agui_context = []
        for ctx in (input_data.context or []):
            if isinstance(ctx, dict):
                agui_context.append(
                    {
                        "description": ctx.get("description", ""),
                        "value": ctx.get("value", ""),
                    }
                )
            else:
                agui_context.append(
                    {
                        "description": getattr(ctx, "description", "") or "",
                        "value": getattr(ctx, "value", "") or "",
                    }
                )
        try:
            strands_agent.state.set("agui_context", agui_context)
        except Exception as e:
            logger.warning(f"Failed to set agui_context on strands_agent.state: {e}")

        # Sync proxy tools from client-defined tools
        if input_data.tools:
            proxy_names = sync_proxy_tools(
                strands_agent.tool_registry,
                input_data.tools,
                self._proxy_tool_names_by_thread.get(thread_id, set()),
            )
            self._proxy_tool_names_by_thread[thread_id] = proxy_names
        elif self._proxy_tool_names_by_thread.get(thread_id):
            # Remove all stale proxy tools when no tools are sent
            sync_proxy_tools(
                strands_agent.tool_registry,
                [],
                self._proxy_tool_names_by_thread[thread_id],
            )
            self._proxy_tool_names_by_thread[thread_id] = set()

        # A2UI auto-injection. When the runtime forwards
        # ``injectA2UITool`` (or the host opts in via ``config.a2ui``), register
        # a ``generate_a2ui`` recovery tool bound to this agent's model and drop
        # the injected ``render_a2ui`` proxy so the model calls generate_a2ui
        # directly. Best-effort: a failure here logs and runs without A2UI
        # rather than crashing the turn.
        try:
            registry = strands_agent.tool_registry
            # Remove our OWN prior-turn auto-injected tool first, so (a) the
            # refreshed tool carries THIS turn's messages/state, and (b) the
            # USER-PREVAILS check only ever sees a dev-wired
            # generate_a2ui — not our own from a previous turn on this cached
            # agent. Without this, turn 2+ leaks the re-synced render_a2ui back
            # to the model.
            for name in [
                n for n, t in list(registry.registry.items())
                if is_auto_injected_a2ui_tool(t)
            ]:
                registry.registry.pop(name, None)
                getattr(registry, "dynamic_tools", {}).pop(name, None)
            # Lift the A2UI component schema + remaining context under
            # state["ag-ui"] so the generate_a2ui sub-agent prompt carries the
            # "## Available Components" block + context — same routing the
            # LangGraph adapter does in its state merge. Uses the shared toolkit
            # split so both adapters agree on the schema-context description.
            a2ui_schema_value, a2ui_regular_ctx = split_a2ui_schema_context(
                input_data.context
            )
            a2ui_state = (
                dict(input_data.state)
                if isinstance(input_data.state, dict)
                else {}
            )
            a2ui_ag_ui: dict = {"context": a2ui_regular_ctx}
            if a2ui_schema_value is not None:
                a2ui_ag_ui["a2ui_schema"] = a2ui_schema_value
            a2ui_state["ag-ui"] = a2ui_ag_ui

            a2ui_plan = plan_a2ui_injection(
                model=getattr(strands_agent, "model", None),
                input=input_data,
                existing_tool_names=list(registry.registry.keys()),
                config=self.config.a2ui,
                log=logger,
                strands_agent=strands_agent,
                agui_state=a2ui_state,
            )
            if a2ui_plan:
                # Register FIRST: if this raises, the except below degrades to
                # "render proxy leaks through" (middleware still paints,
                # unvalidated) instead of a turn with no A2UI path at all.
                registry.register_tool(a2ui_plan["tool"])
                for name in a2ui_plan["drop_tool_names"]:
                    registry.registry.pop(name, None)
                    getattr(registry, "dynamic_tools", {}).pop(name, None)
                    # Keep the proxy bookkeeping honest — the dropped render
                    # tool is no longer registered.
                    self._proxy_tool_names_by_thread.get(thread_id, set()).discard(name)
        except Exception as e:  # noqa: BLE001 — never crash the turn here
            # ERROR, not warning: the runtime explicitly requested injection
            # (injectA2UITool) and this turn runs without it.
            logger.error(
                "A2UI auto-injection failed; running without A2UI for this turn: %s",
                e,
                exc_info=True,
            )

        # ── Interrupt resume handling ──────────────────────────────────────
        # If the client is resuming an interrupted run, validate the
        # interrupt_id against the Strands _interrupt_state, build
        # interruptResponse dicts, and pass them to stream_async() so Strands
        # resumes from its checkpoint.  Cancelled resumes end the run cleanly.
        _resume_prompt: list | None = None
        _resumed_tool_call_ids: set = set()
        resume_entries: list[ResumeEntry] = list(resume_entries or [])

        if resume_entries:
            interrupt_state = getattr(strands_agent, "_interrupt_state", None)
            pending_ag_ui = pending_resume_interrupts or {}
            interrupt_responses: list[dict] = []

            for entry in resume_entries:
                ag_ui_interrupt = pending_ag_ui.get(entry.interrupt_id)
                native_interrupt = interrupt_state.interrupts.get(entry.interrupt_id)

                if entry.status in ("cancelled", "resolved"):
                    # A cancelled entry still carries a response, so Strands
                    # marks the interrupt answered and stops re-raising it.
                    interrupt_responses.append({
                        "interruptResponse": {
                            "interruptId": entry.interrupt_id,
                            "response": _native_resume_response(
                                entry, native_interrupt
                            ),
                        }
                    })
                    # Track tool_call_ids so the tool card is not re-emitted.
                    if ag_ui_interrupt and getattr(ag_ui_interrupt, "tool_call_id", None):
                        _resumed_tool_call_ids.add(ag_ui_interrupt.tool_call_id)

            # Note: even when ALL entries are cancelled, we still forward the
            # denial responses to Strands via stream_async() below rather than
            # short-circuiting here. This ensures native interrupt-state
            # cleanup, hooks, snapshots, and session persistence all run
            # through Strands' normal completion path instead of being
            # bypassed by a synthetic RUN_FINISHED.

            # Pass interruptResponse dicts as the prompt — Strands resumes from
            # its checkpoint without replaying the full conversation.
            logger.debug(
                f"Resuming interrupted run: thread_id={input_data.thread_id}, "
                f"interrupt_responses={interrupt_responses}"
            )
            _resume_prompt: list | None = interrupt_responses
            # Bookkeeping is cleared only after successful processing below so
            # reconciliation failures leave the checkpoint retryable.

        # ── Start run ─────────────────────────────────────────────────────
        # Start run
        yield RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )

        try:
            # Detect delta-only payloads (where the client sent fewer
            # messages than the session has — e.g. only the trailing
            # tool result, or only the new user message in a continued
            # chat). CopilotKit V2's MESSAGES_SNAPSHOT handler treats
            # the snapshot as authoritative: any existing client message
            # whose id is not in the snapshot gets dropped. Emitting a
            # partial snapshot on a delta payload would wipe prior turns
            # from the UI. The frontend already has the full history with
            # the original ids, so we suppress snapshot emission for this
            # run and let TEXT_MESSAGE_*/TOOL_CALL_* streaming events
            # reconcile naturally.
            session_msgs = getattr(strands_agent, "messages", None) or []
            is_delta_payload = (
                bool(session_msgs)
                and len(session_msgs) > len(input_data.messages or [])
            )
            emit_snapshots = (
                self.config.emit_messages_snapshot and not is_delta_payload
            )

            # Seed the running ``MessagesSnapshotEvent`` payload from the
            # full conversation history sent by the client. Each emitted
            # snapshot then carries prior turns + whatever this turn adds.
            snapshot_messages: List[Any] = (
                _build_snapshot_messages(input_data.messages)
                if emit_snapshots
                else []
            )

            # Emit state snapshot if provided
            if hasattr(input_data, "state") and input_data.state is not None:
                # Filter out messages from state to avoid "Unknown message role" errors
                # The frontend manages messages separately and doesn't recognize "tool" role
                state_snapshot = {
                    k: v for k, v in input_data.state.items() if k != "messages"
                }
                yield StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT, snapshot=state_snapshot
                )

            # Splice point 1 of 4: emit the initial messages snapshot right
            # after ``RunStartedEvent`` / ``StateSnapshotEvent`` so the
            # frontend can render the seeded thread before any new content
            # streams in.
            if emit_snapshots and snapshot_messages:
                yield MessagesSnapshotEvent(
                    type=EventType.MESSAGES_SNAPSHOT,
                    messages=list(snapshot_messages),
                )

            # Extract frontend tool names from input_data.tools
            frontend_tool_names = set()
            if input_data.tools:
                for tool_def in input_data.tools:
                    tool_name = (
                        tool_def.get("name")
                        if isinstance(tool_def, dict)
                        else getattr(tool_def, "name", None)
                    )
                    if tool_name:
                        frontend_tool_names.add(tool_name)

            # Collect tool_call_ids that already have results in the message history
            # so we suppress duplicate TOOL_CALL_START events only for those specific calls
            pending_tool_result_ids: set[str] = set()
            if input_data.messages:
                for msg in reversed(input_data.messages):
                    if msg.role == "tool":
                        tool_call_id = getattr(msg, "tool_call_id", None)
                        if tool_call_id:
                            pending_tool_result_ids.add(tool_call_id)
                    else:
                        break
                if pending_tool_result_ids:
                    logger.debug(
                        f"Has pending tool results detected: tool_call_ids={pending_tool_result_ids}, thread_id={input_data.thread_id}"
                    )

            # Rule 8: suppress ToolCallStart/Args/End for resumed tool-bound
            # interrupts — only ToolCallResult should be emitted on resume.
            if _resumed_tool_call_ids:
                pending_tool_result_ids.update(_resumed_tool_call_ids)

            # Convert AG-UI messages to Strands format
            # Strands expects content as List[ContentBlock] for most messages
            # OpenAI requires tool messages to follow assistant messages with tool_calls
            strands_messages = []
            last_msg_had_tool_calls = False
            expected_tool_call_ids = set()  # Track which tool_call_ids are valid

            logger.debug(
                f"Converting {len(input_data.messages)} messages to Strands format, thread_id={input_data.thread_id}"
            )

            for i, msg in enumerate(input_data.messages):
                logger.debug(
                    f"Message {i}: role={msg.role}, has_tool_calls={hasattr(msg, 'tool_calls') and bool(msg.tool_calls)}, tool_call_id={getattr(msg, 'tool_call_id', None)}"
                )
                strands_msg: Dict[str, Any] = {"role": msg.role}

                # Handle assistant messages with tool_calls
                if (
                    msg.role == "assistant"
                    and hasattr(msg, "tool_calls")
                    and msg.tool_calls
                ):
                    # Convert tool calls to format expected by Strands/OpenAI
                    strands_msg["content"] = []
                    if msg.content:
                        if isinstance(msg.content, str):
                            strands_msg["content"].append({"text": msg.content})
                        elif isinstance(msg.content, list):
                            strands_msg["content"] = msg.content

                    strands_msg["tool_calls"] = []
                    expected_tool_call_ids.clear()  # Reset for this assistant message
                    for tc in msg.tool_calls:
                        expected_tool_call_ids.add(tc.id)  # Track this tool call ID
                        strands_msg["tool_calls"].append(
                            {
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.function.get("name")
                                    if isinstance(tc.function, dict)
                                    else tc.function.name,
                                    "arguments": tc.function.get("arguments")
                                    if isinstance(tc.function, dict)
                                    else tc.function.arguments,
                                },
                            }
                        )
                    last_msg_had_tool_calls = True
                    strands_messages.append(strands_msg)

                # Handle tool messages (must follow assistant message with tool_calls)
                elif msg.role == "tool":
                    # Skip tool messages that don't have a preceding assistant message
                    # with tool_calls — UNLESS this is a pending frontend tool result
                    # (delta-only payloads only contain the tool result, so the
                    # assistant message is absent but the result is still valid).
                    is_pending_frontend_result = (
                        msg.tool_call_id in pending_tool_result_ids
                    )
                    if (
                        not last_msg_had_tool_calls
                        or msg.tool_call_id not in expected_tool_call_ids
                    ) and not is_pending_frontend_result:
                        logger.debug(
                            f"Skipping orphaned tool message: tool_call_id={msg.tool_call_id}, last_msg_had_tool_calls={last_msg_had_tool_calls}, valid_ids={expected_tool_call_ids}, thread_id={input_data.thread_id}"
                        )
                        continue

                    # Include the tool message for OpenAI format compliance
                    strands_msg["tool_call_id"] = msg.tool_call_id
                    if isinstance(msg.content, str):
                        strands_msg["content"] = [{"text": msg.content}]
                    else:
                        strands_msg["content"] = msg.content

                    expected_tool_call_ids.discard(msg.tool_call_id)
                    if not expected_tool_call_ids:
                        last_msg_had_tool_calls = False
                    strands_messages.append(strands_msg)

                # Handle regular messages (user, assistant without tool_calls)
                else:
                    if isinstance(msg.content, str):
                        strands_msg["content"] = [{"text": msg.content}]
                    elif isinstance(msg.content, list):
                        strands_msg["content"] = msg.content
                    else:
                        strands_msg["content"] = [{"text": ""}]
                    last_msg_had_tool_calls = False
                    strands_messages.append(strands_msg)

            # Build a lookup of tool_call_id -> tool_name from the input messages
            # directly (the assistant message in Run 2 already carries the name).
            _tool_call_id_to_name: dict = {}
            for _msg in (input_data.messages or []):
                if _msg.role == "assistant" and hasattr(_msg, "tool_calls") and _msg.tool_calls:
                    for tc in _msg.tool_calls:
                        tc_name = tc.function.get("name") if isinstance(tc.function, dict) else tc.function.name
                        if tc.id and tc_name:
                            _tool_call_id_to_name[tc.id] = tc_name

            # On delta-only continuation payloads, the assistant message that
            # carries the tool_call is absent from input_data.messages, so the
            # lookup above misses. The session manager still holds the full
            # native history — scan its ``toolUse`` blocks so we resolve the
            # tool that actually executed rather than guessing.
            for _smsg in session_msgs:
                if not isinstance(_smsg, dict) or _smsg.get("role") != "assistant":
                    continue
                for _block in (_smsg.get("content") or []):
                    tool_use = _block.get("toolUse") if isinstance(_block, dict) else None
                    if tool_use:
                        tu_id = tool_use.get("toolUseId")
                        tu_name = tool_use.get("name")
                        if tu_id and tu_name and tu_id not in _tool_call_id_to_name:
                            _tool_call_id_to_name[tu_id] = tu_name

            # Get the latest user message for state context builder.
            # For continuation runs (has_pending_tool_result), derive a meaningful
            # message from the frontend tool that was just executed so the agent
            # understands the context and can generate a proper conclusion.
            # Skip derivation on the interrupt resume path — _resume_prompt is used instead.
            user_message: Any = ""
            if _resume_prompt is not None:
                # Resume path: pass interruptResponse dicts directly to Strands.
                user_message = _resume_prompt
            elif pending_tool_result_ids and input_data.messages:
                # Collect ALL trailing tool results (not just the first). A parallel
                # frontend-tool turn sends N results in one continuation run; the model
                # must see every answer.
                _result_parts: list[str] = []
                for msg in reversed(input_data.messages):
                    if msg.role == "tool" and hasattr(msg, "tool_call_id"):
                        tool_name = _tool_call_id_to_name.get(msg.tool_call_id)
                        if tool_name and tool_name in frontend_tool_names:
                            # Forward the ACTUAL result so the model can act on the
                            # human's decision (e.g. an approval resolving to
                            # {"approved": false}). Hardcoding a success string here
                            # silently breaks HITL — the model would be told the tool
                            # "executed successfully with no return value" regardless
                            # of what the human returned. Only use that synthetic
                            # acknowledgement when the result is genuinely empty.
                            result_text = (
                                msg.content
                                if isinstance(msg.content, str)
                                else flatten_content_to_text(msg.content)
                            )
                            if result_text and result_text.strip():
                                _result_parts.append(f"{tool_name} returned: {result_text}")
                            else:
                                _result_parts.append(
                                    f"{tool_name} executed successfully with no return value."
                                )
                        else:
                            # Could not resolve this tool's name from input messages
                            # or session history (e.g. a delta-only payload with no
                            # assistant tool_calls). Skip it rather than guessing:
                            # picking an arbitrary frontend tool would feed false
                            # context to the LLM when several frontend tools exist.
                            # Strands still has the real result in session history to
                            # conclude the round-trip from.
                            logger.warning(
                                f"Could not resolve tool name for tool_call_id={msg.tool_call_id} "
                                f"from input messages or session history (delta-only payload). "
                                f"Skipping this tool result in the continuation message."
                            )
                    else:
                        break
                user_message = "\n".join(reversed(_result_parts))
            elif input_data.messages:
                for msg in reversed(input_data.messages):
                    if (msg.role == "user" or msg.role == "tool") and msg.content:
                        if isinstance(msg.content, list):
                            has_media = any(
                                getattr(item, "type", None) in ("image", "audio", "video", "document")
                                for item in msg.content
                            )
                            if has_media:
                                user_message = convert_agui_content_to_strands(msg.content)
                                if not user_message:
                                    # All content blocks failed conversion — fall back to text
                                    user_message = flatten_content_to_text(msg.content) or ""
                                    logger.warning("All media content blocks failed conversion, falling back to text")
                            else:
                                user_message = flatten_content_to_text(msg.content)
                        else:
                            user_message = msg.content
                        break

            # Optionally allow configuration to adjust the outgoing user message
            if self.config.state_context_builder:
                try:
                    text_for_builder = flatten_content_to_text(user_message) if isinstance(user_message, list) else user_message
                    builder_result = self.config.state_context_builder(
                        input_data, text_for_builder
                    )
                    if not isinstance(user_message, list):
                        user_message = builder_result
                    else:
                        logger.debug("state_context_builder result not applied to multimodal message — multimodal content preserved")
                    # If state_context_builder modifies the message, update the last user message
                    if not isinstance(user_message, list) and strands_messages and strands_messages[-1]["role"] == "user":
                        strands_messages[-1]["content"] = [{"text": user_message}]
                except Exception as e:
                    # If the builder fails, keep the original message
                    logger.warning(f"State context builder failed: {e}", exc_info=True)

            # Generate unique message ID
            message_id = str(uuid.uuid4())
            message_started = False
            accumulated_text = ""
            # Tracks the latest assistant text id that was actually emitted on
            # the wire. Tool calls use it only when no snapshot will expose the
            # tool-call AssistantMessage id.
            last_emitted_text_message_id: str | None = None
            tool_calls_seen = {}
            # Tool calls made by a sub-agent running as a tool (issue #2304).
            # Kept separate from ``tool_calls_seen`` so inner calls never take
            # part in parent-level result lookup, snapshotting or halt logic.
            inner_tool_calls_seen: Dict[str, Dict[str, Any]] = {}
            current_state = dict(input_data.state or {})  # Track state for final snapshot
            stop_text_streaming = False
            halt_event_stream = False
            pending_halt = False
            # Frontend-tool ToolCallEnd ids are buffered here so the client's
            # "execute this frontend tool" signal is delayed until AFTER this
            # turn's backend tool results have been emitted. This prevents the
            # client dispatching its follow-up run before the backend results
            # reach it, narrowing the ConcurrencyException race window.
            deferred_frontend_tool_ends = []
            # Native ``toolUseId``s whose ``toolResult`` was processed this
            # run. Drained after each result batch to prune the persisted
            # tool-call meta map.
            processed_result_native_ids: set[str] = set()
            # Terminal ``AgentResult`` from Strands (carried on the final
            # ``{"result": ...}`` stream event). Used after the loop to detect a
            # native interrupt pause (``stop_reason == "interrupt"``).
            terminal_result = None
            # ``force_stop`` is an abnormal terminal signal. Keep consuming the
            # stream so Strands can unwind and raise its underlying exception,
            # then translate the failure into AG-UI's terminal error event.
            force_stop_error: str | None = None
            pending_interrupt_outcome: RunFinishedInterruptOutcome | None = None

            # Reasoning/thinking state tracking
            reasoning_started = False
            reasoning_message_id = None

            logger.debug(
                f"Starting agent run: thread_id={input_data.thread_id}, run_id={input_data.run_id}, pending_tool_result_ids={pending_tool_result_ids}, message_count={len(input_data.messages)}, strands_message_count={len(strands_messages)}"
            )

            # Collect the real results the client produced for proxied
            # frontend tools. These arrive in ``RunAgentInput.messages`` on the
            # continuation run and are used to reconcile the session-persisted
            # "Forwarded to client" placeholder. A tool result is a frontend
            # result when its tool name is client-declared, or (for delta-only
            # payloads that omit the assistant message) when its wire id was
            # recorded in the wire->native map when the call was emitted.
            # The durable wire->native map recorded at emission, read back from
            # session state (restored from the store on a fresh process).
            wire_to_native: Dict[str, str] = {}
            reconciliation_setup_error: Exception | None = None
            if session_manager is not None:
                try:
                    wire_to_native = (
                        strands_agent.state.get(AG_UI_WIRE_MAP_STATE_KEY) or {}
                    )
                except Exception as e:  # noqa: BLE001 - handled below by checkpoint state
                    reconciliation_setup_error = e

            # The durable per-``toolUseId`` call metadata map recorded at
            # emission (see the ``current_tool_use`` handler). On a RESUME
            # run this is the ONLY source of ``{name, args, input,
            # strands_tool_id}`` for the interrupted tool, since Strands does
            # not re-emit ``current_tool_use`` events for it. Guarded because
            # test doubles / stub agents may lack ``state`` entirely; a
            # missing store just means "no persisted meta yet".
            persisted_tool_call_meta: Dict[str, Dict[str, Any]] = {}
            _agent_state = getattr(strands_agent, "state", None)
            if _agent_state is not None:
                try:
                    persisted_tool_call_meta = (
                        _agent_state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY) or {}
                    )
                except Exception as e:  # noqa: BLE001 - handled by checkpoint state
                    if has_active_interrupt:
                        if reconciliation_setup_error is None:
                            reconciliation_setup_error = e
                    else:
                        logger.warning(
                            "Persisted tool-call metadata is unavailable; "
                            "continuing without historical callback metadata: %s",
                            e,
                            exc_info=True,
                        )

            # Scope to the TRAILING tool results (this continuation's just-
            # returned results). ``pending_tool_result_ids`` holds those ids;
            # without this, a multi-turn continuation re-sends already-reconciled
            # historical results, which can never be re-corrected and would force
            # the legacy fallback every turn.
            frontend_results: List[Dict[str, Any]] = []
            for msg in (input_data.messages or []):
                if getattr(msg, "role", None) != "tool":
                    continue
                wire_id = getattr(msg, "tool_call_id", None)
                if not wire_id or wire_id not in pending_tool_result_ids:
                    continue
                name = _tool_call_id_to_name.get(wire_id)
                if name not in frontend_tool_names and wire_id not in wire_to_native:
                    continue
                content = msg.content
                text = (
                    content
                    if isinstance(content, str)
                    else flatten_content_to_text(content)
                )
                frontend_results.append(
                    {
                        "wire_id": wire_id,
                        "text": text or "",
                        # Carry the client's failure signal alongside the text so
                        # reconciliation can stamp the persisted toolResult status
                        # too, not just its content.
                        "is_error": bool(getattr(msg, "error", None)),
                    }
                )

            # Translate the client's wire tool_call_id back to the native
            # toolUseId Strands persisted (they differ for frontend tools — see
            # the fresh-uuid assignment in the streaming loop). Only reconcile
            # when there is at least one NON-EMPTY frontend result: a void tool
            # returns nothing, and the synthetic "executed successfully with no
            # return value" continuation message conveys that better than an
            # empty toolResult. A failed void result is the exception: it must
            # reconcile so its status replaces the proxy's hardcoded success.
            # When reconciling, void placeholders in the same
            # turn are still cleared (to "") so the literal "Forwarded to client"
            # is never fed to the model.
            resolved_native_results: Dict[str, Tuple[str, bool]] = {}
            corrected_native_ids: set[str] = set()
            has_nonvoid_frontend_result = any(
                (r["text"] or "").strip() or r["is_error"] for r in frontend_results
            )
            if reconciliation_setup_error is None and session_manager is not None and (
                self.config.replay_history_into_strands
                or (resume_submitted and bool(active_proxy_native_ids))
            ):
                try:
                    resolved_native_results = resolve_native_ids(
                        wire_to_native, frontend_results
                    )
                except Exception as e:  # noqa: BLE001 - handled below by checkpoint state
                    reconciliation_setup_error = e

            if reconciliation_setup_error is not None:
                if has_active_interrupt:
                    logger.error(
                        "Active interrupt tool result reconciliation failed",
                        exc_info=reconciliation_setup_error,
                    )
                    yield _interrupt_reconciliation_error()
                    return
                logger.warning(
                    "Frontend tool result reconciliation failed; falling back to "
                    f"the legacy continuation path: {reconciliation_setup_error}",
                    exc_info=reconciliation_setup_error,
                )

            # Resuming clears the parked context. Every exact proxy placeholder
            # in that context therefore needs a mapped client result before
            # repository or live checkpoint mutation begins.
            if resume_submitted and active_proxy_native_ids:
                missing_active_results = (
                    active_proxy_native_ids - resolved_native_results.keys()
                )
                if missing_active_results:
                    logger.error(
                        "Active interrupt is missing mapped frontend results for "
                        "native ids %s",
                        sorted(missing_active_results),
                    )
                    yield _interrupt_reconciliation_error()
                    return

            # Reconcile Strands' internal conversation history with
            # ``RunAgentInput.messages``. Without this, frontend tool results
            # sent by the client never reach the LLM — Strands sees an open
            # ``toolUse`` from the prior turn and the LLM re-fires the same tool
            # every run, producing the "chart loops forever" symptom.
            #
            # No session manager: rebuild history in-memory and stream it.
            # With a session manager (which owns persistence): overwrite the
            # persisted placeholder toolResult(s) with the real client result
            # via the session repository, then continue from the corrected
            # native history — keeping a single source of truth rather than a
            # placeholder plus a synthetic "tool returned: X" message.
            replay_history = (
                self.config.replay_history_into_strands and session_manager is None
            )
            # A native-only live checkpoint needs no repository access. Exact
            # proxy placeholders do, including when the client result is void.
            reconcile_session_results = (
                reconciliation_setup_error is None
                and _supports_repository_reconciliation(session_manager, strands_agent)
                and (
                    (
                        self.config.replay_history_into_strands
                        and (
                            has_nonvoid_frontend_result
                            or bool(active_proxy_native_ids)
                        )
                    )
                    or (resume_submitted and bool(active_proxy_native_ids))
                )
            )

            # Default prompt: the legacy path, passing only the latest user
            # message and trusting Strands (via session_manager) to track
            # history. Each branch below may narrow this further; a resume run
            # can carry BOTH a fresh frontend tool result and an interrupt
            # response in the same batch, so the resume-entries translation
            # below runs unconditionally after the other branches and layers
            # on top, rather than short-circuiting them.
            resume_prompt: str | List[Dict[str, Any]] | list[InterruptResponseContent] | None = user_message
            if replay_history:
                native_history = _build_strands_history(input_data.messages)
                # Apply ``state_context_builder`` to the last user-text
                # message in the reconciled history rather than to the
                # synthetic ``user_message`` string. This matches what the
                # builder is actually trying to enrich (the prompt the LLM
                # will see).
                if self.config.state_context_builder and native_history:
                    for native_msg in reversed(native_history):
                        if (
                            native_msg.get("role") == "user"
                            and native_msg.get("content")
                            and isinstance(native_msg["content"], list)
                            and "text" in native_msg["content"][0]
                        ):
                            try:
                                augmented = self.config.state_context_builder(
                                    input_data, native_msg["content"][0]["text"]
                                )
                                if isinstance(augmented, str):
                                    native_msg["content"][0]["text"] = augmented
                            except Exception as e:
                                logger.warning(
                                    f"state_context_builder failed: {e}", exc_info=True
                                )
                            break
                preserve_live_interrupt_history = (
                    resume_submitted and has_active_interrupt and is_delta_payload
                )
                if not preserve_live_interrupt_history:
                    strands_agent.messages = native_history
                # ``None`` tells Strands to use existing ``self.messages`` as-is.
                # The LLM sees real tool results (including ones produced by the
                # frontend) and emits a proper follow-up turn instead of
                # re-calling the tool.
                resume_prompt = None
            elif reconcile_session_results:
                try:
                    corrected_native_ids = reconcile_frontend_tool_results(
                        session_manager, strands_agent, resolved_native_results
                    )
                except Exception as e:  # noqa: BLE001 — degrade, don't crash the turn
                    if has_active_interrupt:
                        logger.error(
                            "Active interrupt tool result reconciliation failed",
                            exc_info=True,
                        )
                        yield _interrupt_reconciliation_error()
                        return
                    logger.warning(
                        "Frontend tool result reconciliation failed; falling back to "
                        f"the legacy continuation path: {e}",
                        exc_info=True,
                    )
                missing_corrections = active_proxy_native_ids - corrected_native_ids
                if missing_corrections:
                    logger.error(
                        "Active interrupt frontend results were not corrected for "
                        "native ids %s",
                        sorted(missing_corrections),
                    )
                    yield _interrupt_reconciliation_error()
                    return
                # Continue from the corrected native history only when every
                # NON-EMPTY frontend result this turn resolved to a native id
                # (i.e. was present in the wire->native map) AND none of those
                # placeholders remain uncleared. The scan is scoped to this
                # turn's results so a stale placeholder from a prior (e.g. void)
                # turn doesn't force the legacy path. Any shortfall means
                # forwarding the real result as a synthetic user message is
                # safer than replaying a stub.
                non_void_results = [
                    r for r in frontend_results if (r["text"] or "").strip()
                ]
                resolved_non_void = {
                    native
                    for native, (text, _is_error) in resolved_native_results.items()
                    if (text or "").strip()
                }
                all_non_void_resolved = len(resolved_non_void) == len(non_void_results)
                # Scan all of this turn's resolved native ids (void included, so a
                # resolved-but-uncleared void placeholder also blocks) — but not
                # unrelated historical placeholders.
                reconciled = all_non_void_resolved and not has_placeholder_results(
                    getattr(strands_agent, "messages", None) or [],
                    only_ids=set(resolved_native_results),
                )
                resume_prompt = None if reconciled else user_message

            # A client answering to an interrupt sends its responses
            # in ``RunAgentInput.resume`` (as per the AG-UI interrupt round-trip),
            # not as a new user message. Translate those into the Strands resume
            # prompt shape ``[{"interruptResponse": {"interruptId", "response"}}]``
            # and drive the stream with it — this runs after (and takes
            # precedence over) every branch above, since a resume batch may
            # still carry a fresh frontend tool result that needed reconciling.
            if resume_submitted:
                resume_prompt = _resume_prompt

            # Drop only the entries whose placeholder was actually corrected
            # this turn — they won't recur. Entries that were NOT corrected
            # (unresolved, or a reconcile that raised) are kept so a later turn
            # can retry; pruning them would strand the persisted placeholder
            # forever. (Genuinely-abandoned entries are bounded by the size cap
            # applied at emission.)
            if wire_to_native and corrected_native_ids:
                remaining = {
                    wire: native
                    for wire, native in wire_to_native.items()
                    if native not in corrected_native_ids
                }
                if len(remaining) != len(wire_to_native):
                    strands_agent.state.set(AG_UI_WIRE_MAP_STATE_KEY, remaining)

            agent_stream = strands_agent.stream_async(resume_prompt)
            try:
                async for event in agent_stream:
                    # Capture the terminal ``AgentResult`` (always emitted last
                    # by ``stream_async``) so a native interrupt pause can be
                    # detected after the loop. Recorded first so it is never
                    # dropped, even on the halt-event-stream break below.
                    if "result" in event and event["result"] is not None:
                        terminal_result = event["result"]

                    # Frontend-tool halt: STOP the loop rather than muting the
                    # wire and draining it. The proxy tool returns a SUCCESSFUL
                    # "Forwarded to client" placeholder, so Strands has every
                    # reason to run another model cycle — and another. Draining
                    # those cycles costs: frontend tool calls the client never
                    # sees (so it can never answer them), real backend tool
                    # side effects, phantom assistant turns persisted to the
                    # session store, and RUN_FINISHED stuck behind work the
                    # client is not watching. Single-agent Strands has no cycle
                    # cap, so that tail is unbounded — a model that keeps
                    # retrying the read never yields a terminal event at all.
                    #
                    # Safe here because the halt latches only AFTER Strands
                    # appended the assistant toolUse + placeholder toolResult
                    # and MessageAddedEvent synced agent state (see
                    # SessionManager.register_hooks), so the next run's
                    # reconcile still finds a placeholder to overwrite and the
                    # wire->native map to key it by.
                    if halt_event_stream:
                        break

                    logger.debug(f"Received event: {event}")

                    # Skip lifecycle events. ``start`` is Strands' deprecated
                    # alias of ``start_event_loop`` and is emitted alongside it;
                    # listing it keeps the pair consistent so one half of a
                    # duplicate does not surface as a RAW event.
                    if (
                        event.get("init_event_loop")
                        or event.get("start_event_loop")
                        or event.get("start")
                    ):
                        continue
                    # ``force_stop`` means Strands caught an exception mid-cycle.
                    # It is a failed run, not assistant-authored content or a
                    # successful finish. Continue once more so Strands can raise
                    # the underlying exception and unwind the generator cleanly.
                    if event.get("force_stop"):
                        raw_reason = str(event.get("force_stop_reason", "")).strip()
                        force_stop_error = (
                            raw_reason or "The Strands agent stopped unexpectedly."
                        )
                        logger.error(
                            "Agent stream force-stopped (thread_id=%s, reason=%s)",
                            input_data.thread_id,
                            force_stop_error,
                        )
                        continue

                    # Legacy terminator from pre-typed-events Strands.
                    if event.get("complete"):
                        logger.debug(
                            f"Breaking event stream: complete received (thread_id={input_data.thread_id})"
                        )
                        break

                    # Modern Strands emits AgentResultEvent last. Consume the
                    # generator to exhaustion after handling it so its cleanup
                    # and trace finalizers run before AG-UI reports completion.
                    if "result" in event:
                        result = event["result"]
                        if result is not None:
                            stop_reason = getattr(result, "stop_reason", None)
                            logger.info(
                                "agent_result: thread_id=%s stop_reason=%s",
                                input_data.thread_id,
                                stop_reason,
                            )
                            # Surface non-normal stops to the client as a CustomEvent
                            # so a UI can render a hint (truncated / filtered / etc.).
                            # end_turn and tool_use are the normal stops — no event.
                            if stop_reason in (
                                "max_tokens",
                                "guardrail_intervened",
                                "content_filtered",
                            ):
                                yield CustomEvent(
                                    type=EventType.CUSTOM,
                                    name="AgentStopped",
                                    value={"stop_reason": stop_reason},
                                )
                        continue  # never yield the raw result event

                    # Handle text streaming
                    if "data" in event and event["data"]:
                        if stop_text_streaming:
                            continue

                        if not message_started:
                            yield TextMessageStartEvent(
                                type=EventType.TEXT_MESSAGE_START,
                                message_id=message_id,
                                role="assistant",
                            )
                            message_started = True
                            last_emitted_text_message_id = message_id

                        text_chunk = str(event["data"])
                        accumulated_text += text_chunk
                        yield TextMessageContentEvent(
                            type=EventType.TEXT_MESSAGE_CONTENT,
                            message_id=message_id,
                            delta=text_chunk,
                        )

                    # Handle reasoning/thinking text streaming
                    elif "reasoningText" in event and event.get("reasoning"):
                        reasoning_text = event["reasoningText"]

                        if not reasoning_started:
                            reasoning_message_id = str(uuid.uuid4())

                            # Emit reasoning events
                            yield ReasoningStartEvent(
                                type=EventType.REASONING_START,
                                message_id=reasoning_message_id
                            )
                            yield ReasoningMessageStartEvent(
                                type=EventType.REASONING_MESSAGE_START,
                                message_id=reasoning_message_id,
                                role="reasoning"
                            )
                            reasoning_started = True

                        # Stream reasoning content
                        if reasoning_text:
                            yield ReasoningMessageContentEvent(
                                type=EventType.REASONING_MESSAGE_CONTENT,
                                message_id=reasoning_message_id,
                                delta=reasoning_text
                            )

                    # Handle encrypted/redacted reasoning content
                    elif "reasoningRedactedContent" in event and event.get("reasoning"):
                        redacted_content = event["reasoningRedactedContent"]

                        if redacted_content is None:
                            logger.debug(f"Ignoring reasoning event with None redacted content (thread_id={input_data.thread_id})")
                            continue

                        if not reasoning_started:
                            reasoning_message_id = str(uuid.uuid4())
                            yield ReasoningStartEvent(
                                type=EventType.REASONING_START,
                                message_id=reasoning_message_id
                            )
                            yield ReasoningMessageStartEvent(
                                type=EventType.REASONING_MESSAGE_START,
                                message_id=reasoning_message_id,
                                role="reasoning"
                            )
                            reasoning_started = True

                        # Encode bytes to base64 string for transport
                        if isinstance(redacted_content, bytes):
                            encrypted_value = base64.b64encode(redacted_content).decode()
                        elif isinstance(redacted_content, str):
                            encrypted_value = redacted_content
                        else:
                            logger.warning(f"Unexpected type for reasoningRedactedContent: {type(redacted_content)}, converting to str")
                            encrypted_value = str(redacted_content)

                        yield ReasoningEncryptedValueEvent(
                            type=EventType.REASONING_ENCRYPTED_VALUE,
                            subtype="message",
                            entity_id=reasoning_message_id,
                            encrypted_value=encrypted_value
                        )

                    # Handle reasoning signature (verification token) - typically not exposed to UI
                    elif "reasoning_signature" in event and event.get("reasoning"):
                        sig = event.get("reasoning_signature", "")
                        logger.debug(f"Received reasoning signature: {str(sig)[:20]}...")

                    # Handle multi-agent node start (maps to STEP_STARTED)
                    elif isinstance(event, dict) and event.get("type") == "multiagent_node_start":
                        node_id = event.get("node_id", "unknown")
                        node_type = event.get("node_type", "agent")
                        yield StepStartedEvent(
                            type=EventType.STEP_STARTED,
                            step_name=f"{node_type}:{node_id}"
                        )

                    # Handle multi-agent node stop (maps to STEP_FINISHED)
                    elif isinstance(event, dict) and event.get("type") == "multiagent_node_stop":
                        node_id = event.get("node_id", "unknown")
                        node_type = event.get("node_type", "agent")
                        yield StepFinishedEvent(
                            type=EventType.STEP_FINISHED,
                            step_name=f"{node_type}:{node_id}"
                        )

                    # Handle multi-agent handoff (emit as CUSTOM event)
                    elif isinstance(event, dict) and event.get("type") == "multiagent_handoff":
                        yield CustomEvent(
                            type=EventType.CUSTOM,
                            name="MultiAgentHandoff",
                            value={
                                "from_nodes": event.get("from_node_ids", []),
                                "to_nodes": event.get("to_node_ids", []),
                                "message": event.get("message")
                            }
                        )

                    # Handle tool streaming events for real-time state updates
                    # Strands tools can yield intermediate results as tool_stream_event
                    elif "tool_stream_event" in event:
                        tool_stream = event["tool_stream_event"]
                        stream_data = tool_stream.get("data", {})
                        _tse_tool_use = tool_stream.get("tool_use", {})
                        _tse_tool_name = _tse_tool_use.get("name", "")
                        _tse_tool_use_id = _tse_tool_use.get("toolUseId")

                        # A2UI sub-agent streaming: re-emit the
                        # generate_a2ui tool's inner render_a2ui progress as
                        # synthetic TOOL_CALL events. The a2ui middleware's
                        # streaming path keys its "building" skeleton +
                        # progressive paint off these — without them the
                        # surface only paints in bulk from the final result.
                        # This path is keyed off A2UI_STREAM_KEY in the
                        # payload, not the tool's toolUseId, so it must run
                        # even when toolUseId is absent.
                        if (
                            isinstance(stream_data, dict)
                            and isinstance(stream_data.get(A2UI_STREAM_KEY), dict)
                        ):
                            a2ui_ev = stream_data[A2UI_STREAM_KEY]
                            kind = a2ui_ev.get("kind")
                            a2ui_call_id = a2ui_ev.get("tool_call_id", "")
                            if kind == "start":
                                yield ToolCallStartEvent(
                                    type=EventType.TOOL_CALL_START,
                                    tool_call_id=a2ui_call_id,
                                    tool_call_name=a2ui_ev.get(
                                        "tool_call_name", "render_a2ui"
                                    ),
                                )
                            elif kind == "args" and a2ui_ev.get("delta"):
                                yield ToolCallArgsEvent(
                                    type=EventType.TOOL_CALL_ARGS,
                                    tool_call_id=a2ui_call_id,
                                    delta=a2ui_ev["delta"],
                                )
                            elif kind == "end":
                                yield ToolCallEndEvent(
                                    type=EventType.TOOL_CALL_END,
                                    tool_call_id=a2ui_call_id,
                                )
                        elif _tse_tool_use_id is None:
                            logger.debug(
                                "tool_stream_event missing toolUseId — skipping handler dispatch"
                            )
                        else:
                            _tse_behavior = self.config.tool_behaviors.get(_tse_tool_name) if _tse_tool_name else None

                            if _tse_behavior and _tse_behavior.tool_stream_event_handler:
                                _tse_ctx = ToolStreamEventContext(
                                    tool_use_id=_tse_tool_use_id,
                                    tool_name=_tse_tool_name,
                                    stream_data=stream_data,
                                )
                                try:
                                    async for _tse_event in _tse_behavior.tool_stream_event_handler(
                                        _tse_ctx
                                    ):
                                        if _tse_event is not None:
                                            yield _tse_event
                                except Exception as _tse_exc:
                                    logger.warning(
                                        f"tool_stream_event_handler failed for {_tse_tool_name}: {_tse_exc}",
                                        exc_info=True,
                                    )
                            elif isinstance(stream_data, dict) and "state" in stream_data:
                                # Default behaviour: emit state snapshot when tool yields {"state": ...}
                                yield StateSnapshotEvent(
                                    type=EventType.STATE_SNAPSHOT,
                                    snapshot=stream_data["state"],
                                )
                            else:
                                # Agent-as-tool: a generator tool wrapping another
                                # Agent re-yields that agent's own stream_async events
                                # here. Forward the inner tool-call lifecycle so the
                                # sub-agent isn't an opaque black box (issue #2304).
                                # Reached only when no explicit handler claimed the
                                # payload and it is not a state snapshot.
                                async for inner_agui_event in _forward_inner_agent_events(
                                    stream_data,
                                    tool_stream.get("tool_use") or {},
                                    inner_tool_calls_seen,
                                ):
                                    yield inner_agui_event

                    # Handle tool results from Strands for backend tool rendering
                    elif "message" in event and event["message"].get("role") == "user":
                        # A deferred frontend-tool halt takes effect here — but
                        # do NOT skip the message. In a parallel batch mixing a
                        # frontend tool with backend tools, THIS message carries
                        # the backend tools' real results, and dropping it loses
                        # them permanently: the client's tool card never
                        # resolves, the result never reaches MESSAGES_SNAPSHOT
                        # (the only path into client-side history — the
                        # TOOL_CALL_RESULT below is deliberately role-less and
                        # is not history), and state_from_result /
                        # custom_result_handler never fire. Consumers that
                        # persist from the event stream then hold a transcript
                        # whose toolUse has no toolResult, which the next run
                        # replays straight to the model provider.
                        #
                        # Fall through instead: the per-item loop already skips
                        # frontend placeholders (the client produces the real
                        # result), so only genuine backend results go out. Stop
                        # after the batch, before the next model cycle.
                        if pending_halt:
                            halt_event_stream = True
                        message_content = event["message"].get("content", [])
                        if not message_content or not isinstance(message_content, list):
                            continue

                        for item in message_content:
                            if not isinstance(item, dict) or "toolResult" not in item:
                                continue

                            tool_result = item["toolResult"]
                            result_tool_id = tool_result.get("toolUseId")
                            result_content = tool_result.get("content", [])

                            result_data = None
                            if result_content and isinstance(result_content, list):
                                for content_item in result_content:
                                    if (
                                        isinstance(content_item, dict)
                                        and "text" in content_item
                                    ):
                                        text_content = content_item["text"]
                                        try:
                                            result_data = json.loads(text_content)
                                        except json.JSONDecodeError:
                                            try:
                                                json_text = text_content.replace(
                                                    "'", '"'
                                                )
                                                result_data = json.loads(json_text)
                                            except Exception:
                                                result_data = text_content

                            if not result_tool_id or result_data is None:
                                continue

                            # Direct lookup works for backend tools (keyed by Strands ID).
                            # Frontend tools are keyed by a generated UUID, so we fall back
                            # to scanning by strands_tool_id when the direct lookup misses.
                            call_info = tool_calls_seen.get(result_tool_id, {})
                            if not call_info:
                                for _tid, _data in tool_calls_seen.items():
                                    if _data.get("strands_tool_id") == result_tool_id:
                                        call_info = _data
                                        break
                            # RESUME-run fallback: the interrupted tool never
                            # re-emits ``current_tool_use`` on resume, so
                            # ``tool_calls_seen`` is empty for it. The
                            # persisted meta map was populated when the call
                            # was originally streamed (possibly in a prior
                            # process). Direct native-id first, then scan by
                            # ``strands_tool_id`` to match the frontend-tool
                            # case.
                            if not call_info:
                                call_info = persisted_tool_call_meta.get(
                                    result_tool_id, {}
                                )
                            if not call_info:
                                for _pdata in persisted_tool_call_meta.values():
                                    if (
                                        isinstance(_pdata, dict)
                                        and _pdata.get("strands_tool_id")
                                        == result_tool_id
                                    ):
                                        call_info = _pdata
                                        break
                            # Record consumption once the lookup is complete
                            # (even if it missed): the result was processed
                            # this turn, so any persisted entry keyed on this
                            # native id is safe to prune. Recording BEFORE the
                            # frontend-skip / behavior branches ensures a
                            # ``stop_streaming_after_result`` early break still
                            # flags this id for prune.
                            processed_result_native_ids.add(result_tool_id)
                            tool_name = call_info.get("name")
                            tool_args = call_info.get("args")
                            tool_input = call_info.get("input")
                            behavior = (
                                self.config.tool_behaviors.get(tool_name)
                                if tool_name
                                else None
                            )

                            logger.debug(
                                f"Processing tool result: tool_name={tool_name}, result_tool_id={result_tool_id}, pending_tool_result_ids={pending_tool_result_ids}, thread_id={input_data.thread_id}"
                            )

                            # Skip emitting the placeholder result for forwarded/proxy tools
                            # – the real execution happens on the client side.
                            if tool_name and tool_name in frontend_tool_names:
                                continue

                            # Emit ToolCallResultEvent WITHOUT role field to complete the tool in UI
                            # but prevent it from being added to conversation history.
                            # A fresh message ID is used so CopilotKit creates a proper standalone
                            # ToolMessage and closes the spinner correctly.
                            tool_result_message_id = str(uuid.uuid4())
                            tool_result_content = json.dumps(result_data)
                            yield ToolCallResultEvent(
                                type=EventType.TOOL_CALL_RESULT,
                                tool_call_id=result_tool_id,
                                message_id=tool_result_message_id,
                                content=tool_result_content,
                                # role is intentionally omitted - without role="tool",
                                # the frontend won't add this to conversation history
                            )

                            # Splice point 3 of 4: append the ToolMessage
                            # carrying the backend tool result to the
                            # running snapshot so the frontend can pair
                            # call + result in the message tree.
                            if (
                                emit_snapshots
                                and not (
                                    behavior
                                    and behavior.skip_messages_snapshot
                                )
                            ):
                                snapshot_messages.append(
                                    ToolMessage(
                                        id=tool_result_message_id,
                                        role="tool",
                                        content=tool_result_content,
                                        tool_call_id=result_tool_id,
                                    )
                                )
                                yield MessagesSnapshotEvent(
                                    type=EventType.MESSAGES_SNAPSHOT,
                                    messages=list(snapshot_messages),
                                )

                            result_context = ToolResultContext(
                                input_data=input_data,
                                tool_name=tool_name or "",
                                tool_use_id=result_tool_id,
                                tool_input=tool_input,
                                args_str=tool_args or "{}",
                                result_data=result_data,
                                message_id=message_id,
                            )

                            if behavior and behavior.state_from_result:
                                try:
                                    snapshot = await maybe_await(
                                        behavior.state_from_result(result_context)
                                    )
                                    if snapshot:
                                        current_state.update(snapshot)
                                        yield StateSnapshotEvent(
                                            type=EventType.STATE_SNAPSHOT,
                                            snapshot=snapshot,
                                        )
                                except Exception as e:
                                    logger.warning(
                                        f"state_from_result failed for {tool_name}: {e}",
                                        exc_info=True,
                                    )

                            if behavior and behavior.custom_result_handler:
                                try:
                                    async for (
                                        custom_event
                                    ) in behavior.custom_result_handler(result_context):
                                        if custom_event is not None:
                                            yield custom_event
                                except Exception as e:
                                    logger.warning(
                                        f"custom_result_handler failed for {tool_name}: {e}",
                                        exc_info=True,
                                    )

                            if behavior and behavior.stop_streaming_after_result:
                                stop_text_streaming = True
                                if message_started:
                                    yield TextMessageEndEvent(
                                        type=EventType.TEXT_MESSAGE_END,
                                        message_id=message_id,
                                    )
                                    message_started = False
                                    # Splice point 4 of 4 (early-exit
                                    # variant): commit any accumulated
                                    # assistant text into the snapshot.
                                    if (
                                        emit_snapshots
                                        and accumulated_text
                                    ):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content=accumulated_text,
                                            )
                                        )
                                        accumulated_text = ""
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                halt_event_stream = True
                                logger.debug(
                                    f"Breaking event stream: stop_streaming_after_result behavior triggered (thread_id={input_data.thread_id}, tool_name={tool_name})"
                                )
                                # Break inner loop — no further results should be emitted
                                break

                        # Prune the persisted tool-call meta map for entries
                        # whose native id (or ``strands_tool_id`` for frontend
                        # tools stored under a wire key) was just consumed.
                        # The emission-time size cap (``_TOOL_CALL_MAP_MAX``) is
                        # only a backstop for abandoned entries.
                        if (
                            persisted_tool_call_meta
                            and processed_result_native_ids
                        ):
                            _remaining = {
                                _k: _v
                                for _k, _v in persisted_tool_call_meta.items()
                                if _k not in processed_result_native_ids
                                and (
                                    not isinstance(_v, dict)
                                    or _v.get("strands_tool_id")
                                    not in processed_result_native_ids
                                )
                            }
                            if len(_remaining) != len(persisted_tool_call_meta):
                                strands_agent.state.set(
                                    AG_UI_TOOL_CALL_MAP_STATE_KEY, _remaining
                                )
                                persisted_tool_call_meta = _remaining
                        processed_result_native_ids.clear()

                        # Defer hand-off: now that this turn's backend
                        # TOOL_CALL_RESULT(s) have been emitted above, flush the
                        # buffered frontend-tool ToolCallEnd(s). Flushing here —
                        # after the per-item loop and before the halt break below —
                        # guarantees the wire order backend TOOL_CALL_RESULT ->
                        # frontend TOOL_CALL_END, so the client only starts the
                        # frontend tool once backend work has reached it.
                        if deferred_frontend_tool_ends:
                            for _fe_tool_use_id in deferred_frontend_tool_ends:
                                yield ToolCallEndEvent(
                                    type=EventType.TOOL_CALL_END,
                                    tool_call_id=_fe_tool_use_id,
                                )
                            deferred_frontend_tool_ends = []

                        # The batch is fully emitted; stop before Strands runs
                        # another model cycle. Breaking HERE rather than relying
                        # on the check at the top of the loop means termination
                        # does not depend on Strands happening to yield one more
                        # event after this message.
                        if halt_event_stream:
                            break

                    # Handle tool calls
                    elif "current_tool_use" in event and event["current_tool_use"]:
                        tool_use = event["current_tool_use"]
                        tool_name = tool_use.get("name")
                        strands_tool_id = tool_use.get("toolUseId")
                        _raw_in = tool_use.get("input", "")

                        # Generate unique ID for frontend tools (to avoid ID conflicts across requests)
                        # Use Strands' ID for backend tools (so result lookup works)
                        is_frontend_tool = tool_name in frontend_tool_names

                        # Check if we've already seen this tool (by Strands' internal ID)
                        existing_entry = None
                        for tid, data in tool_calls_seen.items():
                            if data.get("strands_tool_id") == strands_tool_id:
                                existing_entry = tid
                                break

                        if existing_entry:
                            # Reuse the existing ID
                            tool_use_id = existing_entry
                        elif is_frontend_tool:
                            # Generate new UUID for frontend tools
                            tool_use_id = str(uuid.uuid4())
                            # Record wire id -> Strands native id on the agent's
                            # SESSION STATE so a later continuation run — even on
                            # a different process — can reconcile the persisted
                            # placeholder (keyed by the native id) with the real
                            # client result (which arrives keyed by the wire id).
                            # Strands persists agent state durably at end of run.
                            # Only maintained when a session manager is actually
                            # active for this agent (matching the continuation
                            # read/prune gate); otherwise it would never be read.
                            if strands_tool_id and _get_strands_session_manager(
                                strands_agent
                            ):
                                _wire_map = dict(
                                    strands_agent.state.get(AG_UI_WIRE_MAP_STATE_KEY)
                                    or {}
                                )
                                _wire_map[tool_use_id] = strands_tool_id
                                # Bound growth: entries for frontend calls that
                                # never get a client result (abandoned/dismissed
                                # HITL) are never consumed/pruned. Keep only the
                                # most-recent ``_WIRE_MAP_MAX`` (insertion order).
                                if len(_wire_map) > _WIRE_MAP_MAX:
                                    for _stale in list(_wire_map)[
                                        : len(_wire_map) - _WIRE_MAP_MAX
                                    ]:
                                        _wire_map.pop(_stale, None)
                                strands_agent.state.set(
                                    AG_UI_WIRE_MAP_STATE_KEY, _wire_map
                                )
                        else:
                            # Use Strands' ID for backend tools
                            tool_use_id = strands_tool_id or str(uuid.uuid4())

                        logger.debug(
                            f"Tool call event received: tool_name={tool_name}, tool_use_id={tool_use_id}, strands_id={strands_tool_id}, is_frontend={is_frontend_tool}, already_seen={tool_use_id in tool_calls_seen}, thread_id={input_data.thread_id}"
                        )

                        # Update tool input as it streams in
                        tool_input_raw = tool_use.get("input", "")

                        # Raw string form is what FE incrementally parses for
                        # predict_state. Use it as-is for delta computation so
                        # the wire stream matches what the LLM actually emitted.
                        raw_str = (
                            tool_input_raw
                            if isinstance(tool_input_raw, str)
                            else json.dumps(tool_input_raw, default=str)
                        )

                        # Try to parse as JSON if it looks complete
                        tool_input = {}
                        if isinstance(tool_input_raw, str) and tool_input_raw:
                            try:
                                tool_input = json.loads(tool_input_raw)
                            except json.JSONDecodeError:
                                # Input is still streaming, keep as string
                                tool_input = tool_input_raw
                        elif isinstance(tool_input_raw, dict):
                            tool_input = tool_input_raw

                        args_str = (
                            json.dumps(tool_input)
                            if isinstance(tool_input, dict)
                            else str(tool_input)
                        )

                        # Track or update tool call as input streams in
                        is_new_tool_call = (
                            tool_name and tool_use_id not in tool_calls_seen
                        )
                        if is_new_tool_call:
                            is_pending_now = tool_use_id in pending_tool_result_ids
                            behavior_now = self.config.tool_behaviors.get(tool_name)
                            # Use the streaming path (emit ToolCallStart +
                            # PredictState now, ToolCallArgs on each growth,
                            # ToolCallEnd at contentBlockStop) unless the tool
                            # is a continuation (already-resolved) or supplies
                            # a custom args_streamer that wants to drive args
                            # emission itself at contentBlockStop.
                            use_streaming = not is_pending_now and not (
                                behavior_now and behavior_now.args_streamer
                            )
                            tool_calls_seen[tool_use_id] = {
                                "name": tool_name,
                                "args": args_str,
                                "input": tool_input,
                                "raw": raw_str,
                                "emitted": False,  # legacy flag (still used by contentBlockStop scan)
                                "start_emitted": False,
                                "end_emitted": False,
                                "last_emitted_raw_len": 0,
                                "is_pending": is_pending_now,
                                "is_frontend": is_frontend_tool,
                                "use_streaming": use_streaming,
                                "strands_tool_id": strands_tool_id,
                            }

                            # Mirror the minimum-sufficient subset into live
                            # agent state. A SessionManager may persist it, but
                            # the cached core itself is the same-process native
                            # checkpoint and must restore callbacks without one.
                            _tc_meta = dict(
                                strands_agent.state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY)
                                or {}
                            )
                            # Key by the NATIVE ``toolUseId`` — that is what
                            # arrives on ``toolResult``. For backend tools
                            # this equals ``tool_use_id``; for frontend tools
                            # ``tool_use_id`` is a fresh wire UUID while
                            # ``strands_tool_id`` is native.
                            _tc_key = strands_tool_id or tool_use_id
                            _tc_meta[_tc_key] = {
                                "name": tool_name,
                                "args": args_str,
                                "input": tool_input,
                                "strands_tool_id": strands_tool_id,
                            }
                            if len(_tc_meta) > _TOOL_CALL_MAP_MAX:
                                for _stale in list(_tc_meta)[
                                    : len(_tc_meta) - _TOOL_CALL_MAP_MAX
                                ]:
                                    _tc_meta.pop(_stale, None)
                            strands_agent.state.set(
                                AG_UI_TOOL_CALL_MAP_STATE_KEY, _tc_meta
                            )
                            persisted_tool_call_meta = _tc_meta

                            if use_streaming:
                                # Close any open assistant text turn so the
                                # snapshot order matches the wire-event order
                                # and so message_id can rotate cleanly.
                                if message_started:
                                    yield TextMessageEndEvent(
                                        type=EventType.TEXT_MESSAGE_END,
                                        message_id=message_id,
                                    )
                                    if (
                                        emit_snapshots
                                        and accumulated_text
                                    ):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content=accumulated_text,
                                            )
                                        )
                                        accumulated_text = ""
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                    message_started = False
                                    message_id = str(uuid.uuid4())

                                # PredictState mapping must reach the FE BEFORE
                                # any args delta so the FE knows which tool
                                # argument feeds which state key while parsing
                                # incremental JSON.
                                if behavior_now:
                                    predict_state_payload = [
                                        mapping.to_payload()
                                        for mapping in normalize_predict_state(
                                            behavior_now.predict_state
                                        )
                                    ]
                                    if predict_state_payload:
                                        yield CustomEvent(
                                            type=EventType.CUSTOM,
                                            name="PredictState",
                                            value=predict_state_payload,
                                        )

                                # Must mirror the later tool snapshot emission condition.
                                tool_parent_message_id = (
                                    message_id
                                    if self._will_emit_tool_snapshot(behavior_now, emit_snapshots)
                                    else last_emitted_text_message_id
                                )
                                yield ToolCallStartEvent(
                                    type=EventType.TOOL_CALL_START,
                                    tool_call_id=tool_use_id,
                                    tool_call_name=tool_name,
                                    parent_message_id=tool_parent_message_id,
                                )
                                tool_calls_seen[tool_use_id]["start_emitted"] = True
                        elif tool_name and tool_use_id in tool_calls_seen:
                            # Update the input and args as they stream in
                            tool_calls_seen[tool_use_id]["input"] = tool_input
                            tool_calls_seen[tool_use_id]["args"] = args_str
                            tool_calls_seen[tool_use_id]["raw"] = raw_str

                            # Keep the persisted meta in sync with the final
                            # streamed args. Without this refresh, resume runs
                            # would see the first partial-JSON delta rather
                            # than the complete args the model emitted.
                            _tc_meta = dict(
                                strands_agent.state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY)
                                or {}
                            )
                            _tc_key = strands_tool_id or tool_use_id
                            _existing = _tc_meta.get(_tc_key)
                            if _existing is not None:
                                _existing["input"] = tool_input
                                _existing["args"] = args_str
                                strands_agent.state.set(
                                    AG_UI_TOOL_CALL_MAP_STATE_KEY, _tc_meta
                                )
                                persisted_tool_call_meta = _tc_meta

                        # Stream incremental ToolCallArgs deltas as the LLM
                        # produces more characters of the JSON args. The FE
                        # uses these to drive predictive state updates per the
                        # PredictState mapping that was just emitted.
                        entry = tool_calls_seen.get(tool_use_id)
                        if (
                            entry
                            and entry.get("start_emitted")
                            and entry.get("use_streaming")
                        ):
                            new_len = len(raw_str)
                            last_len = entry.get("last_emitted_raw_len", 0)
                            if new_len > last_len:
                                yield ToolCallArgsEvent(
                                    type=EventType.TOOL_CALL_ARGS,
                                    tool_call_id=tool_use_id,
                                    delta=raw_str[last_len:new_len],
                                )
                                entry["last_emitted_raw_len"] = new_len

                    # Handle content block stop - this signals tool input is complete
                    elif "event" in event and isinstance(event.get("event"), dict):
                        inner_event = event["event"]
                        if "contentBlockStop" in inner_event:
                            # Close reasoning events if active
                            if reasoning_started:
                                yield ReasoningMessageEndEvent(
                                    type=EventType.REASONING_MESSAGE_END,
                                    message_id=reasoning_message_id
                                )
                                yield ReasoningEndEvent(
                                    type=EventType.REASONING_END,
                                    message_id=reasoning_message_id
                                )
                                reasoning_started = False
                                reasoning_message_id = None

                            # Find the most recent tool call that hasn't been emitted yet
                            tool_name = None
                            tool_input = None
                            args_str = None
                            tool_use_id = None

                            for tid, tool_data in tool_calls_seen.items():
                                if not tool_data.get("emitted", True):
                                    tool_name = tool_data["name"]
                                    tool_input = tool_data["input"]
                                    args_str = tool_data["args"]
                                    tool_use_id = tid
                                    break  # Process one tool at a time

                            # Only process if we found a tool to emit
                            if tool_name and tool_use_id:
                                entry = tool_calls_seen[tool_use_id]
                                # Mark as emitted (legacy compat)
                                entry["emitted"] = True
                                entry["end_emitted"] = True

                                is_frontend_tool = entry.get("is_frontend", tool_name in frontend_tool_names)
                                behavior = self.config.tool_behaviors.get(tool_name)
                                is_pending = entry.get("is_pending", tool_use_id in pending_tool_result_ids)
                                use_streaming = entry.get("use_streaming", False)

                                logger.debug(
                                    f"contentBlockStop close: tool_name={tool_name}, tool_use_id={tool_use_id}, is_frontend_tool={is_frontend_tool}, is_pending={is_pending}, use_streaming={use_streaming}, thread_id={input_data.thread_id}"
                                )
                                call_context = ToolCallContext(
                                    input_data=input_data,
                                    tool_name=tool_name,
                                    tool_use_id=tool_use_id,
                                    tool_input=tool_input,
                                    args_str=args_str,
                                )

                                if use_streaming:
                                    # Streaming path: ToolCallStart, PredictState
                                    # and the args deltas have already been
                                    # emitted from the current_tool_use handler.
                                    # Flush any final delta the LLM tacked on
                                    # between the last current_tool_use update
                                    # and contentBlockStop, then close the call.
                                    raw_str = entry.get("raw", "") or ""
                                    last_len = entry.get("last_emitted_raw_len", 0)
                                    if len(raw_str) > last_len:
                                        yield ToolCallArgsEvent(
                                            type=EventType.TOOL_CALL_ARGS,
                                            tool_call_id=tool_use_id,
                                            delta=raw_str[last_len:],
                                        )
                                        entry["last_emitted_raw_len"] = len(raw_str)

                                    # Emit ``state_from_args`` BEFORE
                                    # ``ToolCallEnd``. CopilotKit v2 releases
                                    # the predict_state buffer at ToolCallEnd;
                                    # if the authoritative StateSnapshot lands
                                    # after that, the FE momentarily reverts
                                    # to the last server-confirmed state and
                                    # re-applies, producing a "re-stream"
                                    # animation. Delivering the snapshot first
                                    # means the FE has the real state in hand
                                    # at the moment prediction is released.
                                    if behavior and behavior.state_from_args:
                                        try:
                                            snapshot = await maybe_await(
                                                behavior.state_from_args(call_context)
                                            )
                                            if snapshot:
                                                current_state.update(snapshot)
                                                yield StateSnapshotEvent(
                                                    type=EventType.STATE_SNAPSHOT,
                                                    snapshot=snapshot,
                                                )
                                        except Exception as e:
                                            logger.warning(
                                                f"state_from_args failed for {tool_name}: {e}",
                                                exc_info=True,
                                            )

                                    # Defer hand-off: for frontend tools, buffer the
                                    # ToolCallEnd instead of emitting it now. It is
                                    # flushed after this turn's backend results (see
                                    # the pending_halt handler). Backend tools and
                                    # continue_after_frontend_call tools emit now.
                                    if is_frontend_tool and not (
                                        behavior and behavior.continue_after_frontend_call
                                    ):
                                        deferred_frontend_tool_ends.append(tool_use_id)
                                    else:
                                        yield ToolCallEndEvent(
                                            type=EventType.TOOL_CALL_END,
                                            tool_call_id=tool_use_id,
                                        )

                                    if self._will_emit_tool_snapshot(behavior, emit_snapshots):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content="",
                                                tool_calls=[
                                                    ToolCall(
                                                        id=tool_use_id,
                                                        type="function",
                                                        function=FunctionCall(
                                                            name=tool_name or "unknown",
                                                            arguments=args_str or "{}",
                                                        ),
                                                    )
                                                ],
                                            )
                                        )
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                        # Rotate so the next assistant message
                                        # in the snapshot (text or another
                                        # tool call) carries a distinct id —
                                        # CopilotKit v2 dedupes by id.
                                        message_id = str(uuid.uuid4())

                                    if is_frontend_tool and not (
                                        behavior
                                        and behavior.continue_after_frontend_call
                                    ):
                                        logger.debug(
                                            f"Deferring halt after frontend tool call: tool_name={tool_name}, tool_call_id={tool_use_id}, thread_id={input_data.thread_id}"
                                        )
                                        pending_halt = True
                                elif is_pending:
                                    # Continuation turn — tool already resolved
                                    # in conversation history. Don't re-emit any
                                    # wire events but still let state callbacks
                                    # fire so derived state stays consistent.
                                    if behavior and behavior.state_from_args:
                                        try:
                                            snapshot = await maybe_await(
                                                behavior.state_from_args(call_context)
                                            )
                                            if snapshot:
                                                current_state.update(snapshot)
                                                yield StateSnapshotEvent(
                                                    type=EventType.STATE_SNAPSHOT,
                                                    snapshot=snapshot,
                                                )
                                        except Exception as e:
                                            logger.warning(
                                                f"state_from_args failed for {tool_name}: {e}",
                                                exc_info=True,
                                            )
                                else:
                                    # Legacy path: behavior.args_streamer is
                                    # configured. Emit the full burst at
                                    # contentBlockStop using the custom
                                    # streamer so existing args_streamer
                                    # consumers keep working.
                                    if behavior and behavior.state_from_args:
                                        try:
                                            snapshot = await maybe_await(
                                                behavior.state_from_args(call_context)
                                            )
                                            if snapshot:
                                                current_state.update(snapshot)
                                                yield StateSnapshotEvent(
                                                    type=EventType.STATE_SNAPSHOT,
                                                    snapshot=snapshot,
                                                )
                                        except Exception as e:
                                            logger.warning(
                                                f"state_from_args failed for {tool_name}: {e}",
                                                exc_info=True,
                                            )

                                    if behavior:
                                        predict_state_payload = [
                                            mapping.to_payload()
                                            for mapping in normalize_predict_state(
                                                behavior.predict_state
                                            )
                                        ]
                                        if predict_state_payload:
                                            yield CustomEvent(
                                                type=EventType.CUSTOM,
                                                name="PredictState",
                                                value=predict_state_payload,
                                            )

                                    if message_started:
                                        yield TextMessageEndEvent(
                                            type=EventType.TEXT_MESSAGE_END, message_id=message_id
                                        )
                                        if (
                                            emit_snapshots
                                            and accumulated_text
                                        ):
                                            snapshot_messages.append(
                                                AssistantMessage(
                                                    id=message_id,
                                                    role="assistant",
                                                    content=accumulated_text,
                                                )
                                            )
                                            accumulated_text = ""
                                            yield MessagesSnapshotEvent(
                                                type=EventType.MESSAGES_SNAPSHOT,
                                                messages=list(snapshot_messages),
                                            )
                                        message_started = False
                                        message_id = str(uuid.uuid4())

                                    # Must mirror the later tool snapshot emission condition.
                                    tool_parent_message_id = (
                                        message_id
                                        if self._will_emit_tool_snapshot(behavior, emit_snapshots)
                                        else last_emitted_text_message_id
                                    )
                                    yield ToolCallStartEvent(
                                        type=EventType.TOOL_CALL_START,
                                        tool_call_id=tool_use_id,
                                        tool_call_name=tool_name,
                                        parent_message_id=tool_parent_message_id,
                                    )

                                    try:
                                        async for chunk in behavior.args_streamer(
                                            call_context
                                        ):
                                            if chunk is None:
                                                continue
                                            yield ToolCallArgsEvent(
                                                type=EventType.TOOL_CALL_ARGS,
                                                tool_call_id=tool_use_id,
                                                delta=str(chunk),
                                            )
                                    except Exception as e:
                                        logger.warning(
                                            f"args_streamer failed for {tool_name}, falling back to full args: {e}"
                                        )
                                        yield ToolCallArgsEvent(
                                            type=EventType.TOOL_CALL_ARGS,
                                            tool_call_id=tool_use_id,
                                            delta=args_str,
                                        )

                                    yield ToolCallEndEvent(
                                        type=EventType.TOOL_CALL_END,
                                        tool_call_id=tool_use_id,
                                    )

                                    if self._will_emit_tool_snapshot(behavior, emit_snapshots):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content="",
                                                tool_calls=[
                                                    ToolCall(
                                                        id=tool_use_id,
                                                        type="function",
                                                        function=FunctionCall(
                                                            name=tool_name or "unknown",
                                                            arguments=args_str or "{}",
                                                        ),
                                                    )
                                                ],
                                            )
                                        )
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                        message_id = str(uuid.uuid4())

                                    if is_frontend_tool and not (
                                        behavior
                                        and behavior.continue_after_frontend_call
                                    ):
                                        logger.debug(
                                            f"Deferring halt after frontend tool call: tool_name={tool_name}, tool_call_id={tool_use_id}, thread_id={input_data.thread_id}"
                                        )
                                        pending_halt = True

                    # Strands' ``ModelMessageEvent`` re-announces the assistant
                    # turn as a whole once the model finishes it. Every part of
                    # it has already been streamed — text via
                    # TEXT_MESSAGE_CONTENT, tool calls via TOOL_CALL_* — and the
                    # authoritative copy reaches the client through
                    # MessagesSnapshotEvent. Letting it fall through to RAW would
                    # re-send the full assistant text a second time, so it is
                    # skipped explicitly rather than by omission.
                    elif isinstance(event.get("message"), dict) and event[
                        "message"
                    ].get("role") == "assistant":
                        continue

                    # A key the chain above owns, reached only because that
                    # branch's guard declined it (see _RAW_SUPPRESSED_KEYS).
                    # "Suppressed" must mean suppressed on every channel, so
                    # this stays silent instead of handing the withheld payload
                    # to the RAW fallback below.
                    elif any(key in event for key in _RAW_SUPPRESSED_KEYS):
                        logger.debug(
                            f"Suppressing mapped-but-declined Strands event (thread_id={input_data.thread_id}, keys={sorted(event)})"
                        )
                        continue

                    # Anything the chain above does not map gets forwarded as a
                    # RAW event rather than being dropped without a trace
                    # (issue #2291). Bedrock citation deltas arrive here, as do
                    # provider extensions this adapter predates. The deliberate
                    # lifecycle skips at the top of the loop short-circuit
                    # before reaching this branch and stay silent.
                    #
                    # Sanitizing is mandatory, not defensive: Strands merges the
                    # live Agent and telemetry handles into delta-bearing events,
                    # and an unserializable payload aborts the whole SSE stream
                    # in ``endpoint.py`` (RunErrorEvent + break), costing the
                    # client its TEXT_MESSAGE_END, snapshots and RUN_FINISHED.
                    else:
                        raw_payload = _sanitize_raw_event(event)
                        if raw_payload is None:
                            continue
                        logger.debug(
                            f"Unmapped Strands event forwarded as RAW (thread_id={input_data.thread_id}): {raw_payload}"
                        )
                        yield RawEvent(
                            type=EventType.RAW,
                            event=raw_payload,
                            source="strands",
                        )

                # Defer hand-off (safety flush): if the stream ended without a
                # backend tool-result message (e.g. a turn with ONLY frontend tool
                # calls), the per-batch flush above never ran and the buffered
                # frontend ToolCallEnd(s) would be lost — leaving TOOL_CALL_START
                # events with no matching END. Flush any remainder here.
                if deferred_frontend_tool_ends:
                    for _fe_tool_use_id in deferred_frontend_tool_ends:
                        yield ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END,
                            tool_call_id=_fe_tool_use_id,
                        )
                    deferred_frontend_tool_ends = []
            except Exception:
                if force_stop_error is None:
                    raise
                # Strands normally raises immediately after ForceStopEvent.
                # Keep it from bypassing message cleanup below, but preserve its
                # traceback in case a distinct hook/finalizer failure occurred.
                logger.exception(
                    "Strands stream raised after force_stop (thread_id=%s)",
                    input_data.thread_id,
                )
            finally:
                # Properly close the async generator to avoid context detachment errors
                # The generator should complete naturally when we consume all events,
                # but we still try to close it explicitly to be safe
                try:
                    # A frontend-tool halt breaks out of the loop with the
                    # generator SUSPENDED at a yield, where ``ag_running`` is
                    # False. The exhausted-generator check below would read
                    # that as "already closed" and defer teardown to GC,
                    # leaving the halted Strands cycle (and its model stream)
                    # open. Close it explicitly instead.
                    if halt_event_stream:
                        await agent_stream.aclose()
                    # Check if generator is already closed/exhausted
                    elif not agent_stream.ag_running:
                        # Generator is already closed, nothing to do
                        pass
                    else:
                        # Try to close gracefully, but suppress context-related errors
                        await agent_stream.aclose()
                except (
                    GeneratorExit,
                    ValueError,
                    RuntimeError,
                    StopAsyncIteration,
                ) as e:
                    # Suppress context detachment errors - they occur when the generator
                    # is closed in a different context, but don't affect functionality
                    # These errors are logged by Strands internally, we just prevent them from propagating
                    pass
                except AttributeError:
                    # Generator doesn't have ag_running attribute (older Python versions)
                    # Just try to close it
                    try:
                        await agent_stream.aclose()
                    except (
                        GeneratorExit,
                        ValueError,
                        RuntimeError,
                        StopAsyncIteration,
                    ):
                        pass
                except Exception as e:
                    # Log other errors but don't fail
                    logger.warning(f"Error closing agent stream: {e}")

            # Close reasoning if still open
            if reasoning_started:
                yield ReasoningMessageEndEvent(
                    type=EventType.REASONING_MESSAGE_END,
                    message_id=reasoning_message_id
                )
                yield ReasoningEndEvent(
                    type=EventType.REASONING_END,
                    message_id=reasoning_message_id
                )

            # End message if started
            if message_started:
                yield TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END, message_id=message_id
                )
                # Splice point 4 of 4 (terminal): commit the final
                # assistant text turn into the snapshot so the frontend
                # has the closing message in canonical history.
                if emit_snapshots and accumulated_text:
                    snapshot_messages.append(
                        AssistantMessage(
                            id=message_id,
                            role="assistant",
                            content=accumulated_text,
                        )
                    )
                    accumulated_text = ""
                    yield MessagesSnapshotEvent(
                        type=EventType.MESSAGES_SNAPSHOT,
                        messages=list(snapshot_messages),
                    )

            if force_stop_error is not None:
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=force_stop_error,
                    code="STRANDS_FORCE_STOP",
                )
                return

            # Streaming can create a mixed checkpoint that was not observable
            # during preflight. Do not advertise or finish it unless the same
            # repository boundary needed for a safe resume is available.
            if active_proxy_placeholder_ids(strands_agent):
                if session_manager is None:
                    yield _interrupt_session_required_error()
                    return
                if not _supports_repository_reconciliation(
                    session_manager, strands_agent
                ):
                    yield _interrupt_session_capability_error()
                    return

            # Final state snapshot before finishing
            yield StateSnapshotEvent(
                type=EventType.STATE_SNAPSHOT,
                snapshot=current_state,
            )

            # If the run paused on a native Strands interrupt, surface it as an
            # AG-UI interrupt outcome so the client can collect a response and
            # resume via ``RunAgentInput.resume`` next turn.
            native_interrupts = _extract_interrupts(strands_agent, terminal_result)
            if native_interrupts:
                ag_ui_interrupts = [
                    _strands_interrupt_to_agui(interrupt)
                    for interrupt in native_interrupts
                ]
                pending_interrupt_outcome = RunFinishedInterruptOutcome(
                    type="interrupt",
                    interrupts=ag_ui_interrupts,
                )
                self._pending_interrupts_by_thread[thread_id] = {
                    interrupt.id: interrupt for interrupt in ag_ui_interrupts
                }
                self._last_resume_fingerprint.pop(thread_id, None)
                _persist_interrupt_bookkeeping(
                    strands_agent,
                    self._pending_interrupts_by_thread[thread_id],
                    None,
                )
                logger.debug(
                    f"Strands interrupt detected: thread_id={input_data.thread_id}, "
                    f"interrupt_ids={[i.id for i in ag_ui_interrupts]}"
                )

            # Always finish the run - frontend handles keeping action executing
            if pending_interrupt_outcome is not None:
                yield RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                    outcome=pending_interrupt_outcome,
                )
            else:
                # Store fingerprint for idempotency only after successful processing
                if resume_entries:
                    fp = _resume_fingerprint(resume_entries)
                    self._pending_interrupts_by_thread.pop(thread_id, None)
                    self._last_resume_fingerprint[thread_id] = fp
                    _persist_interrupt_bookkeeping(strands_agent, None, fp)
                yield RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                    outcome=RunFinishedSuccessOutcome(type="success"),
                )

        except Exception as e:
            import traceback

            traceback.print_exc()
            yield RunErrorEvent(
                type=EventType.RUN_ERROR, message=str(e), code="STRANDS_ERROR"
            )
