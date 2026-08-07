import logging
import re
import uuid
import json
from copy import deepcopy
from dataclasses import dataclass
from typing import Optional, List, Any, Union, AsyncGenerator, Generator, Literal, Dict, TypedDict
from typing_extensions import NotRequired, Self
import inspect

from langgraph.graph.state import CompiledStateGraph

try:
    from langchain.schema import BaseMessage, SystemMessage, ToolMessage
except ImportError:
    # Langchain >= 1.0.0
    from langchain_core.messages import BaseMessage, SystemMessage, ToolMessage
    
from langchain_core.runnables import RunnableConfig, ensure_config
from langchain_core.runnables.config import merge_configs
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.types import Command

from .types import (
    State,
    MessagesInProgressRecord,
    SchemaKeys,
    MessageInProgress,
    ThinkingProcess,
    RunMetadata,
    LangGraphEventTypes,
    CustomEventNames,
    LangGraphReasoning
)
from .utils import (
    agui_messages_to_langchain,
    DEFAULT_SCHEMA_KEYS,
    filter_object_by_schema_keys,
    get_stream_payload_input,
    langchain_messages_to_agui,
    resolve_reasoning_content,
    resolve_encrypted_reasoning_content,
    resolve_message_content,
    camel_to_snake,
    json_safe_stringify,
    make_json_safe,
    normalize_tool_content
)

from ag_ui.core import (
    EventType,
    AssistantMessage,
    FunctionCall,
    ToolCall as AGUIToolCall,
    ToolMessage as AGUIToolMessage,
    ReasoningMessage,
    CustomEvent,
    Interrupt as AGUIInterrupt,
    MessagesSnapshotEvent,
    RawEvent,
    ResumeEntry,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunFinishedInterruptOutcome,
    RunStartedEvent,
    StateDeltaEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
    ToolCallResultEvent,
    ReasoningStartEvent,
    ReasoningMessageStartEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningEndEvent,
    ReasoningEncryptedValueEvent,
    SubagentStartedEvent,
    SubagentFinishedEvent,
    SubagentErrorEvent,
)
from .interrupts import lg_interrupts_to_agui, DEFAULT_RESUME_SENTINEL_CANCELLED, DEFAULT_RESUME_SENTINEL_MAP
from ag_ui.encoder import EventEncoder
from ag_ui_a2ui_toolkit import split_a2ui_schema_context

ProcessedEvents = Union[
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ReasoningStartEvent,
    ReasoningMessageStartEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningEndEvent,
    ReasoningEncryptedValueEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    StateSnapshotEvent,
    StateDeltaEvent,
    MessagesSnapshotEvent,
    RawEvent,
    CustomEvent,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    StepStartedEvent,
    StepFinishedEvent,
]

logger = logging.getLogger(__name__)

ROOT_SUBGRAPH_NAME = "root"


@dataclass
class SubagentContext:
    subagent_id: str
    name: str
    parent_subagent_id: Optional[str] = None


# Lane key for root/supervisor-level streaming state (events with no subagent).
# Subagent lanes use the derived subagent id (e.g. "tools:<uuid>").
_ROOT_LANE = "__root__"


def _record_subagent_boundaries(ns: str, known: set) -> None:
    """Record `tools:<uuid>` segments that are genuine subagent boundaries.

    A boundary is a `tools:` segment directly followed by a non-`tools` node
    (the subagent's own model/middleware). A regular inner tool's ToolNode is a
    leaf (never followed by such a node), so it is never recorded — which is how
    a nested subagent is told apart from a subagent's own tool call.
    """
    if not ns:
        return
    segs = ns.split("|")
    for i, seg in enumerate(segs):
        if (
            seg.split(":")[0] == "tools"
            and i + 1 < len(segs)
            and segs[i + 1].split(":")[0] != "tools"
        ):
            known.add(seg)


def derive_subagent_context(
    ns: str,
    lc_agent_name: Optional[str],
    subgraphs,
    known_subagent_segments: Optional[set] = None,
) -> Optional[SubagentContext]:
    """Return a SubagentContext when an event originates inside a deepagents
    subagent, else None.

    Signals (confirmed via spike): a subagent event has a nested ('|') checkpoint
    namespace AND metadata lc_agent_name set. Declared subgraphs also nest but do
    not set lc_agent_name, so they are excluded (their root segment is in `subgraphs`).
    """
    if not lc_agent_name or not ns or "|" not in ns:
        return None
    leading = ns.split("|")[0]
    root_name = leading.split(":")[0]
    if root_name in subgraphs:
        return None  # declared subgraph, handled elsewhere
    segs = ns.split("|")
    # A `tools:<uuid>` segment is a genuine subagent boundary only when it is
    # directly followed by a non-`tools` node (the subagent's own model /
    # middleware) — a *regular* inner tool's ToolNode is a leaf and is never
    # followed by agent machinery. `known_subagent_segments` accumulates those
    # boundaries across the stream (see reconcile_subagents). The subagent chain
    # for this event is the boundary segments present in its ns, in order: the
    # deepest is the current subagent, the one above it is its parent. This
    # distinguishes a nested subagent (tools:A|tools:B|model) from a subagent's
    # own inner tool call (tools:A|tools:B|tools:C), which the naive
    # deepest-segment approach conflated.
    if known_subagent_segments:
        chain = [s for s in segs if s in known_subagent_segments]
        if chain:
            return SubagentContext(
                subagent_id=chain[-1],
                name=lc_agent_name,
                parent_subagent_id=chain[-2] if len(chain) >= 2 else None,
            )
    # Fallback (no accumulated boundary info, e.g. standalone callers): the
    # leading segment is the subagent, with no derivable parent.
    return SubagentContext(subagent_id=leading, name=lc_agent_name, parent_subagent_id=None)


# Event types that carry a `subagent_id` field and should be stamped with the
# currently active subagent id at the _dispatch_event chokepoint. Every in-window
# event is tagged so the stream is self-describing per event (a consumer never
# has to reconstruct attribution from a prior event's messageId/toolCallId).
# Excludes only the run-lifecycle events, MESSAGES_SNAPSHOT (its messages are
# tagged individually), and the SUBAGENT_* lifecycle events (which carry their
# own subagent_id explicitly). STATE_SNAPSHOT/STATE_DELTA are never emitted for a
# subagent (see the state-suppression in the stream loop), so they stay here only
# for the parent's benefit.
_SUBAGENT_ATTRIBUTABLE_EVENT_TYPES = frozenset({
    EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CHUNK,
    EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END,
    EventType.TOOL_CALL_START, EventType.TOOL_CALL_CHUNK, EventType.TOOL_CALL_RESULT,
    EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END,
    EventType.REASONING_START, EventType.REASONING_MESSAGE_START,
    EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_END,
    EventType.REASONING_END, EventType.REASONING_ENCRYPTED_VALUE,
    EventType.ACTIVITY_SNAPSHOT, EventType.ACTIVITY_DELTA,
    EventType.STATE_SNAPSHOT, EventType.STATE_DELTA,
    EventType.STEP_STARTED, EventType.STEP_FINISHED, EventType.CUSTOM, EventType.RAW,
})


def reconcile_subagents(active_run, ns, lc_agent_name, subgraphs) -> list:
    """Emit SUBAGENT_STARTED once per distinct subagent (deepagents runs task
    subagents concurrently, so their events interleave -- a toggle is NOT a finish).
    current_subagent_id tracks the CURRENT event's subagent for _dispatch_event
    stamping. SUBAGENT_FINISHED is emitted by drain_subagents before RUN_FINISHED
    (unique-started + all-closed-before-run-end is protocol-valid; precise per-subagent
    finish timing is deferred for this step)."""
    known = active_run.setdefault("subagent_segments", set())
    _record_subagent_boundaries(ns, known)
    ctx = derive_subagent_context(ns, lc_agent_name, subgraphs, known)
    new_id = ctx.subagent_id if ctx else None

    # SUBAGENT_FINISHED / SUBAGENT_ERROR are terminal for the id they name, so a
    # closed subagent may neither be re-opened nor own further output. Both closing
    # paths only REMOVE the id from active_subagents, so without this a single
    # trailing event bearing a finished subagent's namespace — its inner tooling can
    # emit after the `task` tool returns — re-opened it: two SUBAGENT_STARTED and two
    # terminals for one invocation, plus output attributed after a terminal.
    # Trailing events fall back to the parent lane instead.
    # Attribution follows the event's namespace even after that subagent closed. The
    # protocol deliberately allows a tag to name an already-finished subagent, so
    # blanking it here would silently reparent the subagent's trailing output — and its
    # state — to the parent, which is exactly what attribution exists to prevent. Only
    # the SUBAGENT_STARTED emission is gated, since re-opening a closed id would give one
    # invocation two starts and two terminals.
    active_run["current_subagent_id"] = new_id
    closed = active_run.setdefault("closed_subagents", set())

    events = []
    if (
        new_id is not None
        and new_id not in active_run["active_subagents"]
        and new_id not in closed
    ):
        # Prefer the declared subagent_type + description captured from the
        # `task` delegation tool (see _capture_subagent_task_meta); fall back to
        # the runtime lc_agent_name when no task metadata was captured.
        task_meta = (active_run.get("subagent_task_meta") or {}).get(new_id) or {}
        name = task_meta.get("name") or ctx.name
        description = task_meta.get("description")
        active_run["active_subagents"][new_id] = name
        # Remember this subagent's parent so, when it finishes, control (and
        # the `task` tool result attribution) returns to the parent rather than
        # the root. None for a top-level subagent (parent is the root).
        active_run.setdefault("subagent_parents", {})[new_id] = ctx.parent_subagent_id
        events.append(SubagentStartedEvent(
            type=EventType.SUBAGENT_STARTED,
            subagent_id=new_id,
            name=name,
            description=description,
            parent_subagent_id=ctx.parent_subagent_id,
            parent_tool_call_id=task_meta.get("parent_tool_call_id"),
            parent_message_id=task_meta.get("parent_message_id"),
        ))
    return events


def drain_subagents(active_run) -> list:
    """Emit SUBAGENT_FINISHED for any still-open subagents (before RUN_FINISHED)."""
    ids = list(active_run.get("active_subagents", {}).keys())
    events = [SubagentFinishedEvent(type=EventType.SUBAGENT_FINISHED, subagent_id=sid)
              for sid in ids]
    active_run["active_subagents"].clear()
    # Terminal for these ids — see reconcile_subagents.
    active_run.setdefault("closed_subagents", set()).update(ids)
    active_run["current_subagent_id"] = None
    return events


def error_open_subagents(active_run, message: str) -> list:
    """Emit SUBAGENT_ERROR for every still-open subagent and clear them.

    Used on both the in-band ``error`` event path and the hard-exception path so
    a subagent that was mid-flight when the run failed gets a terminal event
    (otherwise the client shows it running forever). Clearing ``active_subagents``
    also ensures a subsequent ``drain_subagents`` does NOT additionally emit
    SUBAGENT_FINISHED for the same subagent (contradictory error-then-finish).
    """
    if not active_run:
        return []
    ids = list(active_run.get("active_subagents", {}).keys())
    events = [SubagentErrorEvent(type=EventType.SUBAGENT_ERROR, subagent_id=sid, message=message)
              for sid in ids]
    active_run.get("active_subagents", {}).clear()
    # Terminal for these ids — see reconcile_subagents.
    active_run.setdefault("closed_subagents", set()).update(ids)
    active_run["current_subagent_id"] = None
    return events


class PreparedStream(TypedDict):
    """Payload returned by prepare_stream / prepare_regenerate_stream.

    ``stream`` is the graph's ``astream_events`` async iterator (or ``None``
    when the caller should only dispatch ``events_to_dispatch`` and return).
    ``state`` and ``config`` mirror the state and config used to build the
    stream. ``events_to_dispatch`` is an optional list of pre-built events
    for the short-circuit path (e.g. active interrupts with no resume).
    """
    stream: Optional[Any]
    state: Optional[Any]
    config: Optional[RunnableConfig]
    events_to_dispatch: NotRequired[Optional[List[ProcessedEvents]]]

