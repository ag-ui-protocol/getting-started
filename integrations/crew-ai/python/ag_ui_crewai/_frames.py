"""Translate crewai stream events into AG-UI wire events.

crewai's public streaming contract (``StreamFrame`` / ``AsyncStreamSession``,
landed 1.6.0) emits one ordered frame per event a flow raises. The frame gives
us ORDERING and the identity of the emitting flow; the RAW event object (parked
by our scoped stream sink, keyed by ``event.event_id == StreamFrame.id``) gives
us the EXACT payload. This module is the SINGLE translation seam that maps the
raw events the bridge cares about onto AG-UI events.

Why raw events, not ``frame.data``:
``StreamFrame.data`` is ``event.to_json(exclude=...)`` -> crewai's
``to_serializable(max_depth=5)``, which (a) ``repr()``-quotes anything at depth
>= 5 (plain strings become ``"'text'"``) and (b) recursively drops any dict key
named ``type`` / ``timestamp`` / ``event_id`` / ... . That silently corrupts the
progressive ``STATE_SNAPSHOT`` payloads ``copilotkit_emit_state`` exists to
stream (verified against the crewai 1.15.7 wheel). Emitting straight from the
raw event object bypasses all of it.

Two raw event sources feed us (verified against the 1.15.7 wheel):

* Flow-lifecycle events (``FlowStartedEvent`` / ``MethodExecutionStartedEvent``
  / ``MethodExecutionFinishedEvent`` / ``FlowFinishedEvent``), whose ``.type``
  is the crewai lifecycle string (``"flow_started"`` etc.).
* The bridge's own ``Bridged*`` events (emitted by ``sdk.copilotkit_stream`` &
  friends via ``crewai_event_bus.emit``), whose ``.type`` is the AG-UI
  ``EventType`` string and whose typed attributes (``snapshot`` / ``delta`` /
  ``message_id`` / ...) carry the verbatim, un-serialized payload.

Source filtering: a ``crew.kickoff`` inside a flow method drives a NESTED flow
whose own lifecycle/method events leak onto the same scoped sink. The driver
drops those nested flow/method events by source identity (only events whose
``source is flow_copy`` are parked) before they reach this translator. Crew and
Agent lifecycle events are the exception: they arrive with a non-outer source
but are surfaced deliberately (the sink parks them because they are scoped to
this run) so this translator can attribute the Crew / Agent hierarchy. The
translator therefore sees outer-source flow/method events plus run-scoped
crew/agent events, but never nested-flow frames.

UPSTREAM FRAME RETENTION: crewai's ``AsyncStreamSession``
(``crewai.types.streaming.StreamSessionBase``) appends EVERY iterated frame to
its ``self._frames`` list and keeps them for the session's life (to back its
``.frames`` / ``.result`` replay accessors) — we cannot drop consumed frames
without forking upstream, and doing so would break those accessors. The growth
is bounded per-request (one session per run, torn down when the request ends),
NOT a cross-request leak. The bridge's OWN raw-event lookup buffer does not
share this behavior: ``endpoint._run_flow_frame_stream`` ``pop``s each parked
raw event by ``frame.id`` the moment its frame is consumed, so our buffer stays
proportional to in-flight (not total) frames. If a future crewai release makes
frame retention opt-out, revisit the session consumption in ``endpoint.py``.

SWAPPABLE EMISSION SHAPE: CrewAI is currently
the only integration emitting TEXT_MESSAGE_CHUNK / TOOL_CALL_CHUNK (chunks)
rather than the START/CONTENT/END triples the six other integrations emit. That
final choice belongs to a Parity-lane ticket, not this migration. The translator
therefore routes LLM text / LLM-tool-call emission through a single
``emission_shape`` strategy that DEFAULTS to ``"chunks"`` so this migration is
byte-for-byte behavior-preserving on that channel. The ``"triples"`` strategy is
a deliberate NotImplementedError placeholder for the STREAMED channel. The
BACKEND tool path has the full args up front, so it implements both shapes and
just follows ``emission_shape``.

MCP EVENTS are the ONE exception to "chunks-only": crewai's discrete
MCP tool executions (name + full args + result arrive together, not streamed)
map to canonical ``TOOL_CALL_START/ARGS/END/RESULT`` triples via the shared
``mcp.translate_mcp_event`` seam, and MCP lifecycle events map to ``CUSTOM``.
This is independent of the ``emission_shape`` strategy above (which governs only
the streaming LLM text / tool-call channel); see the wire-shape note in
``mcp.py`` for why discrete MCP calls use triples.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Callable
from typing import Any

from ag_ui.core import (
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    AssistantMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
)
from ag_ui.core.events import (
    RawEvent,
    TextMessageChunkEvent,
    ToolCallChunkEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    StepStartedEvent,
    StepFinishedEvent,
    MessagesSnapshotEvent,
    StateSnapshotEvent,
    CustomEvent,
    ReasoningStartEvent,
    ReasoningMessageStartEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningEndEvent,
    ReasoningEncryptedValueEvent,
)

from .sdk import litellm_messages_to_ag_ui_messages
from .mcp import is_mcp_event, translate_mcp_event
from ._hitl import HITLOptions, build_agui_interrupt, build_interrupt_tail
from ._reasoning import is_thinking_event, thinking_event_text
from .attribution import (
    BoundaryTracker,
    FLOW_METHOD,
    CREW,
    AGENT,
    step_started_event,
    step_finished_event,
)

_LOGGER = logging.getLogger(__name__)

# crewai lifecycle-event ``type`` strings. Pinned as constants so a rename
# upstream surfaces here rather than silently producing no wire events.
_FLOW_STARTED = "flow_started"
_FLOW_FINISHED = "flow_finished"
_METHOD_STARTED = "method_execution_started"
_METHOD_FINISHED = "method_execution_finished"
_METHOD_FAILED = "method_execution_failed"

# Async-HITL pause events (crewai >= 1.8). ``human_feedback_requested`` carries
# the stable ``request_id``; ``flow_paused`` carries the ``flow_id``.
_HUMAN_FEEDBACK_REQUESTED = "human_feedback_requested"
_FLOW_PAUSED = "flow_paused"

# Crew- and Agent-level ``type`` strings. The ordered StreamFrame path sees
# these (crew/agent frames arrive on the outer flow's ``astream`` with a source
# that is NOT the outer flow; see ``endpoint._sink``), so it can reconstruct the
# Flow-method -> Crew -> Agent hierarchy. Pinned as constants for rename safety.
_CREW_STARTED = "crew_kickoff_started"
_CREW_COMPLETED = "crew_kickoff_completed"
_CREW_FAILED = "crew_kickoff_failed"
_AGENT_STARTED = "agent_execution_started"
_AGENT_COMPLETED = "agent_execution_completed"
_AGENT_ERROR = "agent_execution_error"

# Single source of truth for identifying crew/agent lifecycle events. The sink
# in ``endpoint.py`` parks these regardless of source; the translator matches
# them by the individual constants above.
CREW_AGENT_LIFECYCLE_TYPES = frozenset({
    _CREW_STARTED,
    _CREW_COMPLETED,
    _CREW_FAILED,
    _AGENT_STARTED,
    _AGENT_COMPLETED,
    _AGENT_ERROR,
})

# crewai ``ToolUsage*`` event ``type`` strings, fired when an Agent/Crew runs a
# backend tool server-side (vs a frontend action streamed via copilotkit_stream).
# We surface only ``finished`` (success, or a terminal failure whose error text
# lands in ``output``). The error events are crewai's per-attempt retry signals
# (up to 3 tries before any tool runs), so surfacing them would render phantom
# cards and, once recorded into MESSAGES_SNAPSHOT, poison history. ``started`` is
# parked only so it is "recognized" (never RAW-mirrored) and then dropped. This
# mirrors LangGraph's OnToolEnd/OnToolError, which emits nothing on tool error.
_TOOL_USAGE_STARTED = "tool_usage_started"
_TOOL_USAGE_FINISHED = "tool_usage_finished"

BACKEND_TOOL_EVENT_TYPES = frozenset({_TOOL_USAGE_STARTED, _TOOL_USAGE_FINISHED})

# crewai wraps MCP servers in these ``BaseTool`` subclasses, which run through
# the ordinary agent-tool path and ALSO emit ``ToolUsage*``. MCP already has its
# own translation seam (``mcp.translate_mcp_event``), so surfacing the ToolUsage
# copy too would render a second, duplicate tool card. Skip the backend path for
# them (probe by class name, no version gate).
_MCP_TOOL_CLASS_NAMES = frozenset({"MCPToolWrapper", "MCPNativeTool"})


def is_backend_tool_event(event: Any) -> bool:
    """True for a crewai ToolUsage event.

    The driver parks these regardless of source: they emit with the ToolUsage /
    executor as source (never ``flow_copy``), so the source gate would drop them.
    """
    return getattr(event, "type", None) in BACKEND_TOOL_EVENT_TYPES

_SUPPORTED_EMISSION_SHAPES = frozenset({"chunks", "triples"})


def _coerce_name(value: Any, fallback: str) -> str:
    """Coerce a crewai identity (method / crew name) to a non-empty ``str``.

    crewai populates ``method_name`` / ``crew_name`` as strings today, but the
    attribution path joins them into ``path`` / ``qualified_name`` and uses them
    as the boundary pairing key, so a stray ``None`` (an event constructed via
    ``model_construct`` that skipped the field) or a non-str must never reach it
    and raise. Empty / whitespace-only values fall back too.
    """
    if value is None:
        return fallback
    text = str(value).strip()
    return text or fallback


def _agent_role(event: Any) -> str:
    """Derive a stable, always-``str`` role for an agent lifecycle event.

    Prefers the agent's ``role``, falls back to its ``id`` (a UUID object on
    crewai's ``BaseAgent``, hence the ``str(...)`` coercion), then to the
    literal ``"agent"``. The SAME derivation is used on start and on
    completion/error so the boundary pairs by a stable name.
    """
    agent = getattr(event, "agent", None)
    role = getattr(agent, "role", None) if agent is not None else None
    if role is None or not str(role).strip():
        role = getattr(agent, "id", None) if agent is not None else None
    return _coerce_name(role, "agent")


class StreamFrameTranslator:
    """Stateless-ish mapper from a RAW crewai/bridge event to AG-UI events.

    One instance per run (it carries the run correlation ids and a
    ``state_provider`` closure over the live flow copy). ``translate`` returns
    zero or more AG-UI events for a single raw event; unrecognised event types
    return ``[]`` (behavior-preserving: the legacy listener produced nothing for
    crewai's native llm / tools / messages channels or internal events).

    The driver forwards outer-flow lifecycle/method events (``source is
    flow_copy``) plus the run-scoped Crew/Agent lifecycle events (which carry a
    non-outer source); nested-flow frames are filtered out before they reach
    the translator, so every event it sees belongs to the outer run.
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: str,
        state_provider: Callable[[], Any],
        emission_shape: str = "chunks",
        hitl_options: HITLOptions | None = None,
        resumed: bool = False,
    ) -> None:
        if emission_shape not in _SUPPORTED_EMISSION_SHAPES:
            raise ValueError(
                f"Unknown emission_shape {emission_shape!r}; "
                f"expected one of {sorted(_SUPPORTED_EMISSION_SHAPES)}"
            )
        self._thread_id = thread_id
        self._run_id = run_id
        self._state_provider = state_provider
        self.emission_shape = emission_shape
        self._hitl_options = hitl_options or HITLOptions()
        # True for a RESUMED run: the method that was suspended finishes in a run
        # that never saw its start, so its step has to be opened before it can be
        # closed (the client rejects a STEP_FINISHED for a step it never saw
        # started). A fresh run keeps the flat-close behavior.
        self._resumed = resumed
        # One ordered boundary stack per run, driven in emit order by
        # ``translate``: ``enter`` on a start frame, ``exit`` on the matching
        # finish, ``drain_all`` at run end so every STEP_STARTED is closed.
        self._tracker = BoundaryTracker()
        # Run-lifecycle idempotency. A single AG-UI HTTP run must
        # emit EXACTLY ONE ``RUN_STARTED`` (first) and ONE ``RUN_FINISHED``
        # (last). Nested-flow lifecycle events are already filtered out by the
        # driver's source gate, so no depth counter is needed; these flags are
        # a cheap belt-and-braces guard against a double emit.
        self._run_started_emitted = False
        self._run_finished_emitted = False
        # Async-HITL pause capture. A ``@human_feedback`` provider raising
        # ``HumanFeedbackPending`` pauses the flow WITHOUT a ``flow_finished``;
        # the request/pause events are recorded here so ``finalize`` can
        # terminate the run with an interrupt outcome instead of a plain finish.
        # The paused method's STEP is closed by draining the boundary tracker,
        # which the AG-UI client requires before RUN_FINISHED.
        self._pending_request: dict[str, Any] | None = None
        self._paused: bool = False
        self._paused_flow_id: str | None = None
        # Native-reasoning lifecycle (crewai's Gemini ``LLMThinkingChunkEvent``).
        # These arrive as a stream of chunks with no explicit end signal, so the
        # message stays open until the next non-thinking event (or finalize)
        # flushes it. The litellm-path reasoning events are already fully-formed
        # lifecycle events and are mapped 1:1, without this state.
        self._reasoning_message_id: str | None = None
        self._reasoning_open = False
        # litellm-path reasoning is mapped 1:1, so it needs no per-event flush.
        # These flags are consulted ONLY by ``flush_open_reasoning`` on the error
        # path, which closes a message left half-open when a mid-run error drops
        # its trailing END frames.
        self._litellm_message_id: str | None = None
        self._litellm_msg_open = False
        self._litellm_started = False
        # A MESSAGES_SNAPSHOT is authoritative: the client drops any message
        # absent from it. The method-finish snapshot comes from state.messages,
        # which never holds backend tool calls (they exist only on the wire), so
        # we stash each surfaced call+result pair and merge it into the snapshot
        # or the streamed tool card is wiped at method-finish.
        self._backend_tool_messages: list[Any] = []

    # -- public API --------------------------------------------------------

    @property
    def run_started(self) -> bool:
        """Whether RUN_STARTED has been emitted for this run."""
        return self._run_started_emitted

    @property
    def run_finished(self) -> bool:
        """Whether RUN_FINISHED has been emitted (the run terminated)."""
        return self._run_finished_emitted

    @property
    def interrupted(self) -> bool:
        """Whether the flow paused for async human feedback.

        Either signal proves a pause: ``human_feedback_requested`` (the bridge's
        provider) OR ``flow_paused`` alone (a custom provider that raises
        ``HumanFeedbackPending`` without emitting the request event). Keyed on a
        dedicated flag, not on ``_paused_flow_id``, so a ``flow_paused`` carrying
        no usable flow id still counts as a pause (the interrupt id then falls
        back to the thread id) rather than being silently reported as completed.
        """
        return self._pending_request is not None or self._paused

    def ensure_run_started(self) -> list[Any]:
        """Emit RUN_STARTED if the run has not opened yet, else nothing.

        Lets a driver guarantee RUN_STARTED is the first wire event even when the
        underlying crewai call emits no ``flow_started`` (e.g. ``resume_async``).
        Idempotent: a later ``flow_started`` is suppressed by the same flag.
        """
        if self._run_started_emitted:
            return []
        self._run_started_emitted = True
        return [
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=self._thread_id,
                run_id=self._run_id,
            )
        ]

    def translate(self, event: Any) -> list[Any]:
        """Map one raw crewai/bridge event to the AG-UI events it produces.

        Native thinking chunks (crewai's Gemini provider) drive a stateful
        reasoning lifecycle; any other event first flushes an open native
        reasoning message so its ``REASONING_MESSAGE_END`` / ``REASONING_END``
        precede whatever comes next on the wire.
        """
        if is_thinking_event(event):
            return self._native_thinking_events(event)
        prefix = self._flush_native_reasoning()
        events = self._translate_non_thinking(event)
        return prefix + events if prefix else events

    def _translate_non_thinking(self, event: Any) -> list[Any]:
        event_type = getattr(event, "type", None)

        if event_type == _FLOW_STARTED:
            # Emit RUN_STARTED for the outermost flow only; the driver drops
            # nested-flow events, so a second one would be a defect.
            if self._run_started_emitted:
                return []
            self._run_started_emitted = True
            return [
                RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=self._thread_id,
                    run_id=self._run_id,
                )
            ]
        if event_type == _FLOW_FINISHED:
            if self._run_finished_emitted or not self._run_started_emitted:
                # Never emit a second RUN_FINISHED, and never synthesize one for
                # a run that never opened.
                return []
            self._run_finished_emitted = True
            # Close every STEP_STARTED still open before RUN_FINISHED so a
            # boundary whose finish frame never arrived does not dangle.
            # ``drain_all`` returns them deepest-first for balanced closes.
            events: list[Any] = [
                step_finished_event(b) for b in self._tracker.drain_all()
            ]
            events.append(
                RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=self._thread_id,
                    run_id=self._run_id,
                )
            )
            return events
        if event_type == _METHOD_STARTED:
            return self._method_started_events(event)
        if event_type == _METHOD_FINISHED:
            return self._method_finished_events(event)
        if event_type == _METHOD_FAILED:
            # Close the method boundary so a failed flow method (the flow may
            # continue) does not leave a dangling STEP_STARTED. No snapshots.
            method_name = _coerce_name(getattr(event, "method_name", None), "method")
            return self._close_boundaries(
                self._tracker.exit(FLOW_METHOD, method_name), _METHOD_FAILED
            )
        if event_type == _CREW_STARTED:
            return self._crew_started_events(event)
        if event_type in (_CREW_COMPLETED, _CREW_FAILED):
            return self._crew_finished_events(event)
        if event_type == _AGENT_STARTED:
            return self._agent_started_events(event)
        if event_type in (_AGENT_COMPLETED, _AGENT_ERROR):
            return self._agent_finished_events(event)

        # Async-HITL pause. Record the request (stable id + prompt) and the
        # paused flow id; no wire event here (``finalize`` emits the interrupt
        # tail once the finish-less frame stream exhausts).
        if event_type == _HUMAN_FEEDBACK_REQUESTED:
            self._pending_request = {
                "request_id": getattr(event, "request_id", None),
                "message": getattr(event, "message", None),
                "method_name": getattr(event, "method_name", None),
                "output": getattr(event, "output", None),
                "emit": getattr(event, "emit", None),
            }
            return []
        if event_type == _FLOW_PAUSED:
            self._paused = True
            self._paused_flow_id = getattr(event, "flow_id", None)
            return []

        # crewai's first-class MCP events (crewai >= 1.4). Emitted with
        # the agent/crew as source (not the flow), so the driver's sink parks
        # them by TYPE rather than source identity; here they map to TOOL_CALL_*
        # (tool executions) and CUSTOM (lifecycle) via the shared translator.
        if is_mcp_event(event):
            return translate_mcp_event(event)

        # Bridge-emitted events carry the AG-UI EventType string as ``.type``
        # and the verbatim payload on typed attributes (no ``to_serializable``).
        if event_type == EventType.TEXT_MESSAGE_CHUNK:
            return self._text_events(event)
        if event_type == EventType.TOOL_CALL_CHUNK:
            return self._tool_events(event)
        if event_type == EventType.TOOL_CALL_RESULT:
            return [
                ToolCallResultEvent(
                    type=EventType.TOOL_CALL_RESULT,
                    message_id=getattr(event, "message_id", None),
                    tool_call_id=getattr(event, "tool_call_id", None),
                    content=getattr(event, "content", None),
                    role="tool",
                )
            ]
        if event_type == EventType.CUSTOM:
            return [
                CustomEvent(
                    type=EventType.CUSTOM,
                    name=getattr(event, "name", None),
                    value=getattr(event, "value", None),
                )
            ]
        if event_type == EventType.STATE_SNAPSHOT:
            return [
                StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT,
                    snapshot=getattr(event, "snapshot", None),
                )
            ]

        # Reasoning lifecycle from the litellm path (``sdk.copilotkit_stream``):
        # already fully-formed lifecycle events, mapped 1:1. The open/close
        # flags are consulted only by ``flush_open_reasoning`` on the error path.
        if event_type == EventType.REASONING_START:
            self._litellm_message_id = getattr(event, "message_id", None)
            self._litellm_started = True
            return [
                ReasoningStartEvent(
                    type=EventType.REASONING_START,
                    message_id=self._litellm_message_id,
                )
            ]
        if event_type == EventType.REASONING_MESSAGE_START:
            self._litellm_msg_open = True
            return [
                ReasoningMessageStartEvent(
                    type=EventType.REASONING_MESSAGE_START,
                    message_id=getattr(event, "message_id", None),
                    role=getattr(event, "role", None),
                )
            ]
        if event_type == EventType.REASONING_MESSAGE_CONTENT:
            return [
                ReasoningMessageContentEvent(
                    type=EventType.REASONING_MESSAGE_CONTENT,
                    message_id=getattr(event, "message_id", None),
                    delta=getattr(event, "delta", None),
                )
            ]
        if event_type == EventType.REASONING_MESSAGE_END:
            self._litellm_msg_open = False
            return [
                ReasoningMessageEndEvent(
                    type=EventType.REASONING_MESSAGE_END,
                    message_id=getattr(event, "message_id", None),
                )
            ]
        if event_type == EventType.REASONING_END:
            self._litellm_started = False
            return [
                ReasoningEndEvent(
                    type=EventType.REASONING_END,
                    message_id=getattr(event, "message_id", None),
                )
            ]
        if event_type == EventType.REASONING_ENCRYPTED_VALUE:
            return [
                ReasoningEncryptedValueEvent(
                    type=EventType.REASONING_ENCRYPTED_VALUE,
                    subtype=getattr(event, "subtype", None),
                    entity_id=getattr(event, "entity_id", None),
                    encrypted_value=getattr(event, "encrypted_value", None),
                )
            ]

        # Backend tool execution: surface the call + result so the client can
        # render it. Only ``finished`` (crewai's terminal event, whose ``output``
        # carries the result or a terminal error string). ``started`` is dropped
        # (it is parked only so it counts as "recognized" and is never
        # RAW-mirrored). MCP tools also emit ToolUsage but have their own seam
        # above, so skip them here to avoid a duplicate card.
        if event_type == _TOOL_USAGE_FINISHED:
            if getattr(event, "tool_class", None) in _MCP_TOOL_CLASS_NAMES:
                return []
            return self._backend_tool_events(event)

        # crewai native llm / messages / lifecycle events and internal events
        # are intentionally dropped to keep the wire output identical to the
        # legacy listener.
        return []

    def finalize(self) -> list[Any]:
        """Belt-and-braces terminal.

        Called once when the frame stream exhausts cleanly. If the run opened
        (RUN_STARTED) but no outer ``flow_finished`` closed it (the outer
        method caught a nested-flow error, the stream just ended, or the flow
        PAUSED for async human feedback), emit the missing terminal so the
        client NEVER sees a run that never ends. A pause terminates with the
        interrupt tail (opt-in outcome); every other case with a plain
        RUN_FINISHED. The errored path terminates via RUN_ERROR instead and must
        not call this.
        """
        # main's guard: return [] unless the run is open and not yet finished.
        # This also prevents a trailing REASONING_* after RUN_FINISHED (the
        # flow_finished branch already flushed reasoning via translate()).
        if not (self._run_started_emitted and not self._run_finished_emitted):
            return []
        self._run_finished_emitted = True
        # Reasoning ENDs first (both channels; on a clean run the litellm channel
        # already self-closed so this is a no-op), then STEP_FINISHED (drain
        # boundaries deepest-first so no dangling STEP_STARTED; also balances a
        # method an interrupt paused mid-flight), then the terminal event.
        events: list[Any] = self.flush_open_reasoning()
        events.extend(step_finished_event(b) for b in self._tracker.drain_all())
        interrupt = self._build_interrupt()
        if interrupt is not None:
            return events + build_interrupt_tail(
                interrupt,
                thread_id=self._thread_id,
                run_id=self._run_id,
                options=self._hitl_options,
            )
        events.append(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=self._thread_id,
                run_id=self._run_id,
            )
        )
        return events

    # -- native reasoning lifecycle (crewai Gemini thinking chunks) --------

    def _native_thinking_events(self, event: Any) -> list[Any]:
        """Open (if needed) and extend the native reasoning message.

        crewai streams thinking as ``chunk`` deltas with no explicit end; the
        message opens on the first chunk and is closed lazily by
        ``_flush_native_reasoning`` when a non-thinking event follows.
        """
        text = thinking_event_text(event)
        if text is None:
            return []
        events: list[Any] = []
        if not self._reasoning_open:
            self._reasoning_message_id = uuid.uuid4().hex
            self._reasoning_open = True
            events.append(
                ReasoningStartEvent(
                    type=EventType.REASONING_START,
                    message_id=self._reasoning_message_id,
                )
            )
            events.append(
                ReasoningMessageStartEvent(
                    type=EventType.REASONING_MESSAGE_START,
                    message_id=self._reasoning_message_id,
                    role="reasoning",
                )
            )
        events.append(
            ReasoningMessageContentEvent(
                type=EventType.REASONING_MESSAGE_CONTENT,
                message_id=self._reasoning_message_id,
                delta=text,
            )
        )
        return events

    def _flush_native_reasoning(self) -> list[Any]:
        """Close an open native reasoning message, returning its END events."""
        if not self._reasoning_open:
            return []
        message_id = self._reasoning_message_id
        self._reasoning_open = False
        self._reasoning_message_id = None
        return [
            ReasoningMessageEndEvent(
                type=EventType.REASONING_MESSAGE_END,
                message_id=message_id,
            ),
            ReasoningEndEvent(
                type=EventType.REASONING_END,
                message_id=message_id,
            ),
        ]

    def flush_open_reasoning(self) -> list[Any]:
        """Close any reasoning message still open, on either channel.

        Called by the frame driver on the error/timeout path so a run that
        errors mid-reasoning does not leave a half-open lifecycle before
        RUN_ERROR, and by ``finalize`` before the terminal event. Closes the
        native message (via ``_flush_native_reasoning``) and the litellm message
        (whose trailing END frames the exited frame loop never dequeues).
        Idempotent: each channel closes at most once, so a channel already
        closed on the happy path is a no-op.
        """
        events = self._flush_native_reasoning()
        if self._litellm_msg_open:
            self._litellm_msg_open = False
            events.append(
                ReasoningMessageEndEvent(
                    type=EventType.REASONING_MESSAGE_END,
                    message_id=self._litellm_message_id,
                )
            )
        if self._litellm_started:
            self._litellm_started = False
            events.append(
                ReasoningEndEvent(
                    type=EventType.REASONING_END,
                    message_id=self._litellm_message_id,
                )
            )
        return events

    def note_pause_from_context(self, context: Any) -> None:
        """Seed pause state from a ``HumanFeedbackPending.context``.

        The frame driver normally captures the pause from the ``flow_paused`` /
        ``human_feedback_requested`` frames. If instead the pause PROPAGATES out
        of ``astream`` / ``resume_async`` as ``HumanFeedbackPending``, the driver
        calls this so ``finalize`` still emits the interrupt tail rather than a
        RUN_ERROR. The flow id doubles as the stable request id (matching the
        bridge provider, which stamps ``request_id`` with the flow id).
        """
        self._paused = True
        flow_id = getattr(context, "flow_id", None)
        if self._pending_request is None:
            self._pending_request = {
                "request_id": flow_id,
                "message": getattr(context, "message", None),
                "method_name": getattr(context, "method_name", None),
                "output": getattr(context, "method_output", None),
                "emit": getattr(context, "emit", None),
            }
        if self._paused_flow_id is None:
            self._paused_flow_id = flow_id

    def _build_interrupt(self) -> Any:
        """Build the AG-UI interrupt for a paused run, or ``None`` if not paused.

        Works from either pause signal. When ``human_feedback_requested`` was
        seen, its fields (stable id, prompt, emit options) populate the
        interrupt. When only ``flow_paused`` was seen (a custom provider), the
        interrupt still carries a resumable id from the flow id. The flow id
        falls back to the run's ``thread_id`` (== crewai ``flow_id``) when the
        pause event did not carry one.
        """
        if not self.interrupted:
            return None
        req = self._pending_request or {}
        return build_agui_interrupt(
            request_id=req.get("request_id"),
            flow_id=self._paused_flow_id or self._thread_id,
            message=req.get("message"),
            method_name=req.get("method_name"),
            output=req.get("output"),
            emit=req.get("emit"),
        )

    # -- lifecycle --------------------------------------------------------

    def _method_started_events(self, event: Any) -> list[Any]:
        """Open a Flow-method boundary and emit its attributed STEP_STARTED.

        The ``step_name`` on the wire is unchanged (the method name); the
        ``raw_event.attribution`` payload is the additive part so nested Crew /
        Agent steps chain under it.
        """
        method_name = _coerce_name(getattr(event, "method_name", None), "method")
        boundary = self._tracker.enter(
            FLOW_METHOD,
            method_name,
            fingerprint=getattr(event, "source_fingerprint", None),
            flow_name=getattr(event, "flow_name", None),
        )
        return [step_started_event(boundary, source_event_type=_METHOD_STARTED)]

    def _crew_started_events(self, event: Any) -> list[Any]:
        """Open a Crew boundary (child of the current method) -> STEP_STARTED."""
        crew_name = _coerce_name(getattr(event, "crew_name", None), "crew")
        boundary = self._tracker.enter(
            CREW,
            crew_name,
            fingerprint=getattr(event, "source_fingerprint", None),
        )
        return [step_started_event(boundary, source_event_type=_CREW_STARTED)]

    def _crew_finished_events(self, event: Any) -> list[Any]:
        """Close the nearest matching Crew boundary -> balanced STEP_FINISHED(s).

        ``exit`` returns the matched boundary plus any dangling inners
        (deepest-first); only the matched (last) boundary is tagged with the
        source event type. An empty return (no open crew of that name) emits
        nothing rather than an unbalanced close.
        """
        crew_name = _coerce_name(getattr(event, "crew_name", None), "crew")
        source_type = getattr(event, "type", None)
        return self._close_boundaries(
            self._tracker.exit(CREW, crew_name), source_type
        )

    def _agent_started_events(self, event: Any) -> list[Any]:
        """Open an Agent boundary (child of the current crew) -> STEP_STARTED."""
        role = _agent_role(event)
        boundary = self._tracker.enter(
            AGENT,
            role,
            fingerprint=getattr(event, "source_fingerprint", None),
        )
        return [step_started_event(boundary, source_event_type=_AGENT_STARTED)]

    def _agent_finished_events(self, event: Any) -> list[Any]:
        """Close the nearest matching Agent boundary -> balanced STEP_FINISHED(s).

        Uses the SAME ``_agent_role`` derivation as the start so the boundary
        pairs by a stable name. Empty return => emit nothing.
        """
        role = _agent_role(event)
        source_type = getattr(event, "type", None)
        return self._close_boundaries(
            self._tracker.exit(AGENT, role), source_type
        )

    @staticmethod
    def _close_boundaries(closed: list[Any], source_event_type: Any) -> list[Any]:
        """Turn an ``exit``/``drain`` result into balanced STEP_FINISHED events.

        ``closed`` is deepest-first (inner boundaries first). Only the matched
        boundary (the LAST element, i.e. the one whose finish frame we actually
        received) is tagged with ``source_event_type`` for provenance; the
        dangling inners closed alongside it get no source tag (their own finish
        frame never arrived). An empty list yields no events.
        """
        events: list[Any] = []
        last_index = len(closed) - 1
        for index, boundary in enumerate(closed):
            tag = source_event_type if index == last_index else None
            events.append(step_finished_event(boundary, source_event_type=tag))
        return events

    def _method_finished_events(self, event: Any) -> list[Any]:
        """MESSAGES_SNAPSHOT + STATE_SNAPSHOT + balanced STEP_FINISHED(s).

        Reads the LIVE flow state via ``state_provider`` — exactly what the
        legacy listener did with ``source.state`` — rather than the serialized
        ``event`` payload, so message / state shapes round-trip through the same
        ``litellm_messages_to_ag_ui_messages`` path as before. The two snapshots
        are emitted VERBATIM (unchanged behaviour).

        The final close is balanced: ``exit(FLOW_METHOD, method_name)`` returns
        the matched method boundary plus any Crew / Agent boundaries left
        dangling by a lost completion frame (deepest-first). If no boundary
        matches (the tracker never saw this method's start), fall back to a flat
        ``StepFinishedEvent(step_name=method_name)`` rather than dropping the
        close entirely.
        """
        state = self._state_provider()
        raw_messages = (
            getattr(state, "messages", None)
            or (state.get("messages") if isinstance(state, dict) else None)
            or []
        )
        messages = litellm_messages_to_ag_ui_messages(raw_messages)
        # Backend tool calls live only on the wire; merge them in so they
        # survive this authoritative snapshot (see ``_backend_tool_messages``).
        messages = self._merge_backend_tool_messages(messages)
        snapshot = (
            state
            if isinstance(state, dict)
            else state.model_dump()
            if hasattr(state, "model_dump")
            else {}
        )
        method_name = _coerce_name(getattr(event, "method_name", None), "method")
        closed = self._tracker.exit(FLOW_METHOD, method_name)
        events: list[Any] = []
        if not closed and self._resumed:
            # RESUMED run: the suspended method finishes in a run that never saw
            # its start, so open the step here. The client rejects a
            # STEP_FINISHED for a step it never saw started.
            events.append(
                StepStartedEvent(type=EventType.STEP_STARTED, step_name=method_name)
            )
        events += [
            MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=messages,
            ),
            StateSnapshotEvent(
                type=EventType.STATE_SNAPSHOT,
                snapshot=snapshot,
            ),
        ]
        if closed:
            events.extend(self._close_boundaries(closed, _METHOD_FINISHED))
        else:
            # Flat close for the synthesized step opened above, using the same
            # coerced ``method_name`` so a None cannot leak onto the wire.
            events.append(
                StepFinishedEvent(
                    type=EventType.STEP_FINISHED,
                    step_name=method_name,
                )
            )
        return events

    # -- emission-shape strategy (default "chunks") -----------------------

    def _text_events(self, event: Any) -> list[Any]:
        if self.emission_shape == "chunks":
            return [
                TextMessageChunkEvent(
                    type=EventType.TEXT_MESSAGE_CHUNK,
                    message_id=getattr(event, "message_id", None),
                    role=getattr(event, "role", None),
                    delta=getattr(event, "delta", None),
                )
            ]
        # TODO(Parity lane): emit TEXT_MESSAGE_START / _CONTENT / _END
        # triples here to match the other six integrations. Do NOT flip the
        # default in this migration (it must stay behavior-preserving on the
        # wire).
        raise NotImplementedError(
            "emission_shape='triples' is a Parity-lane placeholder; "
            "the StreamFrame migration ships the behavior-preserving "
            "'chunks' shape only."
        )

    def _tool_events(self, event: Any) -> list[Any]:
        if self.emission_shape == "chunks":
            return [
                ToolCallChunkEvent(
                    type=EventType.TOOL_CALL_CHUNK,
                    tool_call_id=getattr(event, "tool_call_id", None),
                    tool_call_name=getattr(event, "tool_call_name", None),
                    parent_message_id=getattr(event, "parent_message_id", None),
                    delta=getattr(event, "delta", None),
                )
            ]
        # TODO(Parity lane): TOOL_CALL_START / _ARGS / _END triples — see
        # the note in ``_text_events``.
        raise NotImplementedError(
            "emission_shape='triples' is a Parity-lane placeholder; "
            "the StreamFrame migration ships the behavior-preserving "
            "'chunks' shape only."
        )

    # -- backend tool execution -------------------------------------------

    def _backend_tool_events(self, event: Any) -> list[Any]:
        """Surface one completed backend tool call + its result, atomically.

        crewai reports a completed backend tool via one ``finished`` event
        carrying the name, args, and output (a terminal failure lands its error
        text in ``output``). We emit discrete START/ARGS/END/RESULT (like the MCP
        path: the call is not streamed and the full args are known up front)
        under a synthesized ``tool_call_id`` shared by every event and the
        snapshot pair. ``parent_message_id`` on START ties the call to the
        assistant message the snapshot pair re-supplies under the SAME id, so the
        client keys the streamed and snapshot copies identically (no remount at
        method-finish). The snapshot pair keeps the card alive past the
        authoritative method-finish MESSAGES_SNAPSHOT.
        """
        tool_name = getattr(event, "tool_name", None) or "tool"
        args_json = self._tool_args_to_json(getattr(event, "tool_args", None))
        content = self._stringify_tool_output(getattr(event, "output", None))
        tool_call_id = uuid.uuid4().hex
        assistant_message_id = uuid.uuid4().hex
        result_message_id = uuid.uuid4().hex

        events: list[Any] = self._backend_tool_open_events(
            tool_call_id, tool_name, args_json,
            parent_message_id=assistant_message_id,
        )
        events.append(
            ToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                message_id=result_message_id,
                tool_call_id=tool_call_id,
                content=content,
                role="tool",
            )
        )
        self._record_backend_tool_messages(
            assistant_message_id=assistant_message_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            args_json=args_json,
            result_message_id=result_message_id,
            content=content,
        )
        return events

    def _record_backend_tool_messages(
        self,
        *,
        assistant_message_id: str,
        tool_call_id: str,
        tool_name: str,
        args_json: str,
        result_message_id: str,
        content: str,
    ) -> None:
        """Stash the AssistantMessage(tool_call) + ToolMessage for the snapshot.

        The AssistantMessage id equals the streamed ``parent_message_id`` and the
        tool_call_id / result id equal the streamed events', so the snapshot copy
        REPLACES the streamed copy under the same ids (one consistent card, no
        remount or duplicate render).
        """
        self._backend_tool_messages.append(
            AssistantMessage(
                id=assistant_message_id,
                role="assistant",
                tool_calls=[
                    ToolCall(
                        id=tool_call_id,
                        type="function",
                        function=FunctionCall(name=tool_name, arguments=args_json),
                    )
                ],
            )
        )
        self._backend_tool_messages.append(
            ToolMessage(
                id=result_message_id,
                role="tool",
                tool_call_id=tool_call_id,
                content=content,
            )
        )

    def _merge_backend_tool_messages(self, messages: list[Any]) -> list[Any]:
        """Insert accumulated backend tool messages into a snapshot message list.

        Inserted right after the LEADING system/user preamble (natural order:
        system? -> user -> tool call -> tool result -> assistant answer). The
        id-dedup is defensive: these ids are translator-minted and never appear
        in the state-derived snapshot, so it is currently a no-op guard against a
        flow that later copies them into ``state.messages``.
        """
        if not self._backend_tool_messages:
            return messages
        existing_ids = {getattr(m, "id", None) for m in messages}
        to_insert = [
            m
            for m in self._backend_tool_messages
            if getattr(m, "id", None) not in existing_ids
        ]
        if not to_insert:
            return messages
        # Anchor on the leading preamble only: stop at the first non-system/user
        # message so the tool call is never spliced past later assistant/tool
        # turns (which a whole-list scan would do once history accumulates).
        insert_at = 0
        for m in messages:
            if getattr(m, "role", None) in ("system", "user"):
                insert_at += 1
            else:
                break
        return messages[:insert_at] + to_insert + messages[insert_at:]

    def _backend_tool_open_events(
        self,
        tool_call_id: str,
        tool_name: str,
        args_json: str,
        *,
        parent_message_id: str,
    ) -> list[Any]:
        """Discrete START/ARGS/END for a backend tool call.

        Emitted as triples, not chunks: like the MCP path, the call is not
        streamed and the full args are known up front, so the canonical discrete
        shape is the natural fit. ``parent_message_id`` on START ties the call to
        the assistant message the snapshot re-supplies under the same id.
        """
        return [
            ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name=tool_name,
                parent_message_id=parent_message_id,
            ),
            ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta=args_json,
            ),
            ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id,
            ),
        ]

    @staticmethod
    def _tool_args_to_json(tool_args: Any) -> str:
        """Serialize crewai ``tool_args`` (``dict | str``) to a JSON string.

        A string is passed through verbatim (crewai already hands us the raw
        args string in that case); a dict is JSON-encoded. Anything
        unserializable degrades to ``{}`` (logged) rather than crashing the
        stream.
        """
        if isinstance(tool_args, str):
            return tool_args
        if tool_args is None:
            return "{}"
        try:
            return json.dumps(tool_args, default=str)
        except (TypeError, ValueError):
            _LOGGER.warning(
                "ag-ui-crewai: could not JSON-encode backend tool args "
                "(type=%s); emitting empty args.",
                type(tool_args).__name__,
            )
            return "{}"

    @staticmethod
    def _stringify_tool_output(output: Any) -> str:
        """Coerce a crewai tool ``output`` to ``str`` content for the wire.

        crewai already stringifies output (its ``_format_result`` returns
        ``str(result)``), so a str is the normal path and its JSON validity is
        the tool author's job. The dict / pydantic branches are defensive:
        structured output is JSON-encoded, falling back to ``str()`` (logged) if
        that fails.
        """
        if output is None:
            return ""
        if isinstance(output, str):
            return output
        if hasattr(output, "model_dump"):
            try:
                return json.dumps(output.model_dump(), default=str)
            except (TypeError, ValueError):
                _LOGGER.warning(
                    "ag-ui-crewai: could not JSON-encode backend tool output "
                    "(type=%s); falling back to str().",
                    type(output).__name__,
                )
                return str(output)
        try:
            return json.dumps(output, default=str)
        except (TypeError, ValueError):
            _LOGGER.warning(
                "ag-ui-crewai: could not JSON-encode backend tool output "
                "(type=%s); falling back to str().",
                type(output).__name__,
            )
            return str(output)