class LangGraphAgent:
    def __init__(self, *, name: str, graph: CompiledStateGraph, description: Optional[str] = None, config:  Union[Optional[RunnableConfig], dict] = None, enable_legacy_on_interrupt_event: bool = True, emit_interrupt_outcome: bool = False, emit_raw_events: bool = True):
        self.name = name
        self.description = description
        self.graph = graph
        self.config = config or {}
        self.enable_legacy_on_interrupt_event = enable_legacy_on_interrupt_event
        # Opt-out for emitting the underlying LangGraph event on the wire.
        # It rides along two ways, both of which this flag controls:
        #   1. A full ``RawEvent`` (EventType.RAW) re-emitted for every streamed
        #      event — the dominant payload cost.
        #   2. The ``raw_event`` copy piggy-backed onto nearly every other
        #      emitted AG-UI event (re-serialized each time).
        # On graphs with large state this dominates payload size — Function
        # Health saw ~1.5 MB events (OSS-607). When False, (1) is not emitted
        # and (2) is dropped at dispatch. Default True preserves existing
        # debugging/compat behavior.
        self.emit_raw_events = emit_raw_events
        # Opt-in: terminate interrupted runs with the AG-UI structured outcome
        # RunFinishedEvent(outcome={"type": "interrupt", ...}). Default False so
        # released clients that resume via forwardedProps.command.resume keep
        # working until they adopt RunAgentInput.resume[] (the structured outcome
        # makes them stop sending a resume directive). See _emit_interrupt_finish.
        self.emit_interrupt_outcome = emit_interrupt_outcome
        self.messages_in_process: MessagesInProgressRecord = {}
        self.active_run: Optional[RunMetadata] = None
        self.constant_schema_keys = ['messages', 'tools']
        # Collect nodes bound to a CompiledStateGraph: those are the declared
        # subgraphs whose boundaries we attribute events to during streaming
        # (so mid-stream MESSAGES_SNAPSHOT can fire at the right transitions).
        # Nodes bound to plain callables / runnables are intentionally excluded.
        self.subgraphs: set = {
            name for name, node in self.graph.nodes.items()
            if isinstance(getattr(node, 'bound', None), CompiledStateGraph)
        }
        self.current_subgraph = ROOT_SUBGRAPH_NAME

    def clone(self) -> Self:
        """Create a fresh copy with clean per-request state.

        Subclasses that add required __init__ parameters must override clone()
        to pass those parameters through.
        """
        try:
            return type(self)(
                name=self.name,
                graph=self.graph,
                description=self.description,
                config=dict(self.config) if self.config else None,
                enable_legacy_on_interrupt_event=self.enable_legacy_on_interrupt_event,
                emit_interrupt_outcome=self.emit_interrupt_outcome,
                emit_raw_events=self.emit_raw_events,
            )
        except TypeError as exc:
            raise TypeError(
                f"{type(self).__name__} must override clone() or ensure its "
                f"__init__ accepts (name, graph, description, config) as "
                f"keyword arguments: {exc}"
            ) from exc

    def _dispatch_event(self, event: ProcessedEvents) -> ProcessedEvents:
        if event.type == EventType.RAW:
            event.event = make_json_safe(event.event)
        elif event.raw_event:
            if self.emit_raw_events:
                event.raw_event = make_json_safe(event.raw_event)
            else:
                # Drop the piggy-backed raw copy entirely (also skips the
                # make_json_safe pass). See emit_raw_events in __init__.
                event.raw_event = None

        active_run = getattr(self, "active_run", None)
        current_subagent_id = active_run.get("current_subagent_id") if active_run else None
        if (
            current_subagent_id
            and event.type in _SUBAGENT_ATTRIBUTABLE_EVENT_TYPES
            and getattr(event, "subagent_id", None) is None
        ):
            event.subagent_id = current_subagent_id

        self._accumulate_subagent_message(event)

        return event

    def _capture_task_tool_dispatch(self, event: dict) -> None:
        """Map each `task` ToolNode dispatch to its originating tool_call_id.

        Current LangChain ``create_agent`` schedules every pending tool call as
        its own ``Send("tools", [tool_call])``, so the ToolNode's
        ``on_chain_start`` carries that single tool call (with its id) in
        ``data.input`` and a ``langgraph_checkpoint_ns`` equal to the namespace
        the spawned subagent's own ``task`` ``on_tool_start`` reports. Recording
        ns -> tool_call_id here lets _capture_subagent_task_meta attach the
        EXACT spawning call to each subagent by namespace, instead of matching
        by FIFO order — which breaks when tool starts are reordered (async tool
        wrappers, per-call HITL interrupts, or even default concurrent
        scheduling). Only a single-call ToolNode dispatch is captured;
        batched/ambiguous shapes are left to the FIFO fallback.
        """
        if event.get("event") != LangGraphEventTypes.OnChainStart.value:
            return
        metadata = event.get("metadata") or {}
        if metadata.get("langgraph_node") != "tools" and event.get("name") != "tools":
            return
        node_input = (event.get("data") or {}).get("input")
        candidates: List[Any] = []
        if isinstance(node_input, list):
            candidates = node_input
        elif isinstance(node_input, dict):
            if node_input.get("type") == "tool_call":
                candidates = [node_input]
            elif isinstance(node_input.get("tool_call"), dict):
                candidates = [node_input["tool_call"]]
        task_calls = [
            c for c in candidates
            if isinstance(c, dict) and c.get("name") == "task" and isinstance(c.get("id"), str)
        ]
        # A single task call per ToolNode namespace is the unambiguous case.
        # Multiple in one namespace (older batched shapes) fall back to FIFO.
        if len(task_calls) != 1:
            return
        active_run = getattr(self, "active_run", None)
        if active_run is None:
            return
        tool_call_id = task_calls[0]["id"]
        ns = metadata.get("langgraph_checkpoint_ns")
        if ns:
            active_run.setdefault("task_tool_call_ids_by_ns", {})[ns] = tool_call_id

    def _capture_subagent_task_meta(self, event: dict) -> None:
        """Record a subagent invocation's declared name + description from the
        deepagents ``task`` delegation tool's ``on_tool_start``.

        The ``task`` tool executes in the subagent's own checkpoint namespace
        (e.g. ``tools:<uuid>``) — the same value ``derive_subagent_context``
        derives as the subagent id — and its input carries ``subagent_type`` and
        ``description``. Capturing it here (which runs before the subagent's own
        events trigger SUBAGENT_STARTED) lets that event report the declared
        subagent type and the per-invocation description. No-op for non-task
        tools and non-deepagents runs (input without ``subagent_type``).
        """
        if event.get("event") != LangGraphEventTypes.OnToolStart.value:
            return
        tool_input = (event.get("data") or {}).get("input")
        if not isinstance(tool_input, dict) or "subagent_type" not in tool_input:
            return
        # The task on_tool_start runs *in* the new subagent's own ToolNode, so the
        # deepest `tools:` segment of its ns is the new subagent's id (matches the
        # chain derivation in reconcile_subagents). Single-level: same as before.
        ns = (event.get("metadata") or {}).get("langgraph_checkpoint_ns", "")
        tool_segs = [s for s in ns.split("|") if s.split(":")[0] == "tools"] if ns else []
        subagent_id = tool_segs[-1] if tool_segs else (ns.split("|")[0] if ns else "")
        if not subagent_id:
            return
        active_run = getattr(self, "active_run", None)
        if active_run is None:
            return
        # Link this subagent back to the EXACT `task` call that spawned it,
        # keyed by the subagent's checkpoint namespace — which equals the
        # namespace of its per-call ToolNode dispatch captured in
        # _capture_task_tool_dispatch. This does not rely on FIFO emission
        # order (which tool-start reordering can violate). FIFO remains a
        # fallback ONLY when no per-call dispatch was captured for this exact
        # namespace (older/batched ToolNode shapes, or a renamed tool node).
        #
        # Note: we deliberately do NOT fall back to matching a ToolNode run_id
        # from parent_ids. The ns and the run_id are recorded together by the
        # same dispatch capture, so a namespace miss means this subagent's own
        # dispatch was never captured — and its own ToolNode run_id is likewise
        # absent. A parent_ids scan could then only match an *ancestor*
        # subagent's dispatch (e.g. a nested child matching its outer parent),
        # which is always wrong. FIFO is the correct degradation instead.
        pending = active_run.get("pending_task_calls") or []
        originating_tool_call_id = (active_run.get("task_tool_call_ids_by_ns") or {}).get(ns)
        task_call = {}
        if originating_tool_call_id is not None:
            match_index = next(
                (i for i, c in enumerate(pending)
                 if c.get("tool_call_id") == originating_tool_call_id),
                None,
            )
            if match_index is not None:
                task_call = pending.pop(match_index)
            else:
                # The exact call is known even if no streamed chunk supplied its
                # parent_message_id (e.g. tool-call emission not yet observed).
                task_call = {"tool_call_id": originating_tool_call_id}
        elif pending:
            task_call = pending.pop(0)
        active_run.setdefault("subagent_task_meta", {})[subagent_id] = {
            "name": tool_input.get("subagent_type"),
            "description": tool_input.get("description"),
            "parent_tool_call_id": task_call.get("tool_call_id"),
            "parent_message_id": task_call.get("parent_message_id"),
        }
        # Map this `task` invocation's run_id to its subagent_id so the matching
        # OnToolEnd can finish exactly this subagent (see
        # _finish_subagent_on_task_end). The subagent's own inner tools (grep,
        # write_file, …) share its checkpoint namespace, so ns matching alone
        # would finish it prematurely; the run_id is unique to the task call.
        run_id = event.get("run_id")
        if run_id:
            active_run.setdefault("subagent_task_runs", {})[run_id] = subagent_id

    def _finish_subagent_on_task_end(self, event: dict) -> list:
        """Emit SUBAGENT_FINISHED when a deepagents ``task`` delegation returns.

        The subagent's lifecycle is exactly the lifespan of the ``task`` tool
        that spawned it: its OnToolEnd fires once the subagent has produced all
        of its output and control returns to the supervisor. Finishing here —
        rather than in ``drain_subagents`` at RUN_FINISHED — makes the reported
        subagent status track the subagent itself, not the parent run. Matched
        by the run_id recorded in _capture_subagent_task_meta so only the task
        call (not the subagent's inner tool calls, which share its namespace)
        triggers the finish. No-op for non-task tool ends.
        """
        if event.get("event") != LangGraphEventTypes.OnToolEnd.value:
            return []
        active_run = getattr(self, "active_run", None)
        if active_run is None:
            return []
        run_id = event.get("run_id")
        subagent_id = (active_run.get("subagent_task_runs") or {}).pop(run_id, None)
        if not subagent_id:
            return []
        if subagent_id not in active_run.get("active_subagents", {}):
            return []
        del active_run["active_subagents"][subagent_id]
        # Terminal for this id — see reconcile_subagents.
        active_run.setdefault("closed_subagents", set()).add(subagent_id)
        # Control returns to the subagent that INVOKED this one: the `task`
        # tool's result (and any further events at this level) belongs to the
        # parent, not the root. Restore current_subagent_id to the finishing
        # subagent's parent — None for a top-level subagent, so single-level
        # behavior (result attributed to root) is unchanged.
        parent_subagent_id = (active_run.get("subagent_parents") or {}).pop(subagent_id, None)
        if active_run.get("current_subagent_id") == subagent_id:
            active_run["current_subagent_id"] = parent_subagent_id
        # The subagent's output is the `task` tool's result. deepagents returns a
        # Command whose state update carries the ToolMessage; surface its content
        # as the finished subagent's `result` (mirrors RUN_FINISHED.result).
        result = None
        output = (event.get("data") or {}).get("output")
        update = getattr(output, "update", None)
        if isinstance(update, dict):
            msgs = update.get("messages")
            if msgs:
                result = getattr(msgs[0], "content", None)
        return [SubagentFinishedEvent(
            type=EventType.SUBAGENT_FINISHED, subagent_id=subagent_id, result=result,
        )]

    def _accumulate_subagent_message(self, event: ProcessedEvents) -> None:
        """Accumulate subagent-attributed messages — text, tool calls, and tool
        results — as they stream, keyed by message id, on
        ``active_run["subagent_messages"]``.

        These messages live only in the subagent's (subgraph) checkpoint, not
        in the main/supervisor graph state, so the MESSAGES_SNAPSHOT built from
        main-graph state omits them — and applying that snapshot client-side
        wipes the streamed subagent messages. Capturing them here lets
        ``get_state_and_messages_snapshots`` merge them back in with their
        ``subagent_id`` preserved, so both subagent text and tool-call
        attribution survive a snapshot apply. This is a no-op for runs without
        subagents (the tracking dicts stay empty), so normal runs and
        declared-subgraph runs keep an identical snapshot.

        TOOL_CALL_START / TOOL_CALL_RESULT are stamped with the active
        subagent_id upstream (see _dispatch_event); TOOL_CALL_ARGS is a
        continuation event carrying only tool_call_id, so it is routed back to
        its owning assistant entry via ``subagent_tool_call_owner``.
        """
        active_run = getattr(self, "active_run", None)
        if active_run is None:
            return
        sub_msgs = active_run.get("subagent_messages")
        if sub_msgs is None:
            return
        tc_owner = active_run.get("subagent_tool_call_owner")
        if tc_owner is None:
            return
        etype = event.type

        def ensure_assistant_entry(message_id: str, subagent_id: str) -> dict:
            entry = sub_msgs.get(message_id)
            if entry is None:
                entry = sub_msgs[message_id] = {
                    "kind": "assistant",
                    "id": message_id,
                    "role": "assistant",
                    "content": "",
                    "subagent_id": subagent_id,
                    "tool_calls": {},
                }
            return entry

        if etype == EventType.REASONING_MESSAGE_START and getattr(event, "subagent_id", None):
            # A subagent's reasoning lives only in its subgraph checkpoint, exactly like
            # its text and tool calls, so it is absent from the main-graph
            # MESSAGES_SNAPSHOT and the client's snapshot apply would drop the streamed
            # reasoning message. The parent's reasoning does survive (utils converts
            # LangChain reasoning content blocks into ReasoningMessages), so without this
            # a subagent's reasoning was the one kind that vanished at snapshot time.
            entry = sub_msgs.get(event.message_id)
            if entry is None:
                sub_msgs[event.message_id] = {
                    "kind": "reasoning",
                    "id": event.message_id,
                    "role": "reasoning",
                    "content": "",
                    "encrypted_value": None,
                    "subagent_id": event.subagent_id,
                }
        elif etype == EventType.REASONING_MESSAGE_CONTENT:
            entry = sub_msgs.get(event.message_id)
            if entry is not None and entry.get("kind") == "reasoning":
                entry["content"] += getattr(event, "delta", "") or ""
        elif etype == EventType.REASONING_ENCRYPTED_VALUE:
            # The protected signature rides on its own event, keyed by entity_id. Without
            # capturing it here the reconstructed snapshot message carries content but no
            # encrypted_value — and because a snapshot containing the reasoning message
            # looks authoritative, the client replaces the streamed one and the signature
            # is lost. Only "message" subtype belongs to a reasoning message; "tool-call"
            # values belong to a tool call.
            if getattr(event, "subtype", None) == "message":
                entry = sub_msgs.get(getattr(event, "entity_id", None))
                if entry is not None and entry.get("kind") == "reasoning":
                    entry["encrypted_value"] = getattr(event, "encrypted_value", None)
        elif etype == EventType.TEXT_MESSAGE_START and getattr(event, "subagent_id", None):
            entry = ensure_assistant_entry(event.message_id, event.subagent_id)
            entry["role"] = getattr(event, "role", "assistant") or "assistant"
        elif etype == EventType.TEXT_MESSAGE_CONTENT:
            entry = sub_msgs.get(event.message_id)
            if entry is not None and entry.get("kind") == "assistant":
                entry["content"] += event.delta or ""
        elif etype == EventType.TOOL_CALL_START and getattr(event, "subagent_id", None):
            message_id = event.parent_message_id or event.tool_call_id
            entry = ensure_assistant_entry(message_id, event.subagent_id)
            entry["tool_calls"][event.tool_call_id] = {
                "id": event.tool_call_id,
                "name": event.tool_call_name,
                "arguments": "",
            }
            tc_owner[event.tool_call_id] = message_id
        elif etype == EventType.TOOL_CALL_ARGS:
            message_id = tc_owner.get(event.tool_call_id)
            entry = sub_msgs.get(message_id) if message_id is not None else None
            if entry is not None and entry.get("kind") == "assistant":
                tool_call = entry["tool_calls"].get(event.tool_call_id)
                if tool_call is not None:
                    tool_call["arguments"] += event.delta or ""
        elif etype == EventType.TOOL_CALL_RESULT and getattr(event, "subagent_id", None):
            sub_msgs[event.message_id] = {
                "kind": "tool",
                "id": event.message_id,
                "content": event.content or "",
                "tool_call_id": event.tool_call_id,
                "subagent_id": event.subagent_id,
            }

    async def run(self, input: RunAgentInput) -> AsyncGenerator[ProcessedEvents, None]:
        # Normalize camelCase keys from the frontend to snake_case before forwarding.
        # Required for all downstream forwarded_props consumers (node_name, stream_subgraphs,
        # command.resume). Removing this conversion would silently break streaming options
        # forwarded from JavaScript callers without raising an obvious error.
        forwarded_props = {}
        if hasattr(input, "forwarded_props") and input.forwarded_props:
            forwarded_props = {
                camel_to_snake(k): v for k, v in input.forwarded_props.items()
            }

        # Split subagent-attributed messages out of the graph input. They are
        # display-only — each subagent's internal text and tool calls — and live
        # in the subagent's own subgraph checkpoint, never the main graph's. The
        # client echoes the full history back on every turn, so leaving them in
        # would make the main-graph merge treat them as new messages (their ids
        # are never in the main checkpoint) and append them to the supervisor's
        # state, polluting it with orphan subagent tool calls that grow each
        # turn. The supervisor's own messages carry no subagent_id, so they stay
        # in the graph input. The subagent messages are stashed and re-emitted in
        # the MESSAGES_SNAPSHOT (see _merge_subagent_messages) so they persist in
        # the client's display across turns without ever entering graph state.
        graph_messages = []
        inbound_subagent_messages = []
        for m in input.messages or []:
            # `is not None`, not truthiness: an empty string is a valid opaque
            # subagent_id, and treating it as absent would put a subagent's internal
            # message into the supervisor's graph state — the pollution this split exists
            # to prevent.
            if getattr(m, "subagent_id", None) is not None:
                inbound_subagent_messages.append(m)
            else:
                graph_messages.append(m)
        self._inbound_subagent_messages = inbound_subagent_messages

        update: dict = {"forwarded_props": forwarded_props}
        if input.messages:
            update["messages"] = graph_messages

        async for event_str in self._handle_stream_events(input.model_copy(update=update)):
            yield event_str

    async def _handle_stream_events(self, input: RunAgentInput) -> AsyncGenerator[ProcessedEvents, None]:
        thread_id = input.thread_id or str(uuid.uuid4())
        INITIAL_ACTIVE_RUN: RunMetadata = {
            "id": input.run_id,
            "thread_id": thread_id,
            "mode": "start",
            "reasoning_processes": {},
            "pending_reasoning_ids": {},
            "current_text_message_ids": {},
            "current_text_message_nodes": {},
            "node_name": None,
            "has_function_streaming": False,
            "streamed_tool_call_ids": set(),
            "model_made_tool_call": False,
            "state_reliable": True,
            "active_subagents": {},
            "current_subagent_id": None,
            "subagent_task_meta": {},
            "subagent_task_runs": {},
            "subagent_parents": {},
            "pending_task_calls": [],
            "seen_task_call_ids": set(),
            "task_tool_call_ids_by_ns": {},
            "subagent_segments": set(),
            "subagent_messages": {},
            "subagent_tool_call_owner": {},
            # Subagent messages the client echoed back from prior turns, split
            # out of the graph input in run(). Re-emitted in the snapshot so
            # they persist in the display without entering graph state.
            "inbound_subagent_messages": getattr(self, "_inbound_subagent_messages", []) or [],
        }
        self.active_run = INITIAL_ACTIVE_RUN
        try:

            forwarded_props = input.forwarded_props
            node_name_input = forwarded_props.get('node_name', None) if forwarded_props else None

            self.active_run["manually_emitted_state"] = None

            config = ensure_config(self.config.copy() if self.config else {})
            config["configurable"] = {**(config.get('configurable', {})), "thread_id": thread_id}

            agent_state = await self.graph.aget_state(config)
            command_input = forwarded_props.get('command', {}) if forwarded_props else {}
            legacy_command_resume = (
                command_input.get('resume', None) if isinstance(command_input, dict) else None
            )
            legacy_has_resume = (
                isinstance(command_input, dict)
                and 'resume' in command_input
                and legacy_command_resume is not None
            )
            agui_resume = list(input.resume) if input.resume else None
            if agui_resume is not None and legacy_has_resume:
                logger.warning(
                    "both input.resume and forwardedProps.command.resume were provided; "
                    "input.resume wins (thread_id=%r, run_id=%r)",
                    thread_id, self.active_run.get("id"),
                )
            if legacy_has_resume and agui_resume is None:
                logger.warning(
                    "forwardedProps.command.resume is deprecated; please send "
                    "RunAgentInput.resume[] (thread_id=%r, run_id=%r)",
                    thread_id, self.active_run.get("id"),
                )
            # Truthiness, not `is not None`: an empty resume list means "no
            # resume" (consistent with treating an absent resume as no-resume),
            # so it must not suppress the regenerate / interrupt paths.
            has_resume_input = bool(agui_resume) or legacy_has_resume
            # active_run was just reset to INITIAL_ACTIVE_RUN above, so
            # active_run["node_name"] is always None here — the else branch
            # was dead code. Resolve to None directly to make the intent
            # explicit.
            node_name_for_mode = node_name_input if (node_name_input and node_name_input != "__end__") else None

            if not has_resume_input and thread_id and node_name_for_mode:
                self.active_run["mode"] = "continue"
                self.active_run["node_name"] = node_name_for_mode
            else:
                self.active_run["mode"] = "start"

            prepared_stream_response = await self.prepare_stream(input=input, agent_state=agent_state, config=config)

            state = prepared_stream_response["state"]
            stream = prepared_stream_response["stream"]
            config = prepared_stream_response["config"]
            events_to_dispatch = prepared_stream_response.get('events_to_dispatch', None)

            if events_to_dispatch is not None and len(events_to_dispatch) > 0:
                for event in events_to_dispatch:
                    yield self._dispatch_event(event)
                return

            if node_name_input and self.active_run.get("mode") == "continue":
                self.active_run["node_name"] = None

            yield self._dispatch_event(
                RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=self.active_run["id"])
            )
            # handle_node_change is a generator; discarding the return value
            # silently dropped its STEP_STARTED/STEP_FINISHED events and
            # skipped the active_run["node_name"] state update. Iterate so
            # the state update runs and any emitted events reach the client.
            for ev in self.handle_node_change(node_name_input):
                yield ev

            # In case of resume (interrupt), re-start resumed step
            if has_resume_input and self.active_run.get("node_name"):
                for ev in self.handle_node_change(self.active_run.get("node_name")):
                    yield ev

            should_exit = False
            current_graph_state = state

            async for event in stream:
                subgraphs_stream_enabled = input.forwarded_props.get('stream_subgraphs', True) if input.forwarded_props else True
                ns = (event.get("metadata") or {}).get("langgraph_checkpoint_ns", "")
                # Derive which subgraph (if any) owns this event.
                # ns format: "" | "node:uuid" | "node:uuid|inner:uuid"
                # Only the outermost namespace matters here — we just need to
                # know which declared subgraph owns the event for boundary
                # transitions; inner-graph nesting doesn't affect that decision.
                ns_root = ns.split("|")[0].split(":")[0] if ns else ""
                current_subgraph = ns_root if ns_root in self.subgraphs else None

                # Legacy detection (LangGraph < 0.6): subgraph events use stream mode names as event types
                is_subgraph_stream = (subgraphs_stream_enabled and (
                    event.get("event", "").startswith("events") or
                    event.get("event", "").startswith("values")
                ))
                # Modern detection (LangGraph >= 0.6): subgraph if inside one (|) or at its boundary
                if not is_subgraph_stream and ("|" in ns or current_subgraph is not None):
                    is_subgraph_stream = True

                graph_context = current_subgraph if current_subgraph else ROOT_SUBGRAPH_NAME

                if is_subgraph_stream and current_subgraph != self.current_subgraph:
                    self.current_subgraph = current_subgraph
                    # Every time a subgraph changes, we need to update the state and messages snapshots.
                    async for ev in self.get_state_and_messages_snapshots(config):
                        yield ev

                # Record each `task` ToolNode dispatch (its on_chain_start
                # precedes the task's on_tool_start) so the subagent can be
                # linked to its EXACT spawning tool call by namespace, not FIFO.
                self._capture_task_tool_dispatch(event)
                # Capture declared subagent name/description from the `task`
                # tool BEFORE reconcile_subagents fires SUBAGENT_STARTED for the
                # subagent it spawns (task on_tool_start precedes the subagent's
                # own events in the stream).
                self._capture_subagent_task_meta(event)

                lc_agent_name = (event.get("metadata") or {}).get("lc_agent_name")
                for sub_ev in reconcile_subagents(self.active_run, ns, lc_agent_name, self.subgraphs):
                    yield self._dispatch_event(sub_ev)

                # Finish a subagent as soon as its `task` delegation returns, so
                # its reported status tracks the subagent's own lifecycle rather
                # than waiting for drain_subagents at RUN_FINISHED.
                for sub_ev in self._finish_subagent_on_task_end(event):
                    yield self._dispatch_event(sub_ev)

                if event["event"] == "error":
                    # Upstream "error" events do not always carry a
                    # data.message field; a hard subscript here crashed
                    # the error path itself. Fall back to a generic
                    # message and log the raw event so the real payload
                    # is recoverable.
                    error_data = event.get("data") or {}
                    error_message = error_data.get("message") if isinstance(error_data, dict) else None
                    if not error_message:
                        logger.warning(
                            "Upstream error event missing data.message: %r", event
                        )
                        error_message = "Unknown error"
                    # Terminate every open subagent with SUBAGENT_ERROR (not just
                    # the current one — deepagents runs them concurrently) and
                    # clear them so the drain below can't also emit a
                    # contradictory SUBAGENT_FINISHED for a subagent that errored.
                    for sub_ev in error_open_subagents(self.active_run, error_message):
                        yield self._dispatch_event(sub_ev)
                    yield self._dispatch_event(
                        RunErrorEvent(type=EventType.RUN_ERROR, message=error_message, raw_event=event)
                    )
                    break

                current_node_name = (event.get("metadata") or {}).get("langgraph_node")
                event_type = event.get("event")
                event_run_id = event.get("run_id")
                if isinstance(event_run_id, str) and event_run_id:
                    # LangGraph's internal chain run_id. Track it separately
                    # rather than overwriting active_run["id"] (the
                    # client-supplied run_id from RunAgentInput): clobbering it
                    # made RUN_FINISHED carry the chain UUID while RUN_STARTED
                    # carried the client id, so the two disagreed (#1582). The
                    # client id is what the protocol must echo back.
                    self.active_run["langgraph_run_id"] = event_run_id
                elif event_run_id is not None:
                    # Shape mismatch: some upstream emitted a non-string run_id.
                    # Keep the existing id rather than corrupting it.
                    logger.warning(
                        "Ignoring non-string run_id on event (type=%r, run_id=%r)",
                        event_type,
                        event_run_id,
                    )
                exiting_node = False

                if event_type == "on_chain_end" and isinstance(
                        event.get("data", {}).get("output"), dict
                ):
                    output = event["data"]["output"]
                    current_graph_state.update(output)
                    exiting_node = self.active_run["node_name"] == current_node_name
                    # If output contains any key outside the protocol-internal set
                    # ("messages", "tools", "ag-ui"), the local current_graph_state
                    # is reliably up-to-date again.
                    if any(k not in ("messages", "tools", "ag-ui") for k in output):
                        self.active_run["state_reliable"] = True

                should_exit = should_exit or (
                        event_type == "on_custom_event" and
                        event["name"] == CustomEventNames.Exit
                    )

                if current_node_name and current_node_name != self.active_run.get("node_name"):
                    for ev in self.handle_node_change(current_node_name):
                        yield ev

                # Track whether the current model turn is making a predict_state tool
                # call so we can suppress the model-node exit snapshot.  The model-node
                # exit fires *before* the tool runs, so current_graph_state still
                # carries the previous value — emitting it would wipe predict_state
                # progress on the client.  This applies to every iteration, not just
                # the first.  Note: _handle_single_event uses the same predict_state
                # metadata check to emit the PredictState custom event — keep both
                # sites in sync if the check logic changes.
                if event_type == LangGraphEventTypes.OnChatModelStream.value:
                    chunk = event.get("data", {}).get("chunk") or {}
                    tool_call_chunks = (
                        chunk.get("tool_call_chunks") or []
                        if isinstance(chunk, dict)
                        else getattr(chunk, "tool_call_chunks", None) or []
                    )
                    if tool_call_chunks:
                        first = tool_call_chunks[0]
                        first_name = (
                            first.get("name") if isinstance(first, dict)
                            else getattr(first, "name", None)
                        )
                        if first_name:
                            predict_state_meta = (event.get("metadata") or {}).get("predict_state", [])
                            tool_used_to_predict_state = any(
                                (p.get("tool") if isinstance(p, dict) else getattr(p, "tool", None)) == first_name
                                for p in predict_state_meta
                            )
                            if tool_used_to_predict_state:
                                self.active_run["model_made_tool_call"] = True

                # Explicit ``is None`` check: an empty dict (``{}``) is a
                # legitimate manually-emitted state ("reset to empty") and must
                # not be silently coerced back to current_graph_state by a
                # truthy ``or`` fallback.
                manually_emitted = self.active_run.get("manually_emitted_state")
                updated_state = manually_emitted if manually_emitted is not None else current_graph_state
                has_state_diff = updated_state != state
                if exiting_node or (has_state_diff and not self.has_any_message_in_progress(self.active_run["id"])):
                    state = updated_state
                    self.active_run["prev_node_name"] = self.active_run["node_name"]
                    current_graph_state.update(updated_state)
                    mmtc = self.active_run.get("model_made_tool_call")
                    state_reliable = self.active_run.get("state_reliable", True)
                    suppressed = exiting_node and (mmtc or not state_reliable)
                    if suppressed:
                        logger.debug(
                            "Suppressing node-exit STATE_SNAPSHOT (node=%s, model_made_tool_call=%s, state_reliable=%s)",
                            self.active_run.get("node_name"),
                            mmtc,
                            state_reliable,
                        )
                        self.active_run["model_made_tool_call"] = False
                        if mmtc:
                            # A predict_state tool call was detected — the tool has
                            # not yet run, so current_graph_state does not yet reflect
                            # the forthcoming state update.
                            self.active_run["state_reliable"] = False
                    elif self.active_run.get("current_subagent_id"):
                        # Subagents don't emit STATE_SNAPSHOT — only the parent
                        # agent's state is surfaced. The subagent's messages still
                        # reach the client via MESSAGES_SNAPSHOT, so nothing is lost.
                        # The lane survives a close (see reconcile_subagents), so a
                        # trailing event from a finished subagent stays suppressed.
                        pass
                    else:
                        yield self._dispatch_event(
                            StateSnapshotEvent(
                                type=EventType.STATE_SNAPSHOT,
                                snapshot=self.get_state_snapshot(state),
                                raw_event=event,
                            )
                        )

                # The RAW passthrough re-emits the entire underlying LangGraph
                # event as a first-class event — the dominant payload cost on
                # large-state graphs. Suppress it entirely when opted out
                # (emit_raw_events=False); see __init__.
                if self.emit_raw_events:
                    yield self._dispatch_event(
                        RawEvent(type=EventType.RAW, event=event)
                    )

                async for single_event in self._handle_single_event(event, state):
                    yield single_event

            state = await self.graph.aget_state(config)

            # state.tasks can be None on some checkpointers; the previous
            # len() call crashed in that case. A plain truthiness check
            # handles both "None" and "empty tuple/list" uniformly.
            tasks = state.tasks if state.tasks else None
            interrupts = self._collect_interrupts(state.tasks)

            # state.metadata can be None on freshly-initialised / empty checkpoints,
            # which would AttributeError on .get — coerce to empty dict first.
            state_metadata = state.metadata or {}
            writes = state_metadata.get("writes", {}) or {}
            node_name = self.active_run["node_name"] if interrupts else next(iter(writes), None)
            next_nodes = state.next or ()
            is_end_node = len(next_nodes) == 0 and not interrupts

            node_name = "__end__" if is_end_node else node_name

            # End-of-run events (node-change STEP_*, final root STATE_SNAPSHOT)
            # are supervisor-level. If the stream ended while a subagent was
            # still open (e.g. its task OnToolEnd never fired), current_subagent_id
            # would linger and mis-stamp these as the subagent's. Clear it before
            # emitting them; drain_subagents below still finishes open subagents.
            self.active_run["current_subagent_id"] = None

            if self.active_run.get("node_name") != node_name:
                for ev in self.handle_node_change(node_name):
                    yield ev

            async for ev in self.get_state_and_messages_snapshots(config):
                yield ev

            for ev in self.handle_node_change(None):
                yield ev

            # Finish any open subagents before RUN_FINISHED. This is required
            # even on the interrupt path: an interrupt surfaces the pause by
            # ENDING the run with RUN_FINISHED, and the AG-UI client forbids
            # RUN_FINISHED while a subagent is still active. A subagent suspended
            # at a HITL interrupt is therefore finished here; on resume it
            # re-emits SUBAGENT_STARTED (the run replays) and finishes again.
            for sub_ev in drain_subagents(self.active_run):
                yield self._dispatch_event(sub_ev)

            if interrupts:
                for ev in self._emit_interrupt_finish(
                    thread_id=thread_id,
                    run_id=self.active_run["id"],
                    lg_interrupts=interrupts,
                ):
                    yield self._dispatch_event(ev)
            else:
                yield self._dispatch_event(
                    self._emit_success_finish(
                        thread_id=thread_id,
                        run_id=self.active_run["id"],
                    )
                )
        except Exception as exc:
            # A hard exception (not an in-band "error" event) would otherwise
            # leave any open subagent with no terminal event — the client shows
            # it running forever. Emit SUBAGENT_ERROR for each open subagent,
            # then re-raise for the existing run-level error handling. `except
            # Exception` deliberately excludes CancelledError/GeneratorExit, so
            # this never yields into a cancelled generator.
            if getattr(self, "active_run", None):
                for sub_ev in error_open_subagents(self.active_run, str(exc)):
                    yield self._dispatch_event(sub_ev)
            raise
        finally:
            # Drop this run's in-flight lane slots so no streaming state (which
            # is instance-level, keyed by run id) survives into a later run.
            # Per-run state living inside active_run (reasoning/pin/subagent
            # maps) is discarded with active_run itself below.
            active_run = getattr(self, "active_run", None)
            if active_run is not None:
                self.messages_in_process.pop(active_run.get("id"), None)
            self.active_run = None

    async def prepare_stream(self, input: RunAgentInput, agent_state: State, config: RunnableConfig) -> PreparedStream:
        # Invariant: prepare_stream is only called from _handle_stream_events
        # after self.active_run has been initialized for the current run.
        if self.active_run is None:
            raise RuntimeError("prepare_stream called outside an active run")
        state_input = input.state or {}
        messages = input.messages or []
        forwarded_props = input.forwarded_props or {}
        thread_id = input.thread_id

        state_input["messages"] = agent_state.values.get("messages", [])
        langchain_messages = agui_messages_to_langchain(messages)
        state = self.langgraph_default_merge_state(state_input, langchain_messages, input)
        config["configurable"]["thread_id"] = thread_id
        interrupts = self._collect_interrupts(agent_state.tasks)
        has_active_interrupts = len(interrupts) > 0

        # AG-UI standard: RunAgentInput.resume = [ResumeEntry, ...]
        agui_resume: Optional[list] = list(input.resume) if input.resume else None

        # Legacy fallback: forwardedProps.command.resume (LangGraph private).
        # The conflict / deprecation warnings are emitted once in ``run`` (the
        # request entry point); ``prepare_stream`` only needs the values to
        # construct the LangGraph Command and stays silent to avoid the
        # duplicate-log issue the reviewer flagged.
        command_input = forwarded_props.get('command', {})
        legacy_command_resume = (
            command_input.get('resume', None) if isinstance(command_input, dict) else None
        )
        legacy_has_resume = (
            isinstance(command_input, dict)
            and 'resume' in command_input
            and legacy_command_resume is not None
        )

        # Truthiness, not `is not None`: an empty resume list means "no resume"
        # (consistent with treating an absent resume as no-resume), so it must
        # not suppress the regenerate / interrupt paths.
        has_resume_input = bool(agui_resume) or legacy_has_resume

        self.active_run["schema_keys"] = self.get_schema_keys(config)

        # Interrupt resume must be checked BEFORE the regenerate heuristic.
        # When an interrupt is active the checkpoint contains an AI message
        # (the tool call that triggered the interrupt) that the frontend
        # never received. The message-count comparison below would see
        # "checkpoint has more messages than frontend sent" and incorrectly
        # enter the regenerate path instead of resuming. Treat only non-None
        # resume values as present so falsy resume payloads remain valid while
        # resume=None follows the no-resume interrupt path. Fixes #1743.
        if not has_resume_input:
            # Detect a content edit on any HumanMessage that exists in the checkpoint
            # under the same ID. ``is_continuation`` below compares IDs only, so a
            # same-ID edit is otherwise silently swallowed (the checkpoint keeps the
            # old content and the user's edit is lost). Fixes #1748.
            edited_message = self._detect_edited_human_message(
                langchain_messages,
                agent_state.values.get("messages", []),
            )
            if edited_message:
                return await self.prepare_regenerate_stream(
                    input=input,
                    message_checkpoint=edited_message,
                    config=config,
                )

            non_system_messages = [msg for msg in langchain_messages if not isinstance(msg, SystemMessage)]
            if len(agent_state.values.get("messages", [])) > len(non_system_messages):
                # Only trigger time-travel regeneration if the incoming messages are NOT already
                # in the checkpoint. If they are, this is a continuation (e.g. after CopilotKit
                # intercepted a tool call), not a time-travel edit — regenerating would loop.
                #
                # We exclude ToolMessages from the ID comparison because CopilotKit assigns new
                # IDs to tool results that won't match the placeholder IDs AgentCoreMemorySaver
                # wrote to the checkpoint. Human and AI message IDs are stable across requests
                # and are sufficient to distinguish continuation from time-travel.
                incoming_non_tool_ids = {
                    getattr(m, "id", None)
                    for m in langchain_messages
                    if getattr(m, "id", None) and not isinstance(m, ToolMessage)
                }
                checkpoint_ids = {getattr(m, "id", None) for m in agent_state.values.get("messages", []) if getattr(m, "id", None)}
                is_continuation = bool(incoming_non_tool_ids) and incoming_non_tool_ids.issubset(checkpoint_ids)

                if not is_continuation:
                    last_user_message: Optional[HumanMessage] = None
                    for i in range(len(langchain_messages) - 1, -1, -1):
                        candidate = langchain_messages[i]
                        if isinstance(candidate, HumanMessage):
                            last_user_message = candidate
                            break

                    if last_user_message:
                        last_user_id = last_user_message.id
                        if last_user_id and last_user_id in checkpoint_ids:
                            return await self.prepare_regenerate_stream(
                                input=input,
                                message_checkpoint=last_user_message,
                                config=config
                            )

        events_to_dispatch = []
        if has_active_interrupts and not has_resume_input:
            events_to_dispatch.append(
                RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=thread_id,
                    run_id=self.active_run["id"],
                )
            )
            events_to_dispatch.extend(
                self._emit_interrupt_finish(
                    thread_id=thread_id,
                    run_id=self.active_run["id"],
                    lg_interrupts=interrupts,
                )
            )
            return {
                "stream": None,
                "state": None,
                "config": None,
                "events_to_dispatch": events_to_dispatch,
            }

        if self.active_run["mode"] == "continue":
            await self.graph.aupdate_state(config, state, as_node=self.active_run.get("node_name"))

        if has_resume_input:
            if agui_resume is not None:
                stream_input = self._build_command_from_agui_resume(
                    agui_resume,
                    open_interrupts=self._interrupts_to_agui(interrupts),
                )
            else:
                resume_payload = legacy_command_resume
                if isinstance(resume_payload, str):
                    raw_resume = resume_payload
                    try:
                        resume_payload = json.loads(raw_resume)
                    except json.JSONDecodeError as exc:
                        logger.warning(
                            "failed to parse legacy resume_input as JSON, treating as string "
                            "(thread_id=%r, run_id=%r, error=%s): %r",
                            thread_id,
                            self.active_run.get("id"),
                            exc,
                            raw_resume[:200],
                        )
                stream_input = Command(resume=resume_payload)
        else:
            payload_input = get_stream_payload_input(
                mode=self.active_run["mode"],
                state=state,
                schema_keys=self.active_run["schema_keys"],
            )
            stream_input = {**forwarded_props, **payload_input} if payload_input else None


        subgraphs_stream_enabled = input.forwarded_props.get('stream_subgraphs', True) if input.forwarded_props else True

        kwargs = self.get_stream_kwargs(
            input=stream_input,
            config=config,
            subgraphs=bool(subgraphs_stream_enabled),
            version="v2",
        )

        stream = self.graph.astream_events(**kwargs)

        return {
            "stream": stream,
            "state": state,
            "config": config
        }

    async def prepare_regenerate_stream( # pylint: disable=too-many-arguments
            self,
            input: RunAgentInput,
            message_checkpoint: HumanMessage,
            config: RunnableConfig
    ) -> PreparedStream:
        tools = input.tools or []
        thread_id = input.thread_id

        # ``HumanMessage.id`` is Optional at the type level; narrow here so
        # downstream typed parameters (``get_checkpoint_before_message``'s
        # ``message_id: str``) hold. Callers reach this method only after
        # verifying the id against a checkpoint, so a missing id represents
        # a programming error rather than a recoverable state.
        message_id = message_checkpoint.id
        if not message_id:
            raise ValueError(
                "prepare_regenerate_stream requires a message_checkpoint with an id"
            )
        if not thread_id:
            raise ValueError(
                "prepare_regenerate_stream requires input.thread_id to locate the fork point"
            )

        # ``get_checkpoint_before_message`` raises ``ValueError`` when the
        # message id is missing from history; it never returns ``None``, so
        # no None-guard is needed here.
        time_travel_checkpoint = await self.get_checkpoint_before_message(message_id, thread_id, config)

        # Time-travel regeneration forks at a single ``as_node`` target. When the
        # checkpoint's ``next`` tuple has more than one entry (a parallel/fan-out
        # branch), we pick the first one and surface the choice via a warning so
        # operators can see the non-determinism rather than have branches
        # silently dropped.
        next_nodes = time_travel_checkpoint.next or ()
        if len(next_nodes) > 1:
            logger.warning(
                "time-travel checkpoint has multiple next nodes %r; "
                "forking only at %r (other branches are not replayed)",
                next_nodes, next_nodes[0],
            )
        fork = await self.graph.aupdate_state(
            time_travel_checkpoint.config,
            time_travel_checkpoint.values,
            as_node=next_nodes[0] if next_nodes else "__start__",
        )

        # ``fork`` only carries the checkpoint-level configurable keys
        # (``thread_id``, ``checkpoint_id``, ``checkpoint_ns``).  Pass it
        # alone and runtime settings from the caller's config -- notably
        # ``recursion_limit`` and ``callbacks`` -- are silently dropped,
        # so LangGraph stamps the default ``recursion_limit=25`` and any
        # tracing / observability callbacks are lost.  Merge the caller's
        # config underneath the fork so checkpoint keys still win but
        # everything else is preserved.  Fixes #1749.
        merged_config = merge_configs(config, fork)

        stream_input = self.langgraph_default_merge_state(time_travel_checkpoint.values, [message_checkpoint], input)
        subgraphs_stream_enabled = input.forwarded_props.get('stream_subgraphs', True) if input.forwarded_props else True

        kwargs = self.get_stream_kwargs(
            input=stream_input,
            config=merged_config,
            subgraphs=bool(subgraphs_stream_enabled),
            version="v2",
        )
        stream = self.graph.astream_events(**kwargs)

        return {
            "stream": stream,
            "state": time_travel_checkpoint.values,
            "config": config
        }

    def _current_lane(self) -> str:
        """The current subagent "lane" for per-subagent streaming state.

        Transient stream state (in-flight message/tool call, reasoning, text
        pin) is keyed by this lane so concurrently-streaming subagents never
        clobber each other. The lane is the derived subagent id for the event
        currently being processed (set by reconcile_subagents before the event
        is handled), or "__root__" for the root/supervisor.

        Scope: deepagents runs each parallel `task` subagent in its own
        checkpoint namespace, so every concurrent *subagent* stream derives a
        distinct id and thus a distinct lane — the case this fix targets.
        Concurrent streams that carry NO subagent identity (e.g. two ordinary
        model nodes or two declared subgraphs fanning out in a hand-built
        graph) all map to "__root__" and would still interleave into one lane;
        that is a pre-existing limitation of attribution-less parallel
        streaming, not something lanes can resolve (there is no id to separate
        them by).
        """
        active_run = getattr(self, "active_run", None)
        return (active_run.get("current_subagent_id") if active_run else None) or _ROOT_LANE

    def _get_reasoning_process(self, lane: Optional[str] = None) -> Optional[ThinkingProcess]:
        lane = lane if lane is not None else self._current_lane()
        return (self.active_run.get("reasoning_processes") or {}).get(lane)

    def _set_reasoning_process(self, value: Optional[ThinkingProcess], lane: Optional[str] = None) -> None:
        lane = lane if lane is not None else self._current_lane()
        procs = self.active_run.setdefault("reasoning_processes", {})
        if value is None:
            procs.pop(lane, None)
        else:
            procs[lane] = value

    def get_message_in_progress(self, run_id: str, lane: Optional[str] = None) -> Optional[MessageInProgress]:
        lane = lane if lane is not None else self._current_lane()
        return (self.messages_in_process.get(run_id) or {}).get(lane)

    def set_message_in_progress(self, run_id: str, data: MessageInProgress, lane: Optional[str] = None) -> None:
        lane = lane if lane is not None else self._current_lane()
        lanes = self.messages_in_process.setdefault(run_id, {})
        current_message_in_progress = lanes.get(lane) or {}
        lanes[lane] = {
            **current_message_in_progress,
            **data,
        }

    def clear_message_in_progress(self, run_id: str, lane: Optional[str] = None) -> None:
        lane = lane if lane is not None else self._current_lane()
        lanes = self.messages_in_process.get(run_id)
        if lanes is not None:
            lanes[lane] = None

    def has_any_message_in_progress(self, run_id: str) -> bool:
        """True if any lane in this run has an open in-flight message/tool call.

        Used by the node-exit state-snapshot gate: a snapshot must not be
        emitted while *any* subagent is mid-message, not just the current lane.
        """
        lanes = self.messages_in_process.get(run_id) or {}
        return any(bool(v) for v in lanes.values())

    def get_schema_keys(self, config: RunnableConfig) -> SchemaKeys:
        try:
            input_schema = self.graph.get_input_jsonschema(config)
            output_schema = self.graph.get_output_jsonschema(config)
            if hasattr(self.graph, "get_config_jsonschema"):
                config_schema = self.graph.get_config_jsonschema()
            else:
                config_schema = self.graph.config_schema().schema()

            input_schema_keys = list(input_schema["properties"].keys()) if "properties" in input_schema else []
            output_schema_keys = list(output_schema["properties"].keys()) if "properties" in output_schema else []
            config_schema_keys = list(config_schema["properties"].keys()) if "properties" in config_schema else []

            # context_schema introspection is best-effort and independent of the
            # input/output/config triple above — if it raises, keep the keys we
            # already computed rather than falling back all four to defaults.
            # NOTE: the exception tuple is intentionally kept in sync with the
            # outer except below so a ValueError / NotImplementedError raised
            # from context_schema does not escape and trigger the outer fallback
            # (which would discard input/output/config keys that did compute).
            context_schema_keys: List[str] = []
            if hasattr(self.graph, "context_schema") and self.graph.context_schema is not None:
                try:
                    if hasattr(self.graph, "get_context_jsonschema"):
                        context_schema = self.graph.get_context_jsonschema()
                    else:
                        context_schema = self.graph.context_schema().schema()
                    if context_schema is not None:
                        context_schema_keys = list(context_schema["properties"].keys()) if "properties" in context_schema else []
                except (AttributeError, TypeError, KeyError, ValueError, NotImplementedError) as ctx_exc:
                    logger.warning(
                        "get_schema_keys: context_schema introspection failed (%s: %s); "
                        "falling back to empty context keys while keeping input/output/config",
                        type(ctx_exc).__name__, ctx_exc,
                    )

            return {
                "input": [*input_schema_keys, *self.constant_schema_keys],
                "output": [*output_schema_keys, *self.constant_schema_keys],
                "config": config_schema_keys,
                "context": context_schema_keys,
            }
        except (AttributeError, TypeError, KeyError, ValueError, NotImplementedError) as exc:
            # Legitimate fallback cases:
            #   AttributeError      — graph doesn't implement schema introspection
            #     (older LangGraph versions, custom graph classes, or Pydantic v1/v2
            #     `.schema()` vs `.model_json_schema()` skew).
            #   TypeError           — a schema call returned an unexpected shape
            #     (e.g. not a mapping, so `"properties" in ...` / `.keys()` blows up).
            #   KeyError            — expected keys missing from an otherwise-dict schema.
            #   ValueError          — Pydantic v2 raises this (via PydanticUserError/
            #     PydanticSchemaGenerationError, both ValueError subclasses) when
            #     `.schema()` / `.model_json_schema()` can't be generated for a
            #     given config or context schema.
            #   NotImplementedError — custom graph classes sometimes advertise a
            #     schema API but raise from the stub implementation.
            # Other exceptions (RuntimeError, I/O, asyncio, etc.) indicate real bugs
            # and are allowed to propagate rather than being silently swallowed.
            logger.warning(
                "get_schema_keys: falling back to default schema keys due to %s: %s",
                type(exc).__name__,
                exc,
            )
            return {
                "input": self.constant_schema_keys,
                "output": self.constant_schema_keys,
                "config": [],
                "context": [],
            }

    def langgraph_default_merge_state(self, state: State, messages: List[BaseMessage], input: RunAgentInput) -> State:
        if messages and isinstance(messages[0], SystemMessage):
            messages = messages[1:]

        # At runtime ``state["messages"]`` holds LangChain BaseMessage subclasses
        # (HumanMessage / AIMessage / ToolMessage / SystemMessage) — not the
        # TypedDict LangGraphPlatformMessage wire-shape. Annotate accordingly
        # so downstream attribute access (``.tool_calls``, ``.content``) type-checks.
        existing_messages: List[BaseMessage] = list(state.get("messages", []))

        # Fix tool_call args that are strings instead of dicts.
        # This happens when CopilotKit's after_agent restores frontend tool_calls
        # and the checkpoint saves them with string args. Bedrock Converse API
        # requires toolUse.input to be a JSON object (dict).
        repaired_ai_messages: List[AIMessage] = []
        for idx, msg in enumerate(existing_messages):
            # Only AIMessages with tool_calls can need repair. Skip the rest
            # cheaply so we don't deepcopy every checkpoint message just to
            # discover there was nothing to fix.
            if not (isinstance(msg, AIMessage) and getattr(msg, 'tool_calls', None)):
                continue
            if not any(isinstance(tc.get('args'), str) for tc in msg.tool_calls):
                continue

            msg = deepcopy(msg)
            existing_messages[idx] = msg
            repaired_any = False
            for tc in msg.tool_calls:
                if isinstance(tc.get('args'), str):
                    raw_args = tc['args']
                    try:
                        tc['args'] = json.loads(raw_args)
                        repaired_any = True
                    except (json.JSONDecodeError, TypeError) as exc:
                        # Surface the failure loudly: this corrupts a tool
                        # call's args, which downstream LLMs may silently
                        # treat as an empty call. Include the tool_call_id
                        # and a bounded excerpt so the cause is debuggable
                        # without dumping unbounded payloads to logs.
                        logger.error(
                            "Resetting tool_call args after JSON decode failure "
                            "(tool_call_id=%r, error=%s): %r",
                            tc.get('id'),
                            exc,
                            raw_args[:200],
                        )
                        tc['args'] = {}
            # Only return the repaired copy when at least one parse succeeded.
            # Otherwise the checkpoint message stays authoritative; appending a
            # repaired copy with empty args would duplicate the original tool
            # call with corrupted arguments downstream.
            if repaired_any:
                repaired_ai_messages.append(msg)

        # Fix orphan ToolMessages injected by patch_orphan_tool_calls:
        # Find the real content from AG-UI messages and replace the fake content.
        # Only scan from the last HumanMessage to the end of existing_messages.
        # Track replaced tool_call_ids so we don't also add the AG-UI duplicate.
        agui_tool_content = {
            m.tool_call_id: m.content
            for m in messages
            if isinstance(m, ToolMessage) and hasattr(m, 'tool_call_id')
        }
        replaced_tool_call_ids = set()
        repaired_tool_messages: List[ToolMessage] = []
        if agui_tool_content:
            last_human_idx = -1
            for i in range(len(existing_messages) - 1, -1, -1):
                if isinstance(existing_messages[i], HumanMessage):
                    last_human_idx = i
                    break
            if last_human_idx >= 0:
                for i in range(last_human_idx + 1, len(existing_messages)):
                    msg = existing_messages[i]
                    if (
                            isinstance(msg, ToolMessage)
                            and isinstance(msg.content, str)
                            and self._ORPHAN_TOOL_MSG_RE.match(msg.content)
                            and hasattr(msg, 'tool_call_id')
                            and msg.tool_call_id in agui_tool_content
                    ):
                        msg = deepcopy(msg)
                        msg.content = agui_tool_content[msg.tool_call_id]
                        existing_messages[i] = msg
                        repaired_tool_messages.append(msg)
                        replaced_tool_call_ids.add(msg.tool_call_id)

        existing_message_ids = {msg.id for msg in existing_messages}

        new_messages = [
            *repaired_ai_messages,
            *repaired_tool_messages,
            *[
                msg for msg in messages
                if msg.id not in existing_message_ids
                and not (
                    isinstance(msg, ToolMessage)
                    and hasattr(msg, 'tool_call_id')
                    and msg.tool_call_id in replaced_tool_call_ids
                )
            ],
        ]

        tools = input.tools or []
        tools_as_dicts = []
        if tools:
            for tool in tools:
                if hasattr(tool, "model_dump"):
                    tools_as_dicts.append(tool.model_dump())
                elif hasattr(tool, "dict"):
                    tools_as_dicts.append(tool.dict())
                else:
                    tools_as_dicts.append(tool)

        # Input tools first so they win over stale state tools on name collision
        all_tools = [*tools_as_dicts, *(state.get("tools") or [])]

        # Remove duplicates based on tool name
        seen_names = set()
        unique_tools = []
        for tool in all_tools:
            tool_name = tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)
            if tool_name and tool_name not in seen_names:
                seen_names.add(tool_name)
                unique_tools.append(tool)
            elif not tool_name:
                # Keep tools without names (shouldn't happen in well-formed
                # input, but we don't want to silently drop them); warn so
                # broken upstream tool registrations are visible.
                logger.warning("tool registered without a name: %r", tool)
                unique_tools.append(tool)

        # Separate A2UI schema context from regular context.
        # The A2UI schema goes into state["ag-ui"]["a2ui_schema"] so agents
        # can read it directly from state (e.g., for the generate_a2ui tool),
        # instead of it being dumped into the system prompt with all other context.
        # The split (constant + matcher) lives in the shared a2ui toolkit so the
        # LangGraph and Strands adapters agree on it. Covered by
        # test_a2ui_schema_context_routed_into_ag_ui_state.
        a2ui_schema_value, regular_context = split_a2ui_schema_context(input.context)

        ag_ui_state: dict = {
            "tools": unique_tools,
            "context": regular_context,
        }
        if a2ui_schema_value is not None:
            ag_ui_state["a2ui_schema"] = a2ui_schema_value

        # Surface the A2UI tool-injection flag (set by the A2UI middleware via
        # forwardedProps.injectA2UITool) into ag-ui state so graphs/tools can
        # read it directly from state. It is written here whenever the merged
        # state is built (start/continue runs) and then persists in the
        # checkpoint, so resumed runs still see it. forwarded_props keys are
        # snake-cased in run() (camel_to_snake turns "injectA2UITool" into
        # "inject_a2_u_i_tool" — pinned by test_camel_to_snake_key_contract),
        # so check the converted key first and fall back to the raw camelCase
        # form for safety.
        forwarded = input.forwarded_props or {}
        if "inject_a2_u_i_tool" in forwarded:
            ag_ui_state["inject_a2ui_tool"] = forwarded["inject_a2_u_i_tool"]
        elif "injectA2UITool" in forwarded:
            ag_ui_state["inject_a2ui_tool"] = forwarded["injectA2UITool"]

        return {
            **state,
            "messages": new_messages,
            "tools": unique_tools,
            "ag-ui": ag_ui_state,
            "copilotkit": {
                **state.get("copilotkit", {}),
                "actions": unique_tools,
            },
        }

    _ORPHAN_TOOL_MSG_RE = re.compile(
        r"^Tool call '.+' with id '.+' was interrupted before completion\.$"
    )

    def _filter_orphan_tool_messages(self, messages: list) -> list:
        """Remove fake ToolMessages injected by patch_orphan_tool_calls,
        but only between the last user message and the end of the list."""
        # Find the index of the last HumanMessage
        last_human_idx = -1
        for i in range(len(messages) - 1, -1, -1):
            if isinstance(messages[i], HumanMessage):
                last_human_idx = i
                break

        if last_human_idx == -1:
            return messages

        # Keep everything before the last user message as-is,
        # filter the tail
        head = messages[:last_human_idx + 1]
        tail = [
            m for m in messages[last_human_idx + 1:]
            if not (
                    isinstance(m, ToolMessage)
                    and isinstance(m.content, str)
                    and self._ORPHAN_TOOL_MSG_RE.match(m.content)
            )
        ]
        return head + tail

    @staticmethod
    def _collect_interrupts(tasks) -> list:
        """Collect interrupts from ALL tasks, not just tasks[0].

        This fixes #1409 where parallel tool calls could have interrupts
        on tasks other than the first one.
        """
        if not tasks or len(tasks) == 0:
            return []
        interrupts = []
        for task in tasks:
            task_interrupts = getattr(task, "interrupts", None) or []
            interrupts.extend(task_interrupts)
        return interrupts

    @staticmethod
    def _normalized_content(content):
        # Canonical form for edit detection: plain strings compare directly;
        # structured/multimodal content compares via a key-order-insensitive
        # projection so checkpoint re-serialization isn't mistaken for an edit.
        if isinstance(content, str):
            return content
        return json.dumps(content, sort_keys=True, default=str)
    
    @staticmethod
    def _detect_edited_human_message(
        incoming_messages: List[BaseMessage],
        checkpoint_messages: List[BaseMessage],
    ) -> Optional[HumanMessage]:
        """Return the earliest incoming ``HumanMessage`` whose content
        was edited relative to the checkpoint, or ``None`` if no edit
        was detected.

        Two messages are considered to be the same message when they
        share an ``id``; an edit is a same-``id`` pair with different
        ``content``. The ``is_continuation`` heuristic in
        ``prepare_stream`` compares ``id``\\ s only, so without this
        check a same-id content edit is silently swallowed (the
        checkpoint keeps the old content and the user's edit is lost).
        Fixes #1748.
        """
        checkpoint_by_id = {
            getattr(m, "id", None): m
            for m in checkpoint_messages
            if isinstance(m, HumanMessage) and getattr(m, "id", None)
        }
        if not checkpoint_by_id:
            return None
        for msg in incoming_messages:
            if not isinstance(msg, HumanMessage) or not getattr(msg, "id", None):
                continue
            ckpt = checkpoint_by_id.get(msg.id)
            if ckpt is not None and LangGraphAgent._normalized_content(ckpt.content) != LangGraphAgent._normalized_content(msg.content):
                return msg
        return None

    def _interrupts_to_agui(self, lg_interrupts) -> List[AGUIInterrupt]:
        """Map LangGraph task interrupts to AG-UI Interrupts.

        Default: one-to-one via ``lg_interrupt_to_agui``. Override when a
        single LangGraph interrupt carries multiple logical user-decisions
        (e.g. HumanInTheLoopMiddleware's ``action_requests`` /
        ``review_configs``) and you need to fan out N AG-UI Interrupts per
        LangGraph interrupt — write the loop yourself in the override.
        """
        return lg_interrupts_to_agui(lg_interrupts)

    def _emit_interrupt_finish(
        self,
        *,
        thread_id: str,
        run_id: str,
        lg_interrupts: list,
    ) -> List[ProcessedEvents]:
        """Build the tail-events for an interrupt-terminated run.

        Default (``emit_interrupt_outcome=False``, ``enable_legacy_on_interrupt_event=True``):
          [CustomEvent(on_interrupt) * N, RunFinishedEvent]            # plain finish, no outcome
        Opt-in (``emit_interrupt_outcome=True``):
          [CustomEvent(on_interrupt) * N, RunFinishedEvent(outcome=Interrupt)]

        ``emit_interrupt_outcome`` defaults to False: released clients that
        resume via the legacy ``forwardedProps.command.resume`` channel stop
        sending a resume directive once they observe the structured outcome,
        which strands the run. It stays opt-in until those clients adopt
        ``RunAgentInput.resume[]``.

        The structured outcome is, however, emitted whenever the legacy
        on_interrupt event is disabled (``enable_legacy_on_interrupt_event=False``),
        even if ``emit_interrupt_outcome`` is False — otherwise the interrupt
        would be surfaced by neither channel and silently swallowed.

        Caller is responsible for any preceding STATE_SNAPSHOT / MESSAGES_SNAPSHOT.
        """
        agui_interrupts = self._interrupts_to_agui(lg_interrupts)
        events: List[ProcessedEvents] = []
        if self.enable_legacy_on_interrupt_event:
            for raw, mapped in zip(lg_interrupts, agui_interrupts):
                events.append(
                    CustomEvent(
                        type=EventType.CUSTOM,
                        name=LangGraphEventTypes.OnInterrupt.value,
                        value=dump_json_safe(raw.value),
                        raw_event=raw,
                    )
                )
        # Emit the structured outcome when opted in, OR whenever the legacy
        # on_interrupt event is disabled — otherwise the interrupt would be
        # surfaced by neither channel and silently swallowed.
        include_outcome = (
            self.emit_interrupt_outcome or not self.enable_legacy_on_interrupt_event
        )
        outcome = (
            RunFinishedInterruptOutcome(type="interrupt", interrupts=agui_interrupts)
            if include_outcome
            else None
        )
        events.append(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=thread_id,
                run_id=run_id,
                outcome=outcome,
            )
        )
        return events

    def _emit_success_finish(
        self, *, thread_id: str, run_id: str
    ) -> RunFinishedEvent:
        """Tail event for a non-interrupt run."""
        return RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=thread_id,
            run_id=run_id,
        )

    def _build_command_from_agui_resume(
        self,
        entries: list,
        *,
        open_interrupts: Optional[List[AGUIInterrupt]] = None,
    ) -> Command:
        """Convert AG-UI ResumeEntry[] into LangGraph Command(resume=...).

        ``open_interrupts`` is the list of currently-pending AG-UI
        Interrupts on the thread (already mapped via the hook above).
        Subclasses may use it to align resume entries with the
        framework-native action order.

        Default implementation: single-resolved → payload, single-cancelled
        → sentinel dict, multiple → __agui_resume_map__ sentinel.
        """
        if len(entries) == 1:
            e = entries[0]
            if e.status == "resolved":
                return Command(resume=e.payload)
            return Command(
                resume={
                    DEFAULT_RESUME_SENTINEL_CANCELLED: True,
                    "interrupt_id": e.interrupt_id,
                }
            )
        return Command(
            resume={
                DEFAULT_RESUME_SENTINEL_MAP: {
                    e.interrupt_id: {
                        "status": e.status,
                        "payload": e.payload,
                    }
                    for e in entries
                }
            }
        )

    def get_capabilities(self) -> dict:
        """Return the agent's capability declaration.

        Subclasses can override to add custom HITL capability
        declarations or other integration-specific fields.
        """
        return {
            "identity": {"type": "langgraph"},
            "humanInTheLoop": {
                "supported": True,
                "interrupts": True,
                "approveWithEdits": True,
            },
            "state": {"snapshots": True, "deltas": False, "persistentState": True},
            "transport": {"streaming": True},
        }

    def get_state_snapshot(self, state: State) -> State:
        # Invariant: callers always operate within an active run.
        if self.active_run is None:
            raise RuntimeError("get_state_snapshot called outside an active run")
        schema_keys = self.active_run.get("schema_keys")
        output_keys = schema_keys["output"] if schema_keys else None
        if output_keys:
            state = filter_object_by_schema_keys(state, [*DEFAULT_SCHEMA_KEYS, *output_keys])
        return state

    async def _handle_single_event(self, event: Any, state: State) -> AsyncGenerator[ProcessedEvents, None]:
        # Invariant: _handle_single_event is only invoked from the event
        # loop inside _handle_stream_events, where active_run has been
        # initialized for the current run.
        if self.active_run is None:
            raise RuntimeError("_handle_single_event called outside an active run")
        event_type = event.get("event")
        if event_type == LangGraphEventTypes.OnChatModelStream:
            should_emit_messages = (event.get("metadata") or {}).get("emit-messages", True)
            should_emit_tool_calls = (event.get("metadata") or {}).get("emit-tool-calls", True)

            # Chunks are normally LangChain BaseMessage instances (attribute
            # access), but some upstream paths deliver raw dicts — use dual-path
            # accessors (see _chunk_get helper below) so either shape works
            # instead of AttributeError-crashing here.
            chunk_raw = event.get("data", {}).get("chunk") or {}
            def _chunk_get(c: Any, key: str, default: Any = None) -> Any:
                if isinstance(c, dict):
                    return c.get(key, default)
                return getattr(c, key, default)

            response_metadata = _chunk_get(chunk_raw, "response_metadata", None) or {}
            tool_call_chunks_list = _chunk_get(chunk_raw, "tool_call_chunks", None) or []

            if response_metadata.get('finish_reason', None):
                return

            current_stream = self.get_message_in_progress(self.active_run["id"])
            has_current_stream = bool(current_stream and current_stream.get("id"))
            tool_call_data = tool_call_chunks_list[0] if tool_call_chunks_list else None
            predict_state_metadata = (event.get("metadata") or {}).get("predict_state", [])
            tool_call_used_to_predict_state = False
            if tool_call_data and tool_call_data.get("name") and predict_state_metadata:
                tool_call_used_to_predict_state = any(
                    (predict_tool.get("tool") if isinstance(predict_tool, dict) else getattr(predict_tool, "tool", None)) == tool_call_data["name"]
                    for predict_tool in predict_state_metadata
                )

            is_tool_call_start_event = not has_current_stream and tool_call_data and tool_call_data.get("name")
            is_tool_call_args_event = has_current_stream and current_stream.get("tool_call_id") and tool_call_data and tool_call_data.get("args")
            is_tool_call_end_event = has_current_stream and current_stream.get("tool_call_id") and not tool_call_data

            # Boundary transition: a new tool_call begins while another is
            # mid-stream. Happens when an LLM streams *parallel* tool_calls
            # sequentially — tool A's chunks arrive, then tool B's chunks
            # arrive without an intervening empty-chunk terminator. Without
            # this detection, B's args event (below) would route deltas to
            # A's tool_call_id, producing concatenated JSON like
            # ``{"x":1}{"x":2}`` in the persisted assistant history and
            # leaving B with no Start/End at all.
            if (
                has_current_stream
                and current_stream.get("tool_call_id")
                and tool_call_data
                and tool_call_data.get("name")
                and tool_call_data.get("id")
                and tool_call_data["id"] != current_stream["tool_call_id"]
            ):
                yield self._dispatch_event(
                    ToolCallEndEvent(
                        type=EventType.TOOL_CALL_END,
                        tool_call_id=current_stream["tool_call_id"],
                        raw_event=event,
                    )
                )
                self.clear_message_in_progress(self.active_run["id"])
                current_stream = None
                has_current_stream = False
                # Re-evaluate the booleans against the now-closed stream.
                is_tool_call_start_event = bool(tool_call_data.get("name"))
                is_tool_call_args_event = False
                is_tool_call_end_event = False

            if is_tool_call_start_event or is_tool_call_end_event or is_tool_call_args_event:
                self.active_run["has_function_streaming"] = True

            chunk = event["data"]["chunk"]
            chunk_content = _chunk_get(chunk, "content", None) if chunk else None
            chunk_id = _chunk_get(chunk, "id", None) if chunk else None

            # Capture EVERY `task` delegation call in this chunk (with its
            # tool_call_id and the assistant chunk id as parent_message_id) so
            # each spawned subagent can carry parentToolCallId / parentMessageId
            # on its SUBAGENT_STARTED. A supervisor can fan out several `task`
            # calls in one turn; scanning the whole tool_call_chunks list (not
            # just [0]) queues all of them. Dedupe by tool_call_id because a
            # call's id recurs across its arg-streaming chunks.
            #
            # These queued records are matched to subagents by the per-call
            # ToolNode dispatch namespace in _capture_subagent_task_meta (see
            # _capture_task_tool_dispatch), NOT by emission order, so reordered
            # tool starts don't swap sibling links. FIFO order is only a fallback
            # for older/batched ToolNode shapes.
            for _tcc in tool_call_chunks_list:
                if _tcc.get("name") == "task" and _tcc.get("id"):
                    seen_tasks = self.active_run.setdefault("seen_task_call_ids", set())
                    if _tcc["id"] not in seen_tasks:
                        seen_tasks.add(_tcc["id"])
                        self.active_run.setdefault("pending_task_calls", []).append({
                            "tool_call_id": _tcc["id"],
                            "parent_message_id": chunk_id,
                        })

            reasoning_data = resolve_reasoning_content(chunk) if chunk else None
            encrypted_reasoning_data = resolve_encrypted_reasoning_content(chunk) if chunk else None
            # Use an explicit ``is not None`` check so empty-string deltas
            # (``chunk.content == ""``) still reach resolve_message_content.
            # The prior truthy check ``if chunk and chunk.content`` treated
            # "" the same as None and silently dropped zero-length deltas
            # that some providers emit during tool-call / structured-output
            # transitions.
            message_content = (
                resolve_message_content(chunk_content)
                if chunk is not None and chunk_content is not None
                else None
            )
            # Use ``is not None`` rather than truthy: an empty-string delta
            # (``""``) is a legitimate streaming chunk some providers emit
            # during tool-call / structured-output transitions, and the
            # truthy check would misclassify it as an end-event.
            is_message_content_event = tool_call_data is None and message_content is not None
            is_message_end_event = has_current_stream and not current_stream.get("tool_call_id") and not is_message_content_event

            if reasoning_data:
                for event_str in self.handle_reasoning_event(reasoning_data):
                    yield event_str
                return

            # Handle redacted_thinking blocks (encrypted reasoning content)
            reasoning_process = self._get_reasoning_process()
            if encrypted_reasoning_data and reasoning_process is not None:
                reasoning_message_id = reasoning_process["message_id"]
                yield self._dispatch_event(
                    ReasoningEncryptedValueEvent(
                        type=EventType.REASONING_ENCRYPTED_VALUE,
                        subtype="message",
                        entity_id=reasoning_message_id,
                        encrypted_value=encrypted_reasoning_data,
                    )
                )
                return

            if reasoning_data is None and reasoning_process is not None:
                reasoning_message_id = reasoning_process["message_id"]
                # Emit signature as encrypted value if accumulated during reasoning
                if reasoning_process.get("signature"):
                    yield self._dispatch_event(
                        ReasoningEncryptedValueEvent(
                            type=EventType.REASONING_ENCRYPTED_VALUE,
                            subtype="message",
                            entity_id=reasoning_message_id,
                            encrypted_value=reasoning_process["signature"],
                        )
                    )
                yield self._dispatch_event(
                    ReasoningMessageEndEvent(
                        type=EventType.REASONING_MESSAGE_END,
                        message_id=reasoning_message_id,
                    )
                )
                yield self._dispatch_event(
                    ReasoningEndEvent(
                        type=EventType.REASONING_END,
                        message_id=reasoning_message_id,
                    )
                )
                self._set_reasoning_process(None)

            if tool_call_used_to_predict_state:
                yield self._dispatch_event(
                    CustomEvent(
                        type=EventType.CUSTOM,
                        name="PredictState",
                        value=predict_state_metadata,
                        raw_event=event
                    )
                )

            if tool_call_data and tool_call_data.get("name") and message_content is not None:
                text_stream_id = None
                if current_stream and current_stream.get("id") and not current_stream.get("tool_call_id"):
                    text_stream_id = current_stream["id"]
                elif message_content != "":
                    text_stream_id = chunk_id
                    if should_emit_messages:
                        yield self._dispatch_event(
                            TextMessageStartEvent(
                                type=EventType.TEXT_MESSAGE_START,
                                role="assistant",
                                message_id=text_stream_id,
                                raw_event=event,
                            )
                        )

                if text_stream_id and should_emit_messages:
                    if message_content != "":
                        yield self._dispatch_event(
                            TextMessageContentEvent(
                                type=EventType.TEXT_MESSAGE_CONTENT,
                                message_id=text_stream_id,
                                delta=message_content,
                                raw_event=event,
                            )
                        )
                    yield self._dispatch_event(
                        TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=text_stream_id, raw_event=event)
                    )

                if text_stream_id:
                    self.clear_message_in_progress(self.active_run["id"])
                    current_stream = None
                    has_current_stream = False
                is_message_end_event = False
                is_tool_call_start_event = True
                is_tool_call_args_event = False
                is_tool_call_end_event = False
                self.active_run["has_function_streaming"] = True

            if is_message_end_event and tool_call_data and tool_call_data.get("name"):
                yield self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=current_stream["id"], raw_event=event)
                )
                self.clear_message_in_progress(self.active_run["id"])
                current_stream = None
                has_current_stream = False
                is_message_end_event = False
                is_tool_call_start_event = True
                is_tool_call_args_event = False
                is_tool_call_end_event = False
                self.active_run["has_function_streaming"] = True

            if is_tool_call_end_event:
                yield self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=current_stream["tool_call_id"], raw_event=event)
                )
                self.clear_message_in_progress(self.active_run["id"])
                return


            if is_message_end_event:
                yield self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=current_stream["id"], raw_event=event)
                )
                self.clear_message_in_progress(self.active_run["id"])
                return

            if is_tool_call_start_event:
                # Record this tool_call_id as "already streamed" regardless of
                # ``should_emit_tool_calls``. OnToolEnd uses this set to decide
                # whether to re-emit Start/Args/End for the same id. Adding the
                # id even when emission is suppressed preserves the prior
                # behaviour where ``has_function_streaming=True`` blocked the
                # OnToolEnd re-emit for opted-out tool calls.
                self.active_run["streamed_tool_call_ids"].add(tool_call_data["id"])
                if should_emit_tool_calls:
                    yield self._dispatch_event(
                        ToolCallStartEvent(
                            type=EventType.TOOL_CALL_START,
                            tool_call_id=tool_call_data["id"],
                            tool_call_name=tool_call_data["name"],
                            parent_message_id=chunk_id,
                            raw_event=event,
                        )
                    )
                    self.set_message_in_progress(
                        self.active_run["id"],
                        MessageInProgress(id=chunk_id, tool_call_id=tool_call_data["id"], tool_call_name=tool_call_data["name"])
                    )
                return

            if is_tool_call_args_event and should_emit_tool_calls:
                yield self._dispatch_event(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=current_stream["tool_call_id"],
                        delta=tool_call_data["args"],
                        raw_event=event
                    )
                )
                return

            if is_message_content_event and should_emit_messages:
                # Empty-string deltas are legitimate streaming chunks but
                # AG-UI's TextMessageContentEvent enforces delta min_length=1.
                # Swallow them here (no-op): we must not misclassify ``""``
                # as an end-event (see is_message_content_event above), but
                # we also can't emit an invalid event. Skipping matches the
                # prior behaviour for non-empty content and keeps the
                # in-progress message open for the next delta.
                if message_content == "":
                    return

                if bool(current_stream and current_stream.get("id")) == False:
                    message_id = self._get_or_pin_text_message_id(
                        chunk_id, (event.get("metadata") or {}).get("langgraph_node")
                    )
                    yield self._dispatch_event(
                        TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            role="assistant",
                            message_id=message_id,
                            raw_event=event,
                        )
                    )
                    self.set_message_in_progress(
                        self.active_run["id"],
                        MessageInProgress(
                            id=message_id,
                            tool_call_id=None,
                            tool_call_name=None
                        )
                    )
                    current_stream = self.get_message_in_progress(self.active_run["id"])

                yield self._dispatch_event(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=current_stream["id"],
                        delta=message_content,
                        raw_event=event,
                    )
                )
                return

        elif event_type == LangGraphEventTypes.OnChatModelEnd:
            if self.get_message_in_progress(self.active_run["id"]) and self.get_message_in_progress(self.active_run["id"]).get("tool_call_id"):
                resolved = self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=self.get_message_in_progress(self.active_run["id"])["tool_call_id"], raw_event=event)
                )
                if resolved:
                    self.clear_message_in_progress(self.active_run["id"])
                yield resolved
            elif self.get_message_in_progress(self.active_run["id"]) and self.get_message_in_progress(self.active_run["id"]).get("id"):
                resolved = self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=self.get_message_in_progress(self.active_run["id"])["id"], raw_event=event)
                )
                if resolved:
                    self.clear_message_in_progress(self.active_run["id"])
                yield resolved

        elif event_type == LangGraphEventTypes.OnCustomEvent:
            if event["name"] == CustomEventNames.ManuallyEmitMessage:
                yield self._dispatch_event(
                    TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, role="assistant", message_id=event["data"]["message_id"], raw_event=event)
                )
                yield self._dispatch_event(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=event["data"]["message_id"],
                        delta=event["data"]["message"],
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=event["data"]["message_id"], raw_event=event)
                )

            elif event["name"] == CustomEventNames.ManuallyEmitToolCall:
                yield self._dispatch_event(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=event["data"]["id"],
                        tool_call_name=event["data"]["name"],
                        parent_message_id=event["data"]["id"],
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=event["data"]["id"],
                        delta=event["data"]["args"] if isinstance(event["data"]["args"], str) else json.dumps(
                            event["data"]["args"]),
                        raw_event=event
                    )
                )
                yield self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=event["data"]["id"], raw_event=event)
                )

            elif event["name"] == CustomEventNames.ManuallyEmitState:
                # Only the parent owns state, so this is suppressed inside a
                # subagent exactly like the node-exit and checkpoint snapshots
                # are. Without the guard the dispatch chokepoint would stamp the
                # subagent's id onto a STATE_SNAPSHOT (STATE_* is in
                # _SUBAGENT_ATTRIBUTABLE_EVENT_TYPES), and the client applies
                # STATE_SNAPSHOT to the shared state without consulting
                # subagent_id — so a subagent's partial state would land as if
                # the parent had sent it.
                #
                # The payload is DROPPED, not merely left unemitted. Recording it
                # would defer the same violation by one event rather than prevent
                # it: `manually_emitted_state` is run-global, and the stream loop
                # reads it back as `updated_state` at the next node exit and emits
                # it as a snapshot. That deferred snapshot carries no subagent_id,
                # so it would reach the consumer looking like the parent's own
                # state — the exact outcome this guard exists to stop.
                if not self.active_run.get("current_subagent_id"):
                    self.active_run["manually_emitted_state"] = event["data"]
                    yield self._dispatch_event(
                        StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=self.get_state_snapshot(self.active_run["manually_emitted_state"]), raw_event=event)
                    )
                else:
                    logger.debug(
                        "Dropping manually_emit_state from subagent %s; only the parent owns state",
                        self.active_run.get("current_subagent_id"),
                    )
            
            yield self._dispatch_event(
                CustomEvent(type=EventType.CUSTOM, name=event["name"], value=event["data"], raw_event=event)
            )

        elif event_type == LangGraphEventTypes.OnToolEnd:
            tool_call_output = event["data"]["output"]

            if isinstance(tool_call_output, Command):
                # Extract ToolMessages from Command.update. ``.update`` is
                # typed as Optional[Any] upstream — it can be None, a dict,
                # or a list of tuples. Guard for the non-dict shapes instead
                # of crashing with AttributeError on ``.get``.
                update = tool_call_output.update
                if isinstance(update, dict):
                    messages = update.get('messages', []) or []
                else:
                    messages = []

                # Filter explicitly so non-ToolMessage entries (e.g. plain
                # BaseMessage / AIMessage items sometimes attached to Command
                # updates) are logged and dropped rather than silently sliced.
                tool_messages: List[ToolMessage] = []
                for m in messages:
                    if isinstance(m, ToolMessage):
                        tool_messages.append(m)
                    else:
                        logger.debug(
                            "dropping non-ToolMessage entry from Command.update messages: %r",
                            type(m).__name__,
                        )

                # Process each tool message. Re-emit Start/Args/End only for
                # tool_call_ids that did NOT already stream them through
                # OnChatModelStream — checked per-id so nested tool execution
                # (deepagents ``task`` -> subagent) doesn't cause the outer
                # tool's Args to be emitted twice when the inner tool's
                # OnToolEnd fires first.
                for tool_msg in tool_messages:
                    already_streamed = tool_msg.tool_call_id in self.active_run["streamed_tool_call_ids"]
                    if not already_streamed:
                        yield self._dispatch_event(
                            ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                tool_call_id=tool_msg.tool_call_id,
                                tool_call_name=tool_msg.name or event.get("name", ""),
                                parent_message_id=str(tool_msg.id or tool_msg.tool_call_id),
                                raw_event=event,
                            )
                        )
                        yield self._dispatch_event(
                            ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=tool_msg.tool_call_id,
                                delta=json.dumps(event["data"].get("input", {})),
                                raw_event=event
                            )
                        )
                        yield self._dispatch_event(
                            ToolCallEndEvent(
                                type=EventType.TOOL_CALL_END,
                                tool_call_id=tool_msg.tool_call_id,
                                raw_event=event
                            )
                        )
                    self.active_run["streamed_tool_call_ids"].discard(tool_msg.tool_call_id)

                    yield self._dispatch_event(
                        ToolCallResultEvent(
                            type=EventType.TOOL_CALL_RESULT,
                            tool_call_id=tool_msg.tool_call_id,
                            # Match ToolMessage.id (or tool_call_id) so MESSAGES_SNAPSHOT merge works.
                            message_id=str(tool_msg.id or tool_msg.tool_call_id),
                            content=normalize_tool_content(tool_msg.content),
                            role="tool"
                        )
                    )
                self.active_run["model_made_tool_call"] = False
                self.active_run["state_reliable"] = True
                self.active_run["has_function_streaming"] = False
                return

            # The non-Command branch below assumes tool_call_output is a
            # ToolMessage (reads .tool_call_id, .name, .id, .content). If an
            # integration delivers something else, log and skip rather than
            # AttributeError-crashing the whole stream.
            if not isinstance(tool_call_output, ToolMessage):
                logger.warning(
                    "OnToolEnd received non-ToolMessage output (%r); skipping dispatch",
                    type(tool_call_output).__name__,
                )
                return

            already_streamed = tool_call_output.tool_call_id in self.active_run["streamed_tool_call_ids"]
            if not already_streamed:
                yield self._dispatch_event(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=tool_call_output.tool_call_id,
                        tool_call_name=tool_call_output.name or event.get("name", ""),
                        parent_message_id=str(tool_call_output.id or tool_call_output.tool_call_id),
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=tool_call_output.tool_call_id,
                        delta=dump_json_safe(event["data"]["input"]),
                        raw_event=event
                    )
                )
                yield self._dispatch_event(
                    ToolCallEndEvent(
                        type=EventType.TOOL_CALL_END,
                        tool_call_id=tool_call_output.tool_call_id,
                        raw_event=event
                    )
                )
            self.active_run["streamed_tool_call_ids"].discard(tool_call_output.tool_call_id)

            yield self._dispatch_event(
                ToolCallResultEvent(
                    type=EventType.TOOL_CALL_RESULT,
                    tool_call_id=tool_call_output.tool_call_id,
                    # Match ToolMessage.id (or tool_call_id) so MESSAGES_SNAPSHOT merge works.
                    message_id=str(tool_call_output.id or tool_call_output.tool_call_id),
                    content=normalize_tool_content(tool_call_output.content),
                    role="tool"
                )
            )

            self.active_run["model_made_tool_call"] = False
            self.active_run["state_reliable"] = True
            self.active_run["has_function_streaming"] = False

        elif event_type == LangGraphEventTypes.OnToolError:
            # A tool threw before OnToolEnd could fire. Reset the suppression
            # flags so subsequent snapshots are not permanently blocked.
            logger.debug(
                "on_tool_error received — clearing model_made_tool_call/state_reliable (tool=%s)",
                event.get("name"),
            )
            self.active_run["model_made_tool_call"] = False
            self.active_run["state_reliable"] = True
            self.active_run["has_function_streaming"] = False

    def handle_reasoning_event(self, reasoning_data: LangGraphReasoning) -> Generator[ProcessedEvents, Any, None]:
        # Invariant: reasoning events are dispatched from _handle_single_event,
        # which itself runs inside an active run.
        if self.active_run is None:
            raise RuntimeError("handle_reasoning_event called outside an active run")
        if not reasoning_data or "type" not in reasoning_data or "text" not in reasoning_data:
            # Drop malformed events rather than partially emitting. Log so
            # upstream shape drift is diagnosable.
            logger.debug(
                "handle_reasoning_event: malformed reasoning_data dropped: %r",
                reasoning_data,
            )
            return

        # A text-less chunk is still meaningful when it carries the provider's
        # canonical reasoning id (the `response.output_item.added` /
        # `…summary_part.added` chunks): stash the id so the first text delta
        # opens the reasoning message under it, WITHOUT opening a message here
        # — a summary-less (store=true) reasoning item must keep rendering
        # nothing.
        # Reasoning state is per-subagent-lane so concurrently-reasoning
        # subagents don't clobber each other (see _current_lane).
        lane = self._current_lane()
        if not reasoning_data["text"]:
            if reasoning_data.get("id"):
                self.active_run.setdefault("pending_reasoning_ids", {})[lane] = reasoning_data["id"]
            return

        reasoning_step_index = reasoning_data.get("index", 0)

        reasoning_process = self._get_reasoning_process(lane)
        if (reasoning_process and
                reasoning_process.get("index") is not None and
                reasoning_process["index"] != reasoning_step_index):

            reasoning_message_id = reasoning_process["message_id"]
            if reasoning_process.get("type"):
                yield self._dispatch_event(
                    ReasoningMessageEndEvent(
                        type=EventType.REASONING_MESSAGE_END,
                        message_id=reasoning_message_id,
                    )
                )
            yield self._dispatch_event(
                ReasoningEndEvent(
                    type=EventType.REASONING_END,
                    message_id=reasoning_message_id,
                )
            )
            self._set_reasoning_process(None, lane)
            reasoning_process = None

        if not reasoning_process:
            # Prefer the provider's canonical reasoning id (e.g. OpenAI
            # ``rs_…``) when the stream carried one: the snapshot converter
            # (_reasoning_block_to_agui_message) re-emits this same reasoning
            # under that id, and only a matching id lets the client reconcile
            # the streamed copy with the snapshot copy instead of rendering
            # both.
            message_id = (
                reasoning_data.get("id")
                or (self.active_run.get("pending_reasoning_ids") or {}).pop(lane, None)
                or str(uuid.uuid4())
            )
            yield self._dispatch_event(
                ReasoningStartEvent(
                    type=EventType.REASONING_START,
                    message_id=message_id,
                )
            )
            reasoning_process = {
                "index": reasoning_step_index,
                "message_id": message_id,
            }
            self._set_reasoning_process(reasoning_process, lane)

        if reasoning_process.get("type") != reasoning_data["type"]:
            yield self._dispatch_event(
                ReasoningMessageStartEvent(
                    type=EventType.REASONING_MESSAGE_START,
                    message_id=reasoning_process["message_id"],
                    role="reasoning",
                )
            )
            reasoning_process["type"] = reasoning_data["type"]

        # Accumulate signature if present (Anthropic extended thinking)
        if reasoning_data.get("signature"):
            reasoning_process["signature"] = reasoning_data["signature"]

        if reasoning_process.get("type"):
            yield self._dispatch_event(
                ReasoningMessageContentEvent(
                    type=EventType.REASONING_MESSAGE_CONTENT,
                    message_id=reasoning_process["message_id"],
                    delta=reasoning_data["text"]
                )
            )

    async def get_checkpoint_before_message(self, message_id: str, thread_id: str, config: Optional[RunnableConfig] = None) -> Any:
        if not thread_id:
            raise ValueError("Missing thread_id in config")

        # ``aget_state_history`` needs a RunnableConfig with ``configurable.thread_id``.
        # Prefer the caller's config when provided so any downstream configurable keys
        # (graph subkey, etc.) are preserved; otherwise fall back to a thread-only
        # config derived from ``thread_id``.
        #
        # Strip ``checkpoint_id`` and ``checkpoint_ns`` from the caller's configurable:
        # if they survive into history_config, ``aget_state_history`` filters to the
        # single pinned checkpoint and the linear walk that looks up the snapshot
        # containing ``message_id`` always misses.
        history_config: RunnableConfig
        if config is not None:
            caller_configurable = {
                k: v
                for k, v in (config.get("configurable") or {}).items()
                if k not in ("checkpoint_id", "checkpoint_ns")
            }
            history_config = {
                **config,
                "configurable": {
                    **caller_configurable,
                    "thread_id": thread_id,
                },
            }
        else:
            history_config = {"configurable": {"thread_id": thread_id}}

        history_list = []
        async for snapshot in self.graph.aget_state_history(history_config):
            history_list.append(snapshot)

        history_list.reverse()
        for idx, snapshot in enumerate(history_list):
            messages = snapshot.values.get("messages", [])
            if any(getattr(m, "id", None) == message_id for m in messages):
                if idx == 0:
                    # No snapshot before this.
                    # Return a synthetic "empty before" snapshot whose
                    # values share no structure with the original:
                    # assigning back into ``snapshot.values["messages"]``
                    # mutated the real checkpoint in place (StateSnapshot
                    # is an alias, not a copy), which bled into callers
                    # and any cached history entries.
                    empty_values = snapshot.values.copy()
                    empty_values["messages"] = []
                    return snapshot._replace(values=empty_values)

                snapshot_values_without_messages = snapshot.values.copy()
                del snapshot_values_without_messages["messages"]
                checkpoint = history_list[idx - 1]

                merged_values = {**checkpoint.values, **snapshot_values_without_messages}
                checkpoint = checkpoint._replace(values=merged_values)

                return checkpoint

        raise ValueError(
            f"Message ID {message_id!r} not found in history "
            f"(thread_id={thread_id!r}, snapshots_scanned={len(history_list)})"
        )

    def _get_or_pin_text_message_id(self, fallback_id: str, node: Optional[str] = None) -> str:
        """Returns the message_id to use for a TEXT_MESSAGE_START emission,
        pinning the first id per (subagent lane, node). chunk_id changes per
        LLM invocation, so a text→tool→text sequence within one node would
        otherwise render as multiple bubbles; pinning keeps them in one. The
        pin is reset when the lane's own node changes, so different nodes (e.g.
        a supervisor routing to specialist agents) get fresh ids and stay in
        separate bubbles. Keying by lane + the lane's node (rather than a
        global node) means concurrently-streaming subagents keep independent
        bubbles and one subagent's node change never re-mints another's. See
        #1317.
        """
        lane = self._current_lane()
        pins = self.active_run.setdefault("current_text_message_ids", {})
        pin_nodes = self.active_run.setdefault("current_text_message_nodes", {})
        # Reset when this lane has no pin yet, or when THIS LANE's node actually
        # changed. The reset is driven by the lane's own node rather than the
        # global node_name, which thrashes under concurrent subagents (a node
        # change in subagent A must not re-mint subagent B's bubble). A missing
        # node (None) never forces a reset, so absent metadata can't fragment a
        # bubble.
        if pins.get(lane) is None or (node is not None and pin_nodes.get(lane) != node):
            pins[lane] = fallback_id
            pin_nodes[lane] = node
        return pins[lane]

    def handle_node_change(self, node_name: Optional[str]) -> Generator[ProcessedEvents, None, None]:
        """
        Centralized method to handle node name changes and step transitions.
        Automatically manages step start/end events based on node name changes.
        """
        # Invariant: node-change handling only happens mid-run.
        if self.active_run is None:
            raise RuntimeError("handle_node_change called outside an active run")

        if node_name == "__end__":
            node_name = None

        if node_name != self.active_run.get("node_name"):
            # End current step if we have one
            if self.active_run.get("node_name"):
                yield self.end_step()

            # Start new step if we have a node name
            if node_name:
                for event in self.start_step(node_name):
                    yield event

        self.active_run["node_name"] = node_name

    def start_step(self, step_name: str) -> Generator[ProcessedEvents, None, None]:
        """Emit STEP_STARTED for ``step_name``; node_name bookkeeping is done by handle_node_change."""
        event = self._dispatch_event(
            StepStartedEvent(
                type=EventType.STEP_STARTED,
                step_name=step_name
            )
        )
        # Remember who opened this step so end_step can attribute the close to the
        # same owner. Read back off the dispatched event rather than from
        # current_subagent_id so the two halves can never disagree about what the
        # chokepoint actually stamped.
        self.active_run["step_owner"] = getattr(event, "subagent_id", None)
        yield event

    def end_step(self) -> ProcessedEvents:
        """Emit STEP_FINISHED for the active step; node_name bookkeeping is done by handle_node_change."""
        # Invariant: end_step is only called mid-run, from handle_node_change.
        if self.active_run is None:
            raise RuntimeError("end_step called outside an active run")
        node_name = self.active_run.get("node_name")
        if not node_name:
            raise ValueError("No active step to end")

        step_owner = self.active_run.get("step_owner")
        event = self._dispatch_event(
            StepFinishedEvent(
                type=EventType.STEP_FINISHED,
                step_name=node_name
            )
        )
        # Overwrite whatever the chokepoint stamped. In the stream loop
        # reconcile_subagents runs BEFORE handle_node_change, so current_subagent_id
        # already points at the lane whose event triggered the transition, not the
        # lane that opened the step being closed. Without this, interleaved
        # subagents produce `STEP_STARTED research` under s1 paired with
        # `STEP_FINISHED research` under s2. Assigned after dispatch because the
        # correct value may be None (a parent-owned step), which the chokepoint
        # treats as "unset, go ahead and stamp".
        event.subagent_id = step_owner
        self.active_run["step_owner"] = None
        return event

    # Probe the graph's astream_events signature for version-specific support
    # (notably the ``context`` parameter, added in newer LangGraph releases)
    # so this adapter remains backwards-compatible across LangGraph versions.
    def get_stream_kwargs(
            self,
            input: Any,
            subgraphs: bool = False,
            version: Literal["v1", "v2"] = "v2",
            config: Optional[RunnableConfig] = None,
            context: Optional[Dict[str, Any]] = None,
            fork: Optional[Any] = None,
    ) -> Dict[str, Any]:
        kwargs = dict(
            input=input,
            subgraphs=subgraphs,
            version=version,
        )

        # LangGraph may expose context either as a named parameter or through
        # **kwargs, depending on the installed version.
        sig = inspect.signature(self.graph.astream_events)
        accepts_context = (
            'context' in sig.parameters
            or any(param.kind == inspect.Parameter.VAR_KEYWORD for param in sig.parameters.values())
        )
        if accepts_context:
            base_context = {}
            if isinstance(config, dict) and 'configurable' in config and isinstance(config['configurable'], dict):
                base_context.update(config['configurable'])
            if context:  # context might be None or {}
                base_context.update(context)
            if base_context:  # only add if there's something to pass
                kwargs['context'] = base_context

        if config:
            kwargs['config'] = config

        if fork:
            kwargs.update(fork)

        return kwargs

    async def get_state_and_messages_snapshots(self, config: RunnableConfig) -> AsyncGenerator[ProcessedEvents, None]:
        """Emit STATE_SNAPSHOT + MESSAGES_SNAPSHOT for the current checkpoint."""
        # Invariant: snapshot emission only happens mid-run.
        if self.active_run is None:
            raise RuntimeError("get_state_and_messages_snapshots called outside an active run")
        state = await self.graph.aget_state(config)
        # Fallback to an empty dict when state.values is missing: using the
        # StateSnapshot itself as a fallback crashed downstream .get()
        # access and made empty-checkpoint paths fail loudly instead of
        # emitting a plausible empty snapshot.
        if state.values is None:
            logger.debug(
                "StateSnapshot.values is None; treating as empty state for snapshot emission",
            )
            state_values = {}
        else:
            state_values = state.values
        # Only the parent agent emits STATE_SNAPSHOT; while a subagent is active
        # its (subgraph) state is not surfaced. The MESSAGES_SNAPSHOT below is
        # still emitted and carries the subagent's messages (merged + tagged), so
        # attribution and history survive without leaking subagent state.
        if not self.active_run.get("current_subagent_id"):
            yield self._dispatch_event(
                StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=self.get_state_snapshot(state_values))
            )

        snapshot_messages = self._filter_orphan_tool_messages(state_values.get("messages", []))
        agui_messages = self._merge_subagent_messages(
            langchain_messages_to_agui(snapshot_messages)
        )
        yield self._dispatch_event(
            MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=agui_messages,
            )
        )

    def _merge_subagent_messages(self, agui_messages: list) -> list:
        """Append subagent-attributed messages to a snapshot's message list,
        preserving each message's ``subagent_id`` so the client keeps the
        subagent attribution the frontend renders — for both text and tool calls.

        Two sources are merged, both absent from main-graph state:

        1. This run's freshly-streamed subagent messages (``subagent_messages``),
           built from the accumulator.
        2. Prior turns' subagent messages the client echoed back, split out of
           the graph input in ``run`` (``inbound_subagent_messages``). Re-emitting
           them keeps them in the client's display across turns — the client's
           MESSAGES_SNAPSHOT apply is an edit-merge that keeps a message it
           already has in its existing position, so including them here (by id)
           preserves their place without our needing to reconstruct ordering.

        No-op when neither source has anything, so runs without subagents (and
        the declared-``subgraphs`` demo, which never sets a ``subagent_id``)
        produce an identical snapshot. Messages already present (matched by id)
        are not duplicated. An assistant turn with neither text nor tool calls is
        skipped so the snapshot gains no empty bubbles; tool calls are preserved
        even when the turn has no text (a tool-call-only subagent message).
        """
        active_run = getattr(self, "active_run", None)
        sub_msgs = (active_run.get("subagent_messages") if active_run else None) or {}
        inbound = (active_run.get("inbound_subagent_messages") if active_run else None) or []
        if not sub_msgs and not inbound:
            return agui_messages
        existing_ids = {getattr(m, "id", None) for m in agui_messages}
        # 1. This run's freshly-streamed subagent messages.
        for entry in sub_msgs.values():
            if entry["id"] in existing_ids:
                continue
            if entry["kind"] == "reasoning":
                if not entry["content"]:
                    continue
                agui_messages.append(
                    ReasoningMessage(
                        id=entry["id"],
                        role="reasoning",
                        content=entry["content"],
                        encrypted_value=entry.get("encrypted_value"),
                        subagent_id=entry["subagent_id"],
                    )
                )
                existing_ids.add(entry["id"])
                continue
            if entry["kind"] == "tool":
                agui_messages.append(
                    AGUIToolMessage(
                        id=entry["id"],
                        role="tool",
                        content=entry["content"],
                        tool_call_id=entry["tool_call_id"],
                        subagent_id=entry["subagent_id"],
                    )
                )
                existing_ids.add(entry["id"])
                continue
            tool_calls = [
                AGUIToolCall(
                    id=tc["id"],
                    type="function",
                    function=FunctionCall(name=tc["name"], arguments=tc["arguments"]),
                )
                for tc in entry["tool_calls"].values()
            ]
            if not entry["content"] and not tool_calls:
                continue
            agui_messages.append(
                AssistantMessage(
                    id=entry["id"],
                    role="assistant",
                    content=entry["content"] or None,
                    tool_calls=tool_calls or None,
                    subagent_id=entry["subagent_id"],
                )
            )
            existing_ids.add(entry["id"])
        # 2. Prior turns' subagent messages echoed back by the client. Re-emit
        #    verbatim (they are already well-formed AG-UI messages carrying
        #    subagent_id) so the client retains them in place across turns.
        for m in inbound:
            mid = getattr(m, "id", None)
            if mid in existing_ids:
                continue
            agui_messages.append(m)
            existing_ids.add(mid)
        return agui_messages


def dump_json_safe(value):
    # Sharp edge: when ``value`` is already a ``str`` it is returned verbatim
    # (not re-encoded with json.dumps). Callers passing pre-serialized JSON
    # strings get them back as-is; callers passing a raw non-JSON string get
    # that raw string back — no quoting is applied.
    if isinstance(value, str):
        return value
    # Pre-process through make_json_safe to recursively convert non-string
    # dict keys (e.g. UUID) before json.dumps, which only invokes ``default``
    # for non-serializable values — never for keys.
    return json.dumps(make_json_safe(value), default=json_safe_stringify)