# Event types the translator recognises. Used to decide whether an event is
# "unmapped" and therefore eligible for RAW passthrough: an event we DO map but
# deliberately suppress must not leak out as a RAW event as well.
_RECOGNIZED_EVENT_TYPES = frozenset(
    {
        _FLOW_STARTED,
        _FLOW_FINISHED,
        _METHOD_STARTED,
        _METHOD_FINISHED,
        EventType.TEXT_MESSAGE_CHUNK,
        EventType.TOOL_CALL_CHUNK,
        EventType.CUSTOM,
        EventType.STATE_SNAPSHOT,
        # Reasoning lifecycle from the litellm path (Bridged* events, mapped 1:1).
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
        EventType.REASONING_ENCRYPTED_VALUE,
    }
)

# Source tag on emitted RAW events, so a consumer can tell CrewAI passthrough apart
# from other producers' raw channels.
_RAW_SOURCE = "crewai"

# One WARNING per process for the first RAW-passthrough loss, then DEBUG. An
# operator who turned RAW on is debugging something and would never see a
# DEBUG-only drop, but a per-event WARNING under sustained pressure is its own
# problem.
_RAW_LOSS_WARNED = False


def log_raw_loss(message: str, *args: Any) -> None:
    """Log a RAW-passthrough loss: WARNING the first time, DEBUG thereafter."""
    global _RAW_LOSS_WARNED  # pylint: disable=global-statement
    if _RAW_LOSS_WARNED:
        _LOGGER.debug(message, *args)
        return
    _RAW_LOSS_WARNED = True
    _LOGGER.warning(message, *args)


def is_recognized_event(event: Any) -> bool:
    """True when the translator maps this event, so RAW must not duplicate it.

    Covers every mapped channel: the base lifecycle / bridge types above, plus
    the crew/agent lifecycle, backend ToolUsage, MCP events, and crewai's native
    thinking-chunk event (all matched by their own predicates). Without these a
    mapped event would ALSO be RAW-mirrored under ``emit_raw_events=True`` (a
    double emit) -- notably the native ``llm_thinking_chunk``, which the sink
    parks for TRANSLATION to REASONING_*; the deliberately suppressed
    ``tool_usage_started`` would likewise leak as RAW.
    """
    event_type = getattr(event, "type", None)
    return (
        event_type in _RECOGNIZED_EVENT_TYPES
        or event_type in CREW_AGENT_LIFECYCLE_TYPES
        or is_backend_tool_event(event)
        or is_mcp_event(event)
        or is_thinking_event(event)
    )


def raw_event_for(event: Any) -> RawEvent | None:
    """Wrap an unmapped crewai event as an AG-UI ``RAW`` event.

    Payload preference order:

    1. ``model_dump(mode="json")`` - every crewai event is a Pydantic model, and
       ``mode="json"`` resolves enums / datetimes for us.
    2. the event's own ``__dict__``, filtered to JSON-safe scalars and containers.

    A RAW passthrough must never be able to break the run, so a payload we cannot
    build at all yields ``None`` (the caller drops the mirror) rather than raising
    into the driver's event loop.
    """
    event_type = getattr(event, "type", None)
    if event_type is None:
        return None

    payload: Any = None
    model_dump = getattr(event, "model_dump", None)
    if callable(model_dump):
        try:
            payload = model_dump(mode="json")
        except Exception as dump_exc:  # noqa: BLE001 - falls back below
            # Surface WHY the richer payload was unavailable; silence made a degraded
            # RAW payload indistinguishable from a complete one.
            _LOGGER.debug(
                "ag-ui-crewai RAW passthrough could not model_dump a %r event (%s); "
                "falling back to instance attributes",
                event_type,
                type(dump_exc).__name__,
            )
            payload = None

    if payload is None:
        source_dict = getattr(event, "__dict__", None)
        if isinstance(source_dict, dict):
            payload = {
                key: value
                for key, value in source_dict.items()
                if not key.startswith("_")
                and isinstance(value, (str, int, float, bool, type(None), list, dict))
            }

    if payload is None:
        return None
    if not isinstance(payload, dict):
        payload = {"value": payload}
    payload.setdefault("type", str(event_type))
    return RawEvent(type=EventType.RAW, event=payload, source=_RAW_SOURCE)
