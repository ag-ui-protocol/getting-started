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
    SubagentFinishedSuspendedOutcome,
    SubagentErrorEvent,
    TokenUsage,
    aggregate_token_usage,
    token_usage_from_langchain_metadata,
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
    subagent_run_id: str
    name: str
    parent_subagent_run_id: Optional[str] = None


def _command_update_tool_messages(messages: Any) -> List[ToolMessage]:
    entries = [] if messages is None else (
        messages if isinstance(messages, (list, tuple)) else [messages]
    )
    tool_messages = []
    for entry in entries:
        if isinstance(entry, ToolMessage):
            tool_messages.append(entry)
        elif (isinstance(entry, dict) and entry.get("tool_call_id")
              and (entry.get("type") == "tool" or entry.get("role") == "tool")):
            tool_messages.append(ToolMessage(content=entry.get("content") or "",
                                             tool_call_id=entry["tool_call_id"],
                                             name=entry.get("name"), id=entry.get("id")))
    return tool_messages


# Lane key for root/supervisor-level streaming state (events with no subagent).
# Subagent lanes use the derived subagent id (e.g. "tools:<uuid>").
_ROOT_LANE = "__root__"

# A public id minted for the root lane ends '::__root__' (optionally '::N' for
# repeated collisions). The suffix is load-bearing across turns: seeding
# reverse-translates it to recover the raw id the graph checkpoint holds — so
# _resolve_public_id ENFORCES its exclusivity by never emitting a verbatim
# upstream id that matches it (such an id is minted instead, which the
# reverse-translation unwinds one layer at a time, converging).


def _minted_root_suffix_re() -> "re.Pattern[str]":
    return _lane_mint_suffix_re(_ROOT_LANE)


def _lane_mint_suffix_re(lane: str) -> "re.Pattern[str]":
    return re.compile(re.escape("::" + lane) + r"(?:::\d+)?$")


def _record_subagent_boundaries(ns: str, known: set, excluded: Optional[set] = None) -> None:
    """Record `tools:<uuid>` segments that are genuine subagent boundaries.

    A boundary is a `tools:` segment directly followed by a non-`tools` node
    (the subagent's own model/middleware). A regular inner tool's ToolNode is
    USUALLY a leaf, which is how a nested subagent is told apart from a
    subagent's own tool call — but a tool that internally invokes a model or
    chain also produces `tools:X|model:Y` and would satisfy the shape test.
    ``excluded`` carries the positive counter-evidence: segments whose per-call
    ToolNode dispatch named a NON-`task` call (see _capture_task_tool_dispatch)
    are ordinary tools whatever their inner namespaces look like, and recording
    them fabricated a nested subagent that swallowed the tool's inner output.
    """
    if not ns:
        return
    segs = ns.split("|")
    for i, seg in enumerate(segs):
        if (
            seg.split(":")[0] == "tools"
            and i + 1 < len(segs)
            and segs[i + 1].split(":")[0] != "tools"
            and not (excluded and seg in excluded)
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
                subagent_run_id=chain[-1],
                name=lc_agent_name,
                parent_subagent_run_id=chain[-2] if len(chain) >= 2 else None,
            )
    # Fallback (no accumulated boundary info, e.g. standalone callers): the
    # leading segment is the subagent, with no derivable parent.
    return SubagentContext(subagent_run_id=leading, name=lc_agent_name, parent_subagent_run_id=None)


# Event types that carry a `subagent_run_id` field and should be stamped with the
# currently active subagent id at the _dispatch_event chokepoint. Every in-window
# event is tagged so the stream is self-describing per event (a consumer never
# has to reconstruct attribution from a prior event's messageId/toolCallId).
# Excludes only the run-lifecycle events, MESSAGES_SNAPSHOT (its messages are
# tagged individually), and the SUBAGENT_* lifecycle events (which carry their
# own subagent_run_id explicitly). STATE_SNAPSHOT/STATE_DELTA are attributable per
# the protocol design; this integration emits them for a subagent only on the
# explicit `manually_emit_state` path, since node-exit and checkpoint snapshots
# would carry a partial subgraph view (see the suppressions in the stream loop).
# The three client-facing presentations of a delegation. Values name what the
# CLIENT SEES, not internal switches:
#   "inline"     - the subagent's output streams as the parent's own work,
#                  byte-identical to pre-subagent behavior (the safe default:
#                  a released client cannot be protected after the fact from
#                  event types it rejects in its transport).
#   "attributed" - the full subagent surface: SUBAGENT_* lifecycle events,
#                  subagent_run_id tags, merged snapshot messages.
#   "hidden"     - invisible delegation: the client sees only the parent's
#                  `task` tool call, its TOOL_CALL_RESULT, and the parent's own
#                  reply. Nothing of the subagent's internals reaches the wire.
SUBAGENT_VISIBILITY_INLINE = "inline"
SUBAGENT_VISIBILITY_ATTRIBUTED = "attributed"
SUBAGENT_VISIBILITY_HIDDEN = "hidden"
_SUBAGENT_VISIBILITY_VALUES = (
    SUBAGENT_VISIBILITY_INLINE,
    SUBAGENT_VISIBILITY_ATTRIBUTED,
    SUBAGENT_VISIBILITY_HIDDEN,
)

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
    current_subagent_run_id tracks the CURRENT event's subagent for _dispatch_event
    stamping.

    Finishing is NOT this function's job and no longer happens only at run end:
    ``_finish_subagent_on_task_end`` emits SUBAGENT_FINISHED per subagent the moment
    its ``task`` delegation returns, so the reported status tracks the subagent's own
    lifecycle. ``drain_subagents`` is the run-end fallback for subagents whose task
    end never arrived (e.g. the graph paused at an interrupt inside one), and
    ``error_open_subagents`` is the failure-path equivalent."""
    known = active_run.setdefault("subagent_segments", set())
    _record_subagent_boundaries(ns, known, active_run.get("non_subagent_segments"))
    ctx = derive_subagent_context(ns, lc_agent_name, subgraphs, known)
    new_id = ctx.subagent_run_id if ctx else None

    # SUBAGENT_FINISHED / SUBAGENT_ERROR are terminal for the id they name, so a
    # closed subagent may neither be re-opened nor own a second terminal. All three
    # closing paths (drain_subagents, error_open_subagents, _finish_subagent_on_task_end)
    # only REMOVE the id from active_subagents, so without the `closed` set a single
    # trailing event bearing a finished subagent's namespace — its inner tooling can
    # emit after the `task` tool returns — re-opened it: two SUBAGENT_STARTED and two
    # terminals for one invocation, plus output attributed after a terminal.
    # Attribution follows the event's namespace even after that subagent closed. The
    # protocol deliberately allows a tag to name an already-finished subagent, so
    # blanking it here would silently reparent the subagent's trailing output — and its
    # state — to the parent, which is exactly what attribution exists to prevent. Only
    # the SUBAGENT_STARTED emission is gated, since re-opening a closed id would give one
    # invocation two starts and two terminals.
    active_run["current_subagent_run_id"] = new_id
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
        active_run.setdefault("subagent_parents", {})[new_id] = ctx.parent_subagent_run_id
        events.append(SubagentStartedEvent(
            type=EventType.SUBAGENT_STARTED,
            subagent_run_id=new_id,
            name=name,
            description=description,
            parent_subagent_run_id=ctx.parent_subagent_run_id,
            parent_tool_call_id=task_meta.get("parent_tool_call_id"),
            parent_message_id=task_meta.get("parent_message_id"),
        ))
    return events


def close_lane_steps(active_run, ids) -> list:
    """Emit STEP_FINISHED for any step still open in the given subagents' lanes.

    Steps are tracked per lane, so a subagent's own step no longer gets closed as a
    side effect of the parent's next node transition -- which is the point, but it
    means a lane's step has to be closed explicitly when that lane ends. Without
    this the step leaks: clients require every step closed before RUN_FINISHED, so
    the run would fail with "steps are still active" naming the subagent.

    Emitted BEFORE the subagent's own terminal, so the step closes inside the
    subagent's window rather than after it.
    """
    lane_nodes = active_run.get("lane_nodes") or {}
    step_owners = active_run.get("step_owners") or {}
    events = []
    for sid in ids:
        node = lane_nodes.get(sid)
        if not node:
            continue
        events.append(
            StepFinishedEvent(
                type=EventType.STEP_FINISHED,
                step_name=node,
                subagent_run_id=step_owners.get(sid, sid),
            )
        )
        lane_nodes.pop(sid, None)
        step_owners.pop(sid, None)
    return events


def _lanes_needing_a_step_close(active_run, ids) -> list:
    """The subagent lanes whose open step has to be closed at run/error end.

    Not just the still-open subagents: a subagent's lane can hold an open step
    AFTER that subagent closed. reconcile_subagents deliberately keeps attributing
    trailing events to a finished subagent (blanking the lane would reparent its
    output to the parent), so a trailing event on a new node makes
    handle_node_change open a step in the closed lane. Closing only the active ids
    left that step open through RUN_FINISHED, and clients abort the run with
    "steps are still active" — which is exactly the failure per-lane step tracking
    exists to avoid.

    Active ids come first so their close still lands inside their own window,
    immediately before their terminal event.
    """
    lane_nodes = active_run.get("lane_nodes") or {}
    named = set(ids)
    # `None` is the parent lane: its step is closed by handle_node_change at the end
    # of the run, not here.
    return list(ids) + [
        lane for lane in lane_nodes
        if lane is not None and lane not in named
    ]


def _clear_subagent_lanes(active_run, ids) -> None:
    """Drop the lane bookkeeping for the given lanes without emitting anything.

    Used by the flag-off early returns: no client-visible event may escape, but the
    lanes still have to be torn down or the next turn starts with steps and
    subagents that look open.
    """
    lane_nodes = active_run.get("lane_nodes") or {}
    step_owners = active_run.get("step_owners") or {}
    for lane in _lanes_needing_a_step_close(active_run, ids):
        lane_nodes.pop(lane, None)
        step_owners.pop(lane, None)


def _is_deepagents_task_call(tool_call) -> bool:
    """A pending call counts as a deepagents delegation only by SHAPE.

    The name alone is not evidence — an ordinary root tool may legally be
    named "task". The adapter's runtime contract (see
    _capture_subagent_task_meta) is that a deepagents `task` input carries
    ``subagent_type``; the replay evidence requires exactly the same marker,
    no stricter and no looser than the live path.
    """
    name = (
        tool_call.get("name") if isinstance(tool_call, dict) else getattr(tool_call, "name", None)
    )
    if name != "task":
        return False
    args = (
        tool_call.get("args") if isinstance(tool_call, dict) else getattr(tool_call, "args", None)
    )
    return isinstance(args, dict) and "subagent_type" in args


def _pending_tool_calls_are_all_task(messages) -> bool:
    """True when the checkpoint's pending tool calls are all `task` delegations.

    "Pending" = an assistant tool call with no matching ToolMessage yet — for a
    run interrupted mid-delegation, that is exactly the spawning `task` call
    that has not returned. This is the durable, checkpoint-persisted evidence
    that an interrupted `tools` task IS a deepagents delegation (see the
    no-resume replay attribution in prepare_stream). A delegation is matched
    by SHAPE, not name (see _is_deepagents_task_call). Any pending call that
    is not a delegation means the interrupted tasks may be ordinary tool
    executions, so the caller must not attribute; no pending calls at all
    (e.g. a declared subgraph node that happens to be named "tools") means
    the same.
    """
    if not messages:
        return False
    answered = {
        getattr(m, "tool_call_id", None)
        for m in messages
        if isinstance(m, ToolMessage)
    }
    pending = [
        tool_call
        for m in messages
        if isinstance(m, AIMessage)
        for tool_call in (getattr(m, "tool_calls", None) or [])
        if (tool_call.get("id") if isinstance(tool_call, dict) else getattr(tool_call, "id", None))
        not in answered
    ]
    if not pending:
        return False
    return all(_is_deepagents_task_call(tool_call) for tool_call in pending)


def _interrupts_from_tool_error(error) -> Optional[tuple]:
    """The Interrupt objects carried by an interrupt-shaped tool "error", or None.

    LangGraph propagates an interrupt raised INSIDE a subagent (e.g.
    HumanInTheLoopMiddleware) through the parent's ``task`` tool as an
    ``on_tool_error`` whose error is a ``GraphInterrupt`` — a pause, not a
    failure. Callers use this to tell the two apart. Returns a (possibly
    empty) tuple of Interrupt objects when the error is interrupt-shaped,
    else None. The isinstance check is primary; the duck-typed fallback
    (args that are all Interrupt-shaped: ``value`` + ``id``) covers wrapped
    or re-raised variants.
    """
    if error is None:
        return None
    try:
        from langgraph.errors import GraphInterrupt
        from langgraph.types import Interrupt
    except ImportError:  # pragma: no cover - langgraph is a hard dependency
        return None
    candidates = getattr(error, "args", None) or ()
    # GraphInterrupt((interrupt, ...)) puts the interrupt TUPLE in args[0].
    if len(candidates) == 1 and isinstance(candidates[0], (tuple, list)):
        candidates = tuple(candidates[0])
    if isinstance(error, GraphInterrupt):
        return tuple(c for c in candidates if isinstance(c, Interrupt))
    # A re-raised/wrapped propagation still counts — but only when every arg
    # is an ACTUAL langgraph Interrupt instance. Structural duck typing
    # (attributes named `value` and `id`) misclassified ordinary recovered
    # failures whose exception happened to carry a payload of that shape,
    # reporting a genuinely FAILED subagent as FINISHED.
    if candidates and all(isinstance(c, Interrupt) for c in candidates):
        return tuple(candidates)
    return None


def _deepest_first(active_run, ids) -> list:
    """Order subagent ids so children come before their (grand)parents.

    active_subagents preserves registration order, which is shallow-first for
    nested subagents — tearing down in that order ends an outer subagent's
    lifecycle before its still-open inner one, violating containment. The sort
    is stable, so siblings keep their registration order.
    """
    parents = active_run.get("subagent_parents") or {}

    def depth(sid):
        d = 0
        cur = sid
        seen = set()
        while cur in parents and cur not in seen:
            seen.add(cur)
            cur = parents[cur]
            d += 1
        return d

    return sorted(ids, key=depth, reverse=True)


def drain_subagents(active_run) -> list:
    """Emit SUBAGENT_FINISHED for any still-open subagents (before RUN_FINISHED)."""
    ids = list(active_run.get("active_subagents", {}).keys())
    if not active_run.get("emit_subagent_events"):
        # Lane bookkeeping still has to be torn down even when the events are withheld,
        # otherwise the next turn starts with subagents that look active.
        _clear_subagent_lanes(active_run, ids)
        active_run["active_subagents"].clear()
        active_run.setdefault("closed_subagents", set()).update(ids)
        active_run["current_subagent_run_id"] = None
        return []
    # Trailing lanes first: lanes whose subagent already finished but still hold
    # an open step (see _lanes_needing_a_step_close). Their owners get no second
    # terminal, so their step closes cannot nest inside any window and lead.
    trailing = [l for l in _lanes_needing_a_step_close(active_run, []) if l not in ids]
    events = close_lane_steps(active_run, trailing)
    # Then each still-open subagent, deepest-first, its step close immediately
    # before its own terminal so the close lands inside its window and an inner
    # subagent's lifecycle ends before its parent's.
    #
    # A lane whose confirmed interrupt suspended the run (see the
    # reconciliation in _handle_stream_events) closes with a typed "suspended"
    # outcome carrying the interrupt ids it owns, so the client renders
    # "waiting" rather than "done" — an ancestor of a suspended lane is
    # suspended too, with no owned ids. Every other lane keeps the legacy
    # plain FINISHED (omitted outcome means success).
    suspended_lanes = active_run.get("suspended_subagent_interrupts") or {}
    for sid in _deepest_first(active_run, ids):
        events += close_lane_steps(active_run, [sid])
        if sid in suspended_lanes:
            events.append(SubagentFinishedEvent(
                type=EventType.SUBAGENT_FINISHED,
                subagent_run_id=sid,
                outcome=SubagentFinishedSuspendedOutcome(
                    interrupt_ids=suspended_lanes[sid] or None,
                ),
            ))
        else:
            events.append(SubagentFinishedEvent(type=EventType.SUBAGENT_FINISHED, subagent_run_id=sid))
    active_run["active_subagents"].clear()
    # Terminal for these ids — see reconcile_subagents.
    active_run.setdefault("closed_subagents", set()).update(ids)
    active_run["current_subagent_run_id"] = None
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
    if not active_run.get("emit_subagent_events"):
        _clear_subagent_lanes(active_run, ids)
        active_run.get("active_subagents", {}).clear()
        active_run.setdefault("closed_subagents", set()).update(ids)
        active_run["current_subagent_run_id"] = None
        return []
    # Close each lane's open step before its terminal, same as the drain path. A step
    # left open on the error path fails the clients' "all steps closed" rule just as
    # surely as one left open on the success path — including a step opened by a
    # trailing event in an already-closed subagent's lane. Same ordering as the
    # drain: trailing lanes lead, then deepest-first with each step close
    # immediately before its own terminal.
    trailing = [l for l in _lanes_needing_a_step_close(active_run, []) if l not in ids]
    events = close_lane_steps(active_run, trailing)
    for sid in _deepest_first(active_run, ids):
        events += close_lane_steps(active_run, [sid])
        events.append(SubagentErrorEvent(type=EventType.SUBAGENT_ERROR, subagent_run_id=sid, message=message))
    active_run.get("active_subagents", {}).clear()
    # Terminal for these ids — see reconcile_subagents.
    active_run.setdefault("closed_subagents", set()).update(ids)
    active_run["current_subagent_run_id"] = None
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
    def __init__(self, *, name: str, graph: CompiledStateGraph, description: Optional[str] = None, config:  Union[Optional[RunnableConfig], dict] = None, enable_legacy_on_interrupt_event: bool = True, emit_interrupt_outcome: bool = False, emit_raw_events: bool = True, emit_subagent_events: Optional[bool] = None, subagent_visibility: Optional[str] = None):
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
        # Opt-in: emit the subagent protocol surface. OFF by default, because a client
        # cannot be protected from it after the fact. An @ag-ui/client at or below
        # 0.0.57 validates every event against a discriminated union AS IT COMES OFF THE
        # WIRE, in the HTTP transport, using the throwing `EventSchemas.parse`. So a
        # single SUBAGENT_STARTED kills the whole stream before any middleware could
        # filter it -- there is no consumer-side fix for an already-released client, which
        # is why the switch has to live here. (`subagentRunId` alone is harmless: the
        # schemas are passthrough, so an unknown FIELD on a known event is accepted. It is
        # the unknown EVENT TYPES that break.)
        #
        # When off, this agent behaves exactly as it did before subagent support existed:
        # no SUBAGENT_* events, no subagent_run_id on anything, no subagent messages in
        # MESSAGES_SNAPSHOT, and steps flattened as they were. A subagent still runs and
        # its text and tool calls still reach the client -- they simply arrive as the
        # parent's own work, which is what a pre-subagent client expects.
        #
        # Flip the default once a released client understands the events. Requested this
        # way by a design partner whose package proxy refuses prerelease builds.
        #
        # subagent_visibility supersedes the boolean: "inline" (the default,
        # exactly the False behavior above), "attributed" (the True behavior),
        # and "hidden" (invisible delegation: the subagent's internal stream is
        # suppressed entirely — the client sees only the parent's `task` call,
        # its result, and the parent's own reply; see _dispatch_event). The
        # boolean stays as an alias for one cycle (True -> "attributed",
        # False -> "inline") because the design partner's harness already sets
        # it; passing both with conflicting meanings is an error.
        if subagent_visibility is not None and subagent_visibility not in _SUBAGENT_VISIBILITY_VALUES:
            raise ValueError(
                f"subagent_visibility must be one of {_SUBAGENT_VISIBILITY_VALUES}, got {subagent_visibility!r}"
            )
        if emit_subagent_events is not None:
            alias_visibility = (
                SUBAGENT_VISIBILITY_ATTRIBUTED if emit_subagent_events else SUBAGENT_VISIBILITY_INLINE
            )
            if subagent_visibility is not None and subagent_visibility != alias_visibility:
                raise ValueError(
                    f"emit_subagent_events={emit_subagent_events} conflicts with "
                    f"subagent_visibility={subagent_visibility!r}; pass only subagent_visibility"
                )
            subagent_visibility = alias_visibility
        self.subagent_visibility = subagent_visibility or SUBAGENT_VISIBILITY_INLINE
        # Derived: every existing subagent gate keys on this boolean, and only
        # "attributed" emits the subagent surface. "hidden" deliberately reads
        # as False here — it shares inline's teardown paths and adds
        # suppression at the _dispatch_event chokepoint.
        self.emit_subagent_events = self.subagent_visibility == SUBAGENT_VISIBILITY_ATTRIBUTED
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

        Every constructor flag must survive a clone: the FastAPI endpoint
        clones per request, so a flag silently dropped here reverts to its
        default in the standard serving path. But subclasses narrower than
        this class exist in the wild — the released copilotkit
        LangGraphAGUIAgent accepts only (name, graph, description, config),
        and blindly passing every flag made each request 500 on a TypeError.
        So the clone is signature-aware: a flag the subclass cannot accept is
        OMITTED when it still holds its default (the subclass's super() chain
        re-applies the same default, nothing is lost) and RAISES when it does
        not (dropping a non-default flag is the silent-revert bug the
        always-pass design guarded against). Inline/attributed travel as the
        boolean alias so pre-subagent_visibility subclasses keep cloning;
        "hidden" needs the new kwarg, so opting in requires accepting it.
        """
        flag_defaults = {
            "enable_legacy_on_interrupt_event": (self.enable_legacy_on_interrupt_event, True),
            "emit_interrupt_outcome": (self.emit_interrupt_outcome, False),
            "emit_raw_events": (self.emit_raw_events, True),
        }
        if self.subagent_visibility == SUBAGENT_VISIBILITY_HIDDEN:
            flag_defaults["subagent_visibility"] = (
                self.subagent_visibility, SUBAGENT_VISIBILITY_INLINE,
            )
        else:
            flag_defaults["emit_subagent_events"] = (self.emit_subagent_events, False)

        try:
            parameters = inspect.signature(type(self).__init__).parameters
            accepts_var_kw = any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in parameters.values()
            )
        except (TypeError, ValueError):
            parameters, accepts_var_kw = None, True

        kwargs = {
            "name": self.name,
            "graph": self.graph,
            "description": self.description,
            "config": dict(self.config) if self.config else None,
        }
        _KW_KINDS = (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
        for key, (value, default) in flag_defaults.items():
            # A named parameter is only keyword-passable when its KIND allows it:
            # a positional-only flag parameter would receive the keyword and
            # throw, so it counts as "cannot accept" (omit at default, raise
            # otherwise) exactly like an absent parameter.
            if accepts_var_kw or parameters is None or (
                key in parameters and parameters[key].kind in _KW_KINDS
            ):
                kwargs[key] = value
            elif value != default:
                raise TypeError(
                    f"{type(self).__name__}.__init__ does not accept '{key}', but this "
                    f"agent sets it to {value!r} (default {default!r}). Override clone() "
                    f"or accept the parameter — omitting it would silently revert the "
                    f"flag on every request."
                )

        try:
            return type(self)(**kwargs)
        except TypeError as exc:
            raise TypeError(
                f"{type(self).__name__} must override clone() or ensure its "
                f"__init__ accepts (name, graph, description, config) as "
                f"keyword arguments: {exc}"
            ) from exc


    def _streamed_call_key(self, public_call_id):
        """Membership key for streamed_tool_call_ids.

        Hidden runs without attributed mode's collision-minting registry, so a
        nested `task` call reusing the parent's raw id collides on a bare-id
        key: the inner completion discarded the parent's membership and the
        parent's completion re-emitted a full visible Start/Args/End. Scoping
        the key by lane keeps the two memberships apart. Inline and attributed
        keep the bare public id — inline is byte-identical legacy (single
        effective membership space, as before), attributed's minting already
        makes public ids unique per lane.
        """
        if self.subagent_visibility == SUBAGENT_VISIBILITY_HIDDEN:
            return (self.active_run.get("current_subagent_run_id"), public_call_id)
        return public_call_id

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

        # "hidden": invisible delegation. Suppression is IDENTITY-PAIRED, not
        # purely window-based, because entities straddle the window boundary:
        # the parent's `tools` step opens before the subagent's first event and
        # its close can land inside the window (the node transition that closes
        # it is often triggered by the subagent's own first event). A naive
        # window filter would orphan that close on the wire. So: window
        # membership decides whether an OPENER is suppressed; every follower is
        # then suppressed iff its opener was, by id — and a follower of a
        # visible pre-window opener stays visible even mid-window.
        if self.subagent_visibility == SUBAGENT_VISIBILITY_HIDDEN and active_run is not None:
            if self._hidden_should_suppress(active_run, event):
                return None

        current_subagent_run_id = (
            active_run.get("current_subagent_run_id")
            if active_run and self.emit_subagent_events
            else None
        )
        if (
            current_subagent_run_id
            and event.type in _SUBAGENT_ATTRIBUTABLE_EVENT_TYPES
            and getattr(event, "subagent_run_id", None) is None
        ):
            event.subagent_run_id = current_subagent_run_id

        self._accumulate_subagent_message(event)

        return event

    def _hidden_should_suppress(self, active_run, event: ProcessedEvents) -> bool:
        """Decide whether `subagent_visibility="hidden"` withholds this event.

        The wire must stay pairwise-coherent: no STEP_FINISHED without its
        STEP_STARTED, no TEXT_MESSAGE_CONTENT without its START. Openers are
        suppressed when they occur inside a subagent window
        (current_subagent_run_id set); followers and closers inherit their
        opener's fate by id, regardless of where the window is by then.
        """
        in_window = bool(active_run.get("current_subagent_run_id"))
        state = active_run.setdefault(
            "hidden_suppressed",
            {
                "messages": set(), "tool_calls": set(), "steps": {},
                # Ids the wire has SEEN as visible openers. Two jobs: a later
                # visible opener RETIRES a suppressed id (upstream ids can be
                # reused across turns/entities — permanence corrupted the new
                # entity), and an in-window opener COLLIDING with a visible id
                # must not poison the visible entity's followers (hidden runs
                # without the attributed mode's collision-minting registry, so
                # a subagent reusing the parent's `task` call id otherwise
                # suppressed the parent's own TOOL_CALL_RESULT).
                "visible_messages": set(), "visible_tool_calls": set(),
                # Colliding ids: suppressed while the window is open (the
                # collision's own followers), visible after it (the original
                # entity's — the parent's task result arrives post-window).
                "contested": set(),
            },
        )
        etype = event.type

        if etype == EventType.STEP_STARTED:
            if in_window:
                steps = state["steps"]
                key = self._hidden_step_key(active_run, event)
                steps[key] = steps.get(key, 0) + 1
                return True
            return False
        if etype == EventType.STEP_FINISHED:
            steps = state["steps"]
            key = self._hidden_step_key(active_run, event)
            if steps.get(key, 0) > 0:
                steps[key] -= 1
                return True
            if "subagent_run_id" not in getattr(event, "model_fields_set", set()):
                matches = [k for k, count in steps.items() if k[1] == event.step_name and count > 0]
                if len(matches) == 1:
                    steps[matches[0]] -= 1
                    return True
            # Closes a step whose open was emitted (e.g. the parent's `tools`
            # step closing mid-window) — must stay visible.
            return False

        if etype in (EventType.TEXT_MESSAGE_START, EventType.REASONING_MESSAGE_START, EventType.REASONING_START):
            if in_window:
                if event.message_id in state["visible_messages"]:
                    state["contested"].add(event.message_id)
                else:
                    state["messages"].add(event.message_id)
                return True
            state["visible_messages"].add(event.message_id)
            state["messages"].discard(event.message_id)
            state["contested"].discard(event.message_id)
            return False
        if etype in (
            EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END,
            EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_END,
            EventType.REASONING_END,
        ):
            message_id = getattr(event, "message_id", None)
            if message_id in state["messages"]:
                return True
            return in_window and message_id in state["contested"]
        if etype in (EventType.TEXT_MESSAGE_CHUNK, EventType.REASONING_MESSAGE_CHUNK):
            message_id = getattr(event, "message_id", None)
            if message_id is not None:
                if message_id in state["messages"]:
                    return True
                if in_window:
                    if message_id in state["visible_messages"]:
                        state["contested"].add(message_id)
                    else:
                        state["messages"].add(message_id)
                    return True
                state["visible_messages"].add(message_id)
                state["contested"].discard(message_id)
                return False
            # An id-less continuation chunk belongs to whatever is open in this
            # stream position; inside the window that is the subagent's stream.
            return in_window

        if etype == EventType.TOOL_CALL_START:
            if in_window:
                if event.tool_call_id in state["visible_tool_calls"]:
                    state["contested"].add(event.tool_call_id)
                else:
                    state["tool_calls"].add(event.tool_call_id)
                return True
            state["visible_tool_calls"].add(event.tool_call_id)
            state["tool_calls"].discard(event.tool_call_id)
            state["contested"].discard(event.tool_call_id)
            return False
        if etype in (EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT):
            tool_call_id = getattr(event, "tool_call_id", None)
            if tool_call_id in state["tool_calls"]:
                return True
            return in_window and tool_call_id in state["contested"]
        if etype == EventType.TOOL_CALL_CHUNK:
            tool_call_id = getattr(event, "tool_call_id", None)
            if tool_call_id is not None:
                if tool_call_id in state["tool_calls"]:
                    return True
                if in_window:
                    if tool_call_id in state["visible_tool_calls"]:
                        state["contested"].add(tool_call_id)
                    else:
                        state["tool_calls"].add(tool_call_id)
                    return True
                state["visible_tool_calls"].add(tool_call_id)
                state["contested"].discard(tool_call_id)
                return False
            return in_window

        if etype == EventType.REASONING_ENCRYPTED_VALUE:
            entity_id = getattr(event, "entity_id", None)
            if entity_id is not None and (
                entity_id in state["messages"] or entity_id in state["tool_calls"]
            ):
                return True
            return in_window

        # State and RAW leak through gaps the window cannot see: DeepAgents'
        # boundary chain events arrive under a bare `tools:<uuid>` namespace
        # (no `|`) before any lane exists, and post-close boundary events
        # trail after it. Suppression stays PROVENANCE-based — an earlier
        # delegation-in-flight blanket starved a concurrent root tool's RAW
        # and the parent's own manually_emit_state, losing a legitimate parent
        # state update permanently. Subagent-derived transition snapshots are
        # stopped at their trigger site instead (the stream loop knows the
        # triggering event), so window membership is all STATE needs here.
        if etype in (EventType.STATE_SNAPSHOT, EventType.STATE_DELTA):
            return in_window
        if etype == EventType.RAW:
            if in_window:
                return True
            return self._raw_payload_is_subagent_side(active_run, getattr(event, "event", None))

        # Windowless pairing does not apply to the rest of the attributable
        # surface (activity/custom): those are point events, dropped purely by
        # window membership.
        if etype in _SUBAGENT_ATTRIBUTABLE_EVENT_TYPES:
            return in_window
        return False

    def _hidden_step_key(self, active_run, event: ProcessedEvents) -> tuple:
        owner = getattr(event, "subagent_run_id", None)
        if "subagent_run_id" not in getattr(event, "model_fields_set", set()):
            owner = active_run.get("current_subagent_run_id")
        return (owner, event.step_name)

    def _raw_payload_is_subagent_side(self, active_run, payload) -> bool:
        """Whether a RAW event's upstream payload originates inside a subagent.

        Mirrors derive_subagent_context's fallback but WITHOUT the nested-`|`
        requirement: the delegation's boundary chain events (the `task`
        ToolNode entering/leaving) run under `tools:<uuid>` alone, with the
        subagent's lc_agent_name — visible-parent events never look like that.
        """
        if not isinstance(payload, dict):
            return False
        metadata = payload.get("metadata") or {}
        ns = metadata.get("langgraph_checkpoint_ns") or ""
        if not ns:
            return False
        segments = ns.split("|")
        known = active_run.get("subagent_segments") or set()
        if any(segment in known for segment in segments):
            return True
        leading = segments[0]
        root_name = leading.split(":")[0]
        return (
            ":" in leading
            and root_name not in self.subgraphs
            and bool(metadata.get("lc_agent_name"))
        )

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
        task_calls = [c for c in task_calls if _is_deepagents_task_call(c)]
        active_run = getattr(self, "active_run", None)
        if active_run is None:
            return
        ns = metadata.get("langgraph_checkpoint_ns")
        # A dispatch whose calls are all NON-`task` is an ordinary tool: its
        # namespace segment must never be treated as a subagent boundary, even
        # if the tool internally invokes a model and so produces the
        # tools:X|model:Y shape the boundary heuristic looks for (see
        # _record_subagent_boundaries). Without this counter-evidence a
        # runnable-invoking tool fabricated a nested subagent that swallowed
        # its inner output.
        if candidates and not task_calls and ns:
            tool_segs = [s for s in ns.split("|") if s.split(":")[0] == "tools"]
            if tool_segs:
                active_run.setdefault("non_subagent_segments", set()).add(tool_segs[-1])
            return
        # A single task call per ToolNode namespace is the unambiguous case.
        # Multiple in one namespace (older batched shapes) fall back to FIFO.
        if len(task_calls) != 1:
            if len(task_calls) > 1:
                logger.debug(
                    "batched ToolNode dispatch with %d `task` calls in one namespace "
                    "(ns=%r); parent links fall back to FIFO order",
                    len(task_calls),
                    metadata.get("langgraph_checkpoint_ns"),
                )
            return
        tool_call_id = task_calls[0]["id"]
        if ns:
            active_run.setdefault("task_tool_call_ids_by_ns", {})[ns] = tool_call_id

    def _capture_subagent_task_meta(self, event: dict) -> None:
        """Record a subagent invocation's declared name + description from the
        deepagents ``task`` delegation tool's ``on_tool_start``.

        The ``task`` tool executes in the subagent's own checkpoint namespace, and
        its input carries ``subagent_type`` and ``description``. For a single level
        of delegation that namespace is just ``tools:<uuid>``; under nesting it is
        the whole chain (``tools:<outer>|tools:<inner>``), so the subagent id is the
        DEEPEST ``tools:`` segment — the same value ``derive_subagent_context``
        derives from the accumulated boundary segments. Capturing it here (which
        runs before the subagent's own events trigger SUBAGENT_STARTED) lets that
        event report the declared subagent type and the per-invocation description.
        No-op for non-task tools and non-deepagents runs (input without
        ``subagent_type``); a tool actually named ``task`` failing that shape check
        is logged, since it means the delegation tool's contract changed.
        """
        if event.get("event") != LangGraphEventTypes.OnToolStart.value:
            return
        tool_input = (event.get("data") or {}).get("input")
        if not isinstance(tool_input, dict) or "subagent_type" not in tool_input:
            # The shape-based trigger is deliberate (it is what makes this a no-op for
            # every non-deepagents tool), but a tool actually NAMED `task` failing it
            # means the delegation tool's input shape changed — from then on every
            # subagent silently loses its declared type, description and parent links.
            # Distinguish that from the correct silence for other tools.
            if event.get("name") == "task":
                logger.warning(
                    "`task` tool on_tool_start input has an unexpected shape "
                    "(type=%s, keys=%r); subagent name/description/parent links will "
                    "fall back to runtime metadata",
                    type(tool_input).__name__,
                    sorted(tool_input) if isinstance(tool_input, dict) else None,
                )
            return
        # The task on_tool_start runs *in* the new subagent's own ToolNode, so the
        # deepest `tools:` segment of its ns is the new subagent's id (matches the
        # chain derivation in reconcile_subagents). Single-level: same as before.
        ns = (event.get("metadata") or {}).get("langgraph_checkpoint_ns", "")
        tool_segs = [s for s in ns.split("|") if s.split(":")[0] == "tools"] if ns else []
        subagent_run_id = tool_segs[-1] if tool_segs else (ns.split("|")[0] if ns else "")
        if not subagent_run_id:
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
        # The spawning `task` call was streamed by this subagent's PARENT lane
        # (the second-deepest `tools:` segment; the root lane for top-level
        # subagents). Raw call ids can collide across lanes, so the raw id
        # alone can name another lane's unrelated call — the lane pins which
        # record (and thus which PUBLIC ids) the client actually saw.
        parent_lane = tool_segs[-2] if len(tool_segs) >= 2 else _ROOT_LANE
        task_call = {}
        if originating_tool_call_id is not None:
            match_index = next(
                (i for i, c in enumerate(pending)
                 if c.get("tool_call_id") == originating_tool_call_id
                 and c.get("lane") == parent_lane),
                None,
            )
            if match_index is None:
                # No lane-exact record; a raw-only match is safe only for a
                # record that carries no lane at all (legacy shape). A record
                # whose lane DIFFERS from parent_lane is another lane's call
                # that happens to share the raw id — "only one candidate" does
                # not make stealing it safe: the spawning lane's call may
                # simply never have streamed a chunk (OnToolEnd re-emits such
                # calls later, under the parent lane's public id).
                raw_matches = [
                    i for i, c in enumerate(pending)
                    if c.get("tool_call_id") == originating_tool_call_id
                    and c.get("lane") is None
                ]
                match_index = raw_matches[0] if len(raw_matches) == 1 else None
            if match_index is not None:
                task_call = pending.pop(match_index)
            else:
                # The exact call is known even if no streamed chunk supplied its
                # parent_message_id (e.g. tool-call emission not yet observed).
                # Resolve the PUBLIC id in the parent lane — that is the id the
                # client will see when the call is eventually emitted (the
                # OnToolEnd re-emit resolves through the same lane map), and the
                # raw id may name another lane's already-claimed public id.
                task_call = {
                    "tool_call_id": originating_tool_call_id,
                    "public_tool_call_id": self._resolve_public_tool_call_id(
                        originating_tool_call_id, parent_lane
                    ),
                }
        elif pending:
            # Fallback with no dispatch info: prefer the parent lane's own
            # queue before the global one, so a missing dispatch capture in one
            # lane cannot steal another lane's pending record. With exactly ONE
            # candidate the link is unambiguous (a single call cannot reorder).
            # With MORE than one, a FIFO guess names the wrong call whenever
            # the task starts reorder (async wrappers, HITL, concurrent
            # scheduling) — and a wrong parent link nests the subagent under
            # another delegation's tool card. Attribution is never invented on
            # this branch, so the links are omitted instead: the lifecycle event
            # simply carries no parent correlation, which the protocol allows
            # (the fields are optional).
            candidate_indexes = [
                i for i, c in enumerate(pending) if c.get("lane") == parent_lane
            ] or list(range(len(pending)))
            if len(candidate_indexes) == 1:
                task_call = pending.pop(candidate_indexes[0])
                logger.warning(
                    "no per-call `task` ToolNode dispatch captured for ns=%r; linking "
                    "this subagent to the sole pending call tool_call_id=%r",
                    ns,
                    task_call.get("tool_call_id"),
                )
            else:
                logger.warning(
                    "no per-call `task` ToolNode dispatch captured for ns=%r and %d "
                    "pending `task` calls are candidates; omitting parentToolCallId/"
                    "parentMessageId rather than guessing a possibly-wrong link",
                    ns,
                    len(candidate_indexes),
                )
        active_run.setdefault("subagent_task_meta", {})[subagent_run_id] = {
            "name": tool_input.get("subagent_type"),
            "description": tool_input.get("description"),
            # The PUBLIC id when the call's chunk was streamed (what the client
            # saw); the raw id is its own public id when no chunk supplied one
            # (the id was then never emitted under a minted name).
            "parent_tool_call_id": task_call.get("public_tool_call_id") or task_call.get("tool_call_id"),
            "parent_message_id": task_call.get("parent_message_id"),
        }
        # Map this `task` invocation's run_id to its subagent_run_id so the matching
        # OnToolEnd can finish exactly this subagent (see
        # _finish_subagent_on_task_end). The subagent's own inner tools (grep,
        # write_file, …) share its checkpoint namespace, so ns matching alone
        # would finish it prematurely; the run_id is unique to the task call.
        run_id = event.get("run_id")
        if run_id:
            active_run.setdefault("subagent_task_runs", {})[run_id] = subagent_run_id

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

        Also handles ``on_tool_error`` for the same run_id: a failed delegation
        ends in SUBAGENT_ERROR. Without this the error only cleared streaming
        flags, the mappings stayed active, and — when the parent recovered and
        the run completed normally — the run-end drain reported the FAILED
        subagent as successfully FINISHED.
        """
        event_name = event.get("event")
        if event_name not in (
            LangGraphEventTypes.OnToolEnd.value,
            LangGraphEventTypes.OnToolError.value,
        ):
            return []
        is_error = event_name == LangGraphEventTypes.OnToolError.value
        active_run = getattr(self, "active_run", None)
        if active_run is None:
            return []
        run_id = event.get("run_id")
        if is_error:
            # An interrupt raised inside the subagent propagates through the
            # `task` tool as an on_tool_error carrying a GraphInterrupt. That
            # is a PAUSE, not a failure: emitting SUBAGENT_ERROR (with the raw
            # Interrupt repr as its message) reported a healthy, suspended
            # subagent as dead — a design partner hit exactly this with
            # HumanInTheLoopMiddleware. Leave every mapping intact: the run is
            # about to end on the interrupt path, drain_subagents finishes the
            # subagent (the documented suspend contract — on resume it replays
            # and re-emits SUBAGENT_STARTED), and the recorded interrupt ids
            # let the run-end interrupt tail attribute on_interrupt to the
            # subagent that raised it (see _emit_interrupt_finish).
            interrupts = _interrupts_from_tool_error((event.get("data") or {}).get("error"))
            if interrupts is not None:
                suspended = (active_run.get("subagent_task_runs") or {}).get(run_id)
                if suspended and self.emit_subagent_events:
                    owners = active_run.setdefault("interrupt_subagents", {})
                    for interrupt in interrupts:
                        interrupt_id = getattr(interrupt, "id", None)
                        if interrupt_id:
                            # setdefault, not assignment: a nested interrupt
                            # bubbles child-first through the inner and then
                            # the OUTER task boundary with the same id — the
                            # first (deepest) recording is the owner, and the
                            # outer boundary must not overwrite it. The outer
                            # lane still suspends as an ancestor (with no owned
                            # ids) via the reconciliation's ancestor expansion.
                            owners.setdefault(interrupt_id, suspended)
                return []
        subagent_run_id = (active_run.get("subagent_task_runs") or {}).pop(run_id, None)
        if not subagent_run_id:
            return []
        if subagent_run_id not in active_run.get("active_subagents", {}):
            return []
        del active_run["active_subagents"][subagent_run_id]
        # Terminal for this id — see reconcile_subagents.
        active_run.setdefault("closed_subagents", set()).add(subagent_run_id)
        # Control returns to the subagent that INVOKED this one: the `task`
        # tool's result (and any further events at this level) belongs to the
        # parent, not the root. Restore current_subagent_run_id to the finishing
        # subagent's parent — None for a top-level subagent, so single-level
        # behavior (result attributed to root) is unchanged.
        parent_subagent_run_id = (active_run.get("subagent_parents") or {}).pop(subagent_run_id, None)
        if active_run.get("current_subagent_run_id") == subagent_run_id:
            active_run["current_subagent_run_id"] = parent_subagent_run_id
        # Same gate as drain_subagents / error_open_subagents: the lifecycle
        # bookkeeping above still has to happen so lanes and parents stay
        # coherent, but the client-visible event is withheld when the flag is
        # off. This emitter was the one path missing the gate, so a deepagents
        # run leaked SUBAGENT_FINISHED with the flag at its default — the exact
        # event the flag exists to withhold, and one that even new clients
        # reject when no SUBAGENT_STARTED preceded it. Read from self, like
        # _dispatch_event does (the module-level emitters read active_run only
        # because they have no instance).
        if not self.emit_subagent_events:
            (active_run.get("lane_nodes") or {}).pop(subagent_run_id, None)
            (active_run.get("step_owners") or {}).pop(subagent_run_id, None)
            return []
        if is_error:
            # str(exc) is "" for a bare exception; fall back to repr so the
            # terminal always says something (same rule as the hard-exception
            # path in _handle_stream_events).
            error = (event.get("data") or {}).get("error")
            message = (str(error) if error is not None else "") or (
                repr(error) if error is not None else "task tool failed"
            )
            return close_lane_steps(active_run, [subagent_run_id]) + [SubagentErrorEvent(
                type=EventType.SUBAGENT_ERROR, subagent_run_id=subagent_run_id, message=message,
            )]
        # The subagent's output is the `task` tool's result. deepagents returns a
        # Command whose state update carries the ToolMessage; surface its content
        # as the finished subagent's `result` (mirrors RUN_FINISHED.result).
        # ``update`` is an untyped upstream payload: ``messages`` can be a list, a
        # single message, or a list of dict-shaped messages. The former ``msgs[0]``
        # raised TypeError on the single-message shape — inside the stream loop, so
        # the run-level ``except`` turned it into a failed run — and produced no
        # result at all for dict-shaped entries.
        result = None
        output = (event.get("data") or {}).get("output")
        update = getattr(output, "update", None)
        if isinstance(update, dict):
            msgs = _command_update_tool_messages(update.get("messages")) or update.get("messages")
            if isinstance(msgs, (list, tuple)):
                # Prefer a genuine ToolMessage (the same filtering the OnToolEnd
                # handler applies), since a Command update can also carry the
                # subagent's own AIMessage — whose text is not the task's result.
                # Fall back to scanning every entry only when none is a ToolMessage.
                tool_messages = [m for m in msgs if isinstance(m, ToolMessage)]
                for entry in tool_messages or msgs:
                    content = getattr(entry, "content", None)
                    if content is None and isinstance(entry, dict):
                        content = entry.get("content")
                    if content is not None:
                        result = content
                        break
            if result is None:
                logger.debug(
                    "no result content extractable from `task` output for %r "
                    "(messages=%r)",
                    subagent_run_id,
                    type(msgs).__name__,
                )
        # Close this lane's open step BEFORE the terminal, exactly as
        # drain_subagents does. This path removes the id from active_subagents,
        # so the drain at run end no longer sees it — without closing here the
        # subagent's last step stayed open forever and clients failed
        # RUN_FINISHED with "steps are still active".
        return close_lane_steps(active_run, [subagent_run_id]) + [SubagentFinishedEvent(
            type=EventType.SUBAGENT_FINISHED, subagent_run_id=subagent_run_id, result=result,
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
        ``subagent_run_id`` preserved, so both subagent text and tool-call
        attribution survive a snapshot apply. This is a no-op for runs without
        subagents (the tracking dicts stay empty), so normal runs and
        declared-subgraph runs keep an identical snapshot.

        TOOL_CALL_START / TOOL_CALL_RESULT are stamped with the active
        subagent_run_id upstream (see _dispatch_event); TOOL_CALL_ARGS is a
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

        def ensure_assistant_entry(message_id: str, subagent_run_id: str) -> dict:
            entry = sub_msgs.get(message_id)
            if entry is None:
                entry = sub_msgs[message_id] = {
                    "kind": "assistant",
                    "id": message_id,
                    "role": "assistant",
                    "content": "",
                    "subagent_run_id": subagent_run_id,
                    "tool_calls": {},
                }
            return entry

        def ensure_reasoning_entry(message_id: str, subagent_run_id: str) -> dict:
            entry = sub_msgs.get(message_id)
            if entry is None:
                entry = sub_msgs[message_id] = {
                    "kind": "reasoning",
                    "id": message_id,
                    "role": "reasoning",
                    "content": "",
                    "encrypted_value": None,
                    "subagent_run_id": subagent_run_id,
                }
            return entry

        def warn_owner_disagreement(entry: dict, subagent_run_id: Optional[str]) -> None:
            """A continuation naming a different owner than the entry it lands in.

            Accumulation continues under the ENTRY's owner (the opener is what the
            client already saw), but the disagreement means attribution drifted
            mid-message and is worth surfacing.
            """
            if subagent_run_id and entry.get("subagent_run_id") != subagent_run_id:
                logger.warning(
                    "continuation for message %r carries subagent_run_id=%r but the "
                    "entry is owned by %r; keeping the entry's owner",
                    entry.get("id"),
                    subagent_run_id,
                    entry.get("subagent_run_id"),
                )

        if etype == EventType.REASONING_MESSAGE_START and getattr(event, "subagent_run_id", None):
            # A subagent's reasoning lives only in its subgraph checkpoint, exactly like
            # its text and tool calls, so it is absent from the main-graph
            # MESSAGES_SNAPSHOT and the client's snapshot apply would drop the streamed
            # reasoning message. The parent's reasoning does survive (utils converts
            # LangChain reasoning content blocks into ReasoningMessages), so without this
            # a subagent's reasoning was the one kind that vanished at snapshot time.
            ensure_reasoning_entry(event.message_id, event.subagent_run_id)
        elif etype == EventType.REASONING_MESSAGE_CONTENT:
            entry = sub_msgs.get(event.message_id)
            sub_id = getattr(event, "subagent_run_id", None)
            if entry is None and sub_id:
                # The delta is attributed to a subagent but its opener was never
                # seen. Discarding it lost that reasoning from the snapshot, and a
                # snapshot missing the message looks authoritative to the client —
                # so create the entry rather than dropping the text.
                logger.warning(
                    "REASONING_MESSAGE_CONTENT for %r carries subagent_run_id=%r with "
                    "no recorded opener; creating the entry so the snapshot keeps it",
                    event.message_id, sub_id,
                )
                entry = ensure_reasoning_entry(event.message_id, sub_id)
            if entry is not None and entry.get("kind") == "reasoning":
                warn_owner_disagreement(entry, sub_id)
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
        elif etype == EventType.TEXT_MESSAGE_START and getattr(event, "subagent_run_id", None):
            entry = ensure_assistant_entry(event.message_id, event.subagent_run_id)
            entry["role"] = getattr(event, "role", "assistant") or "assistant"
        elif etype == EventType.TEXT_MESSAGE_CONTENT:
            entry = sub_msgs.get(event.message_id)
            sub_id = getattr(event, "subagent_run_id", None)
            if entry is None and sub_id:
                # Same reasoning as REASONING_MESSAGE_CONTENT above: a subagent-owned
                # delta whose opener was missed must not be silently dropped, or the
                # snapshot the client applies deletes the streamed text.
                logger.warning(
                    "TEXT_MESSAGE_CONTENT for %r carries subagent_run_id=%r with no "
                    "recorded opener; creating the entry so the snapshot keeps it",
                    event.message_id, sub_id,
                )
                entry = ensure_assistant_entry(event.message_id, sub_id)
            if entry is not None and entry.get("kind") == "assistant":
                warn_owner_disagreement(entry, sub_id)
                entry["content"] += event.delta or ""
        elif etype == EventType.TOOL_CALL_START and getattr(event, "subagent_run_id", None):
            message_id = event.parent_message_id or event.tool_call_id
            entry = ensure_assistant_entry(message_id, event.subagent_run_id)
            entry["tool_calls"][event.tool_call_id] = {
                "id": event.tool_call_id,
                "name": event.tool_call_name,
                "arguments": "",
            }
            tc_owner[event.tool_call_id] = message_id
        elif etype == EventType.TOOL_CALL_ARGS:
            message_id = tc_owner.get(event.tool_call_id)
            entry = sub_msgs.get(message_id) if message_id is not None else None
            sub_id = getattr(event, "subagent_run_id", None)
            if entry is None:
                if sub_id:
                    # Unlike the text/reasoning cases this cannot be reconstructed: the
                    # args event carries no parent_message_id and no tool name, so
                    # there is nothing to hang a synthetic entry on. Warn only — the
                    # arguments will be missing from the merged snapshot copy.
                    logger.warning(
                        "TOOL_CALL_ARGS for tool_call_id=%r carries subagent_run_id=%r "
                        "but no owning message was recorded; its arguments will be "
                        "absent from the merged snapshot",
                        event.tool_call_id, sub_id,
                    )
            elif entry.get("kind") == "assistant":
                warn_owner_disagreement(entry, sub_id)
                tool_call = entry["tool_calls"].get(event.tool_call_id)
                if tool_call is not None:
                    tool_call["arguments"] += event.delta or ""
        elif etype == EventType.TOOL_CALL_RESULT and getattr(event, "subagent_run_id", None):
            sub_msgs[event.message_id] = {
                "kind": "tool",
                "id": event.message_id,
                "content": event.content or "",
                "tool_call_id": event.tool_call_id,
                "subagent_run_id": event.subagent_run_id,
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
        # turn. The supervisor's own messages carry no subagent_run_id, so they stay
        # in the graph input. The subagent messages are stashed and re-emitted in
        # the MESSAGES_SNAPSHOT (see _merge_subagent_messages) so they persist in
        # the client's display across turns without ever entering graph state.
        graph_messages = []
        inbound_subagent_messages = []
        for m in input.messages or []:
            # `is not None`, not truthiness: an empty string is a valid opaque
            # subagent_run_id, and treating it as absent would put a subagent's internal
            # message into the supervisor's graph state — the pollution this split exists
            # to prevent.
            if getattr(m, "subagent_run_id", None) is not None:
                inbound_subagent_messages.append(m)
            else:
                graph_messages.append(m)
        self._inbound_subagent_messages = inbound_subagent_messages

        update: dict = {"forwarded_props": forwarded_props}
        if input.messages:
            update["messages"] = graph_messages

        async for event_str in self._handle_stream_events(input.model_copy(update=update)):
            # _dispatch_event returns None for events `subagent_visibility="hidden"`
            # withholds; this is the one place every emission funnels through.
            if event_str is not None:
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
            "current_subagent_run_id": None,
            "subagent_task_meta": {},
            "subagent_task_runs": {},
            "subagent_parents": {},
            "pending_task_calls": [],
            "seen_task_call_ids": set(),
            "task_tool_call_ids_by_ns": {},
            "subagent_segments": set(),
            "subagent_messages": {},
            # Read by the module-level subagent emitters so the gate cannot be bypassed
            # by a caller that forgets to check. See emit_subagent_events in __init__.
            "emit_subagent_events": self.emit_subagent_events,
            "subagent_tool_call_owner": {},
            # Subagent messages the client echoed back from prior turns, split
            # out of the graph input in run(). Re-emitted in the snapshot so
            # they persist in the display without entering graph state.
            "inbound_subagent_messages": getattr(self, "_inbound_subagent_messages", []) or [],
            # Per-model-call provider usage, appended during the run and folded
            # into the terminal event by _collect_run_usage. Seeded per run, so
            # one run's counts can never be attributed to the next.
            "usage": [],
            # Model-call run ids already counted, so the OnChatModelEnd fallback
            # does not re-count what the stream already reported. Per run for
            # the same reason as "usage" above.
            "usage_run_ids": set(),
        }
        self.active_run = INITIAL_ACTIVE_RUN
        # Seed the public-id registry from the run's INPUT (client-echoed
        # history), and translate minted root ids back to their raw form for
        # graph consumption. Derived from the input each run — no state is
        # retained between runs. Must run before prepare_stream so the graph
        # receives the reverse-translated messages.
        input = self._seed_public_ids_from_input(input)
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

                # Flush a deferred sync FIRST: the skip below records the debt,
                # and any later parent-side event pays it — round 5 showed real
                # parent-root events (empty or `parent:<uuid>` namespaces) never
                # satisfy is_subgraph_stream, so leaving current_subgraph
                # unadvanced alone never retried and the declared subgraph's
                # snapshot stayed missing until run end.
                # KEY PRESENCE is the debt marker, not the value: the owed
                # target is legitimately None for a transition back to the ROOT
                # graph (round 6: hotels_agent -> root stored None and the
                # is-not-None flush never fired, leaving the h1 snapshot
                # missing and current_subgraph stuck).
                if (
                    "deferred_subgraph_sync" in self.active_run
                    and not self._raw_payload_is_subagent_side(self.active_run, event)
                ):
                    self.current_subgraph = self.active_run.pop("deferred_subgraph_sync")
                    async for ev in self.get_state_and_messages_snapshots(config):
                        yield ev

                if is_subgraph_stream and current_subgraph != self.current_subgraph:
                    # Every time a subgraph changes, we need to update the state and messages snapshots.
                    # Under hidden, a transition TRIGGERED by a subagent-side event
                    # snapshots a partial subgraph fragment that would replace the
                    # parent's state on the client — that provenance is only visible
                    # here, where the triggering upstream event is in scope. Skipping
                    # DEFERS rather than swallows: current_subgraph stays unadvanced,
                    # so the next parent-side event re-triggers the sync (round 4: a
                    # declared subgraph's message otherwise appeared only in the
                    # final snapshot).
                    if not (
                        self.subagent_visibility == SUBAGENT_VISIBILITY_HIDDEN
                        and self._raw_payload_is_subagent_side(self.active_run, event)
                    ):
                        self.active_run.pop("deferred_subgraph_sync", None)
                        self.current_subgraph = current_subgraph
                        async for ev in self.get_state_and_messages_snapshots(config):
                            yield ev
                    else:
                        # Record the debt for the flush above — the next
                        # parent-side event of ANY shape pays it.
                        self.active_run["deferred_subgraph_sync"] = current_subgraph

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
                sub_events = reconcile_subagents(self.active_run, ns, lc_agent_name, self.subgraphs)
                # Lane bookkeeping still runs when the flag is off -- reconcile_subagents
                # maintains active_subagents / current_subagent_run_id, which other paths
                # read. Only the client-visible SUBAGENT_* events are withheld.
                if not self.emit_subagent_events:
                    sub_events = []
                for sub_ev in sub_events:
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
                    elif not isinstance(error_message, str):
                        # A dict / list / exception object passes the truthiness guard
                        # and then fails RunErrorEvent's own validation — INSIDE the
                        # error handler, so RUN_ERROR never reached the client at all
                        # and the run died with a pydantic ValidationError instead.
                        logger.warning(
                            "Upstream error event data.message is not a string "
                            "(type=%s); coercing with str()",
                            type(error_message).__name__,
                        )
                        error_message = str(error_message)
                    # Terminate every open subagent with SUBAGENT_ERROR (not just
                    # the current one — deepagents runs them concurrently) and
                    # clear them so the drain below can't also emit a
                    # contradictory SUBAGENT_FINISHED for a subagent that errored.
                    for sub_ev in error_open_subagents(self.active_run, error_message):
                        yield self._dispatch_event(sub_ev)
                    # Close the parent's own open step too, and BEFORE the
                    # terminal. error_open_subagents has already cleared
                    # current_subagent_run_id, so this closes the parent lane
                    # untagged. Without it the parent's step was still closed --
                    # but by the fallthrough below, i.e. after RUN_ERROR.
                    for ev in self.handle_node_change(None):
                        yield ev
                    yield self._dispatch_event(
                        RunErrorEvent(
                            type=EventType.RUN_ERROR,
                            message=error_message,
                            raw_event=event,
                            # Partial usage: a run that failed after one or more
                            # model calls completed still spent those tokens, so
                            # report them. Omitted (None) when the run died
                            # before any call reported usage.
                            usage=self._collect_run_usage(),
                        )
                    )
                    # RUN_ERROR is terminal: the clients reject EVERY event after
                    # it ("The run has already errored with 'RUN_ERROR'"). `break`
                    # only left the stream loop and then fell through to normal
                    # finalisation, which emitted STEP_FINISHED, STATE_SNAPSHOT,
                    # MESSAGES_SNAPSHOT and finally a SECOND terminal
                    # (RUN_FINISHED) -- so an errored run ended with two terminals
                    # and a conforming client aborted at the first trailing event.
                    # Return, so the error path emits nothing after its terminal.
                    return

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

                # No exit handling here on purpose. A `should_exit` flag used to be
                # accumulated at this point and never read; it is deleted rather than
                # wired up because CustomEventNames.Exit is advisory, not a stream
                # terminator. The full contract (and why terminating here would be
                # wrong) lives on the enum member in types.py. See PNI-386.

                # Compare against THIS EVENT'S LANE, not the flat node_name field.
                # node_name is a single slot last written by whichever lane
                # transitioned, so two lanes sitting on the same node name collided:
                # the second lane's transition looked like a no-op and its step never
                # opened, and a lane's close could be skipped because another lane had
                # already set the global to that name. handle_node_change is
                # idempotent per lane, so erring toward calling it is safe.
                event_lane = (
                    self.active_run.get("current_subagent_run_id")
                    if self.emit_subagent_events
                    else None
                )
                lane_nodes = self.active_run.setdefault("lane_nodes", {})
                if event_lane in lane_nodes:
                    lane_current = lane_nodes[event_lane]
                elif event_lane is None:
                    # Mirrors handle_node_change's seeding of the parent lane from the
                    # legacy flat field (several paths assign node_name directly).
                    lane_current = self.active_run.get("node_name")
                else:
                    lane_current = None
                if current_node_name and current_node_name != lane_current:
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
                    elif (
                        self.emit_subagent_events
                        and self.active_run.get("current_subagent_run_id")
                    ) or (
                        # Hidden: the same partial-fragment hazard, but the window
                        # can be momentarily closed between fan-out lanes when the
                        # exit event arrives — the triggering event's own namespace
                        # is the reliable provenance (round 4: all six fan-out
                        # reruns leaked one worker's partial state through this
                        # producer while the transition helper was guarded).
                        self.subagent_visibility == SUBAGENT_VISIBILITY_HIDDEN
                        and (
                            self.active_run.get("current_subagent_run_id")
                            or self._raw_payload_is_subagent_side(self.active_run, event)
                        )
                    ):
                        # Node-exit snapshots are suppressed while a subagent is
                        # active because a subgraph's state is a PARTIAL view of the
                        # run's document -- emitting it would overwrite the whole
                        # state with a fragment. This is a producer-side choice about
                        # this integration's state model, not a protocol rule:
                        # attributed state events are legal. The subagent's messages
                        # still reach the client via MESSAGES_SNAPSHOT.
                        # The lane survives a close (see reconcile_subagents), so a
                        # trailing event from a finished subagent stays suppressed.
                        #
                        # Gated on the flag: reconcile_subagents sets
                        # current_subagent_run_id unconditionally (other paths read the
                        # bookkeeping), so without the gate this withheld snapshots the
                        # pre-subagent integration emitted during a delegation -- a
                        # silent state regression for a caller that never opted in.
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

            # Reconcile the mid-stream interrupt candidates against the
            # authoritative final state. The on_tool_error path records
            # candidate interrupt ownership when a GraphInterrupt propagates
            # through a `task` tool, but only state.tasks decides whether the
            # run actually suspended — a candidate whose interrupt is absent
            # from the final tasks (the parent handled it and continued) must
            # not attribute anything or mark anyone suspended. Confirmed
            # candidates drive both the interrupt-tail attribution and the
            # suspended SUBAGENT_FINISHED outcomes below; ancestors of a
            # suspended lane are suspended too, owning no interrupts of their
            # own. Flag-gated: interrupt_subagents is only ever recorded with
            # subagent events on.
            if self.emit_subagent_events and self.active_run.get("interrupt_subagents"):
                final_interrupt_ids = {
                    getattr(interrupt, "id", None) for interrupt in interrupts
                }
                confirmed = {
                    interrupt_id: lane
                    for interrupt_id, lane in self.active_run["interrupt_subagents"].items()
                    if interrupt_id in final_interrupt_ids
                }
                self.active_run["interrupt_subagents"] = confirmed
                # Map raw -> AG-UI interrupts exactly once, with provenance (see
                # _prepare_interrupt_tail); _emit_interrupt_finish reuses this.
                # The suspended outcome must name the EMITTED interrupt ids —
                # the ones a client can answer — not raw ids, which differ as
                # soon as a fan-out override is in play.
                prepared_tail = self._prepare_interrupt_tail(interrupts)
                self.active_run["prepared_interrupt_tail"] = prepared_tail
                suspended_lanes: dict = {}
                for raw, mapped in prepared_tail:
                    lane = confirmed.get(getattr(raw, "id", None))
                    if lane:
                        suspended_lanes.setdefault(lane, []).extend(
                            agui_interrupt.id for agui_interrupt in mapped
                        )
                parents = self.active_run.get("subagent_parents") or {}
                for lane in list(suspended_lanes):
                    ancestor = parents.get(lane)
                    seen: set = set()
                    while ancestor and ancestor not in seen:
                        seen.add(ancestor)
                        suspended_lanes.setdefault(ancestor, [])
                        ancestor = parents.get(ancestor)
                self.active_run["suspended_subagent_interrupts"] = suspended_lanes

            # End-of-run events (node-change STEP_*, final root STATE_SNAPSHOT)
            # are supervisor-level. If the stream ended while a subagent was
            # still open (e.g. its task OnToolEnd never fired), current_subagent_run_id
            # would linger and mis-stamp these as the subagent's. Clear it before
            # emitting them; drain_subagents below still finishes open subagents.
            self.active_run["current_subagent_run_id"] = None

            # Finish any open subagents FIRST — before the parent's own
            # node-change / final step close below. Two reasons:
            # 1. The AG-UI client forbids RUN_FINISHED while a subagent is still
            #    active, and this is required even on the interrupt path: an
            #    interrupt surfaces the pause by ENDING the run with
            #    RUN_FINISHED. A subagent suspended at a HITL interrupt is
            #    finished here; on resume it re-emits SUBAGENT_STARTED (the run
            #    replays) and finishes again.
            # 2. Containment: the child's step close and terminal must land
            #    inside the parent wrapper step that spawned it. Draining after
            #    handle_node_change closed the parent's step BEFORE the child's,
            #    inverting the wrapper semantics on exactly the fallback path
            #    this drain exists for.
            for sub_ev in drain_subagents(self.active_run):
                yield self._dispatch_event(sub_ev)

            if self.active_run.get("node_name") != node_name:
                for ev in self.handle_node_change(node_name):
                    yield ev

            async for ev in self.get_state_and_messages_snapshots(config):
                yield ev

            for ev in self.handle_node_change(None):
                yield ev

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
                open_ids = list(self.active_run.get("active_subagents", {}).keys())
                if open_ids:
                    logger.exception(
                        "run failed with subagents still open: %r", open_ids,
                    )
                # ``str(exc)`` is "" for a bare exception (``raise SomeError()``),
                # which would report a subagent failure with no message at all.
                for sub_ev in error_open_subagents(self.active_run, str(exc) or repr(exc)):
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
            # A fresh request on an interrupted thread starts with an empty
            # interrupt-ownership registry (per-run state, by design), so the
            # re-emitted interrupt would lose its subagent attribution. Derive
            # it from the checkpoint task that holds the interrupt: a
            # deepagents delegation's task is the ToolNode dispatch whose
            # subagent lane is exactly "<task.name>:<task.id>" — the OUTERMOST
            # delegation boundary the interrupt surfaced through, which is a
            # factual attribution even when the interrupt originated in a
            # deeper nested subagent.
            #
            # Attribution is never invented, so the task name alone is NOT
            # delegation evidence: a root ToolNode whose ordinary tool calls
            # interrupt() is also named "tools" and no subagent exists. Nor is
            # ``task.state`` — empirically (LangGraph 0.6-1.2), it is None for
            # a deepagents delegation (the subgraph runs INSIDE the tool
            # function) and populated for a declared subgraph NODE, the exact
            # opposite of delegation. The durable, checkpoint-persisted
            # evidence is SEMANTIC: the delegation's spawning `task` tool call
            # is still pending in the checkpoint messages (an AIMessage
            # tool_call with name "task" and no matching ToolMessage) while
            # the run sits interrupted. Only when every pending call is a
            # `task` call are the interrupted `tools` tasks delegations; any
            # pending non-task call makes the tasks ambiguous, and omission is
            # safer than a guessed owner. Flag-gated.
            if self.emit_subagent_events and _pending_tool_calls_are_all_task(
                (agent_state.values or {}).get("messages")
            ):
                owners = self.active_run.setdefault("interrupt_subagents", {})
                for task in agent_state.tasks or ():
                    if getattr(task, "name", None) != "tools":
                        continue
                    task_id = getattr(task, "id", None)
                    if not task_id:
                        continue
                    for task_interrupt in getattr(task, "interrupts", None) or ():
                        interrupt_id = getattr(task_interrupt, "id", None)
                        if interrupt_id:
                            owners.setdefault(interrupt_id, f"tools:{task_id}")
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

        Gated on emit_subagent_events like every other subagent-aware path:
        with the flag off, everything maps to the root lane, so the streaming
        state behaves exactly as it did before subagent support — including
        concurrent subagents interleaving into one slot. Per-lane slots with
        the flag off would be a (benign) stream-shape change, and the flag's
        contract is byte-identity, not improvement.
        """
        if not self.emit_subagent_events:
            return _ROOT_LANE
        active_run = getattr(self, "active_run", None)
        return (active_run.get("current_subagent_run_id") if active_run else None) or _ROOT_LANE

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

        Attribution and the suspended-outcome correlation call this PER RAW
        interrupt (a single-element list), so a fan-out override must not
        depend on seeing the whole batch at once — everything an override
        needs must come from the one interrupt it is given.
        """
        return lg_interrupts_to_agui(lg_interrupts)

    def _prepare_interrupt_tail(self, lg_interrupts) -> list:
        """Map raw interrupts to AG-UI interrupts WITH provenance preserved.

        Returns ``[(raw, [mapped, ...]), ...]``, mapping each raw interrupt
        separately so a fan-out override (one raw -> N AG-UI interrupts) keeps
        its raw's identity: every mapped interrupt inherits the raw's recorded
        subagent owner, and the suspended-outcome correlation can name the
        EMITTED (mapped) interrupt ids — the ids a client can actually answer
        — rather than raw ids that never reach the wire. A single zip over two
        flat lists crossed owners as soon as one raw fanned out, and the two
        attribution channels disagreed with each other.

        Mapping happens exactly once per run-tail (the reconciliation stores
        the result and _emit_interrupt_finish reuses it), so an override with
        non-deterministic mapped ids cannot desync the suspended outcome from
        the emitted interrupts.
        """
        owners = (
            ((self.active_run or {}).get("interrupt_subagents") or {})
            if self.emit_subagent_events
            else {}
        )
        prepared = []
        for raw in lg_interrupts:
            mapped = self._interrupts_to_agui([raw])
            owner = owners.get(getattr(raw, "id", None))
            if owner:
                for agui_interrupt in mapped:
                    if getattr(agui_interrupt, "subagent_run_id", None) is None:
                        agui_interrupt.subagent_run_id = owner
            prepared.append((raw, mapped))
        return prepared

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
        # An interrupt raised INSIDE a subagent is that subagent's request:
        # the on_tool_error path recorded its id -> subagentRunId (flag-gated,
        # confirmed against final state in _handle_stream_events), so BOTH
        # channels carry the attribution — the legacy on_interrupt CUSTOM
        # event and the structured Interrupt.subagentRunId — and a client can
        # render the approval inside the subagent's group on either.
        # Attributing an already-finished subagent is protocol-legal (the
        # drain finishes the suspended subagent, outcome "suspended", before
        # this tail). Root-raised interrupts have no recording and stay
        # untagged.
        #
        # Raw -> mapped provenance comes from _prepare_interrupt_tail. The
        # normal run path prepared (and correlated the suspended outcomes
        # against) this exact tail during reconciliation; reuse it so mapping
        # happens exactly once. The short-circuit replay path prepares fresh.
        stored_tail = (self.active_run or {}).get("prepared_interrupt_tail")
        if stored_tail is not None and [
            getattr(raw, "id", None) for raw, _ in stored_tail
        ] == [getattr(raw, "id", None) for raw in lg_interrupts]:
            prepared_tail = stored_tail
        else:
            prepared_tail = self._prepare_interrupt_tail(lg_interrupts)
        agui_interrupts = [
            agui_interrupt for _, mapped in prepared_tail for agui_interrupt in mapped
        ]
        interrupt_owners = (
            ((self.active_run or {}).get("interrupt_subagents") or {})
            if self.emit_subagent_events
            else {}
        )
        events: List[ProcessedEvents] = []
        if self.enable_legacy_on_interrupt_event:
            for raw, _mapped in prepared_tail:
                events.append(
                    CustomEvent(
                        type=EventType.CUSTOM,
                        name=LangGraphEventTypes.OnInterrupt.value,
                        value=dump_json_safe(raw.value),
                        raw_event=raw,
                        subagent_run_id=interrupt_owners.get(getattr(raw, "id", None)),
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
                # An interrupted run is a finished run for usage purposes: the
                # model calls it already made were paid for and are reported.
                # The short-circuit replay path in prepare_stream reaches this
                # with no model calls at all, where _collect_run_usage returns
                # None and the field is simply omitted.
                usage=self._collect_run_usage(),
            )
        )
        return events

    def _record_usage(self, event: Any, usage_metadata: Any, *, streamed: bool) -> None:
        """Accumulate one usage entry per model call.

        Usage reaches us on two channels, and which one a call uses is the
        provider's choice, not ours:

        * ``OnChatModelStream`` — the final streamed chunk, alongside
          ``finish_reason``. This is the streaming case.
        * ``OnChatModelEnd`` — the aggregated output message. This is the ONLY
          channel when the model does not stream at all (streaming disabled, or
          a tool call answered without streaming): no ``OnChatModelStream``
          event is emitted for such a call, so a stream-only producer reports
          nothing for it. Verified against this package's locked dependencies:
          a non-streaming model reporting 3/2/5 produced no stream event and a
          model-end output carrying the counts.

        A streaming provider reports the SAME usage on BOTH channels under the
        same run id, so the model-end read is a fallback, not an addition:
        ``usage_run_ids`` records which calls the stream already covered and the
        fallback skips those. The streaming path never consults the set, only
        adds to it — two streamed chunks that each carry usage for one call are
        still summed, matching the TypeScript producer.

        Kept per-call and folded together at the terminal event by
        ``_collect_run_usage``. The mapper is the shared SDK one, so a malformed
        provider count (string, ``None``, ``NaN``, negative, fractional,
        wider-than-int64) is dropped rather than forwarded: the alternative is a
        ValidationError raised while BUILDING the terminal event, which would
        cost the user the whole run over a token count.

        Nothing usable adds nothing at all — the field is then omitted from the
        terminal event rather than reported as zeros, so "the provider reported
        no usage" stays distinct from "the provider reported zero".
        """
        if not usage_metadata:
            return
        is_dict = isinstance(event, dict)
        run_id = event.get("run_id") if is_dict else None
        covered = self.active_run.setdefault("usage_run_ids", set())
        if not streamed and run_id in covered:
            # The stream already reported this exact call. Counting the
            # aggregated model-end copy as well would double every streamed
            # call's tokens.
            return
        metadata = (event.get("metadata") or {}) if is_dict else {}
        entry = token_usage_from_langchain_metadata(
            usage_metadata,
            # LangChain's standard run metadata. Absent for some providers, in
            # which case the entry carries counts with no labels — still usable,
            # and aggregation groups all unlabelled calls together.
            provider=metadata.get("ls_provider"),
            model=metadata.get("ls_model_name"),
        )
        if entry is not None:
            self.active_run.setdefault("usage", []).append(entry)
            covered.add(run_id)

    def _collect_run_usage(self) -> Optional[List[TokenUsage]]:
        """Aggregate this run's accumulated per-call usage for a terminal event.

        Returns ``None`` (an omitted field) when no provider usage was
        reported, so consumers read missing usage as "not measured" rather than
        as zero.
        """
        aggregated = aggregate_token_usage((self.active_run or {}).get("usage") or [])
        return aggregated or None

    def _emit_success_finish(
        self, *, thread_id: str, run_id: str
    ) -> RunFinishedEvent:
        """Tail event for a non-interrupt run."""
        return RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=thread_id,
            run_id=run_id,
            usage=self._collect_run_usage(),
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

            # Capture provider-reported token usage. LangChain attaches
            # `usage_metadata` to the FINAL streamed chunk — the one that also
            # carries `finish_reason` — so this must run BEFORE the
            # finish-reason early return below or the usage of every model call
            # would be dropped. OnChatModelEnd covers the non-streaming case.
            self._record_usage(
                event, _chunk_get(chunk_raw, "usage_metadata", None), streamed=True
            )

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
                # The slot stores the PUBLIC id; compare like with like or a
                # minted id would read as a new call for its own chunks.
                and self._resolve_public_tool_call_id(tool_call_data["id"])
                != current_stream["tool_call_id"]
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
                    # Deduped per (lane, raw id), not per raw id: two lanes can
                    # fan out `task` calls sharing a raw id, and a run-global
                    # raw key swallowed the second lane's capture — its spawned
                    # subagent then joined against the FIRST lane's record and
                    # SUBAGENT_STARTED referenced an unrelated call.
                    _lane = self._current_lane()
                    _key = (_lane, _tcc["id"])
                    if _key not in seen_tasks:
                        seen_tasks.add(_key)
                        # tool_call_id stays RAW — it is matched against the
                        # ToolNode dispatch capture (graph-side raw ids). The
                        # public pair is what SUBAGENT_STARTED must reference,
                        # since those are the ids the client saw streamed.
                        self.active_run.setdefault("pending_task_calls", []).append({
                            "lane": _lane,
                            "tool_call_id": _tcc["id"],
                            "public_tool_call_id": self._resolve_public_tool_call_id(_tcc["id"], _lane),
                            "parent_message_id": (
                                self._resolve_public_message_id(chunk_id, _lane) if chunk_id else chunk_id
                            ),
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
                    # Public, not raw: another lane may already have claimed
                    # this upstream chunk id (see _resolve_public_id).
                    text_stream_id = self._resolve_public_message_id(chunk_id)
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
                # Public ids, not raw: another lane may already have claimed
                # this call id or chunk id (see _resolve_public_id). The
                # in-progress slot stores the PUBLIC pair so ARGS/END
                # continuations and OnChatModelEnd emit consistently.
                public_call_id = self._resolve_public_tool_call_id(tool_call_data["id"])
                public_parent_id = (
                    self._resolve_public_message_id(chunk_id) if chunk_id else chunk_id
                )
                # Record this tool_call_id as "already streamed" regardless of
                # ``should_emit_tool_calls``. OnToolEnd uses this set to decide
                # whether to re-emit Start/Args/End for the same id. Adding the
                # id even when emission is suppressed preserves the prior
                # behaviour where ``has_function_streaming=True`` blocked the
                # OnToolEnd re-emit for opted-out tool calls. Keyed by PUBLIC
                # id: the raw id can be shared across lanes, and one lane's
                # result discarding a shared raw key made the other lane's
                # result spuriously re-emit its whole call.
                self.active_run["streamed_tool_call_ids"].add(self._streamed_call_key(public_call_id))
                if should_emit_tool_calls:
                    yield self._dispatch_event(
                        ToolCallStartEvent(
                            type=EventType.TOOL_CALL_START,
                            tool_call_id=public_call_id,
                            tool_call_name=tool_call_data["name"],
                            parent_message_id=public_parent_id,
                            raw_event=event,
                        )
                    )
                    self.set_message_in_progress(
                        self.active_run["id"],
                        MessageInProgress(id=public_parent_id, tool_call_id=public_call_id, tool_call_name=tool_call_data["name"])
                    )
                    # Some providers (e.g. GLM) emit name + complete args in the
                    # same first chunk instead of streaming arg deltas later.
                    # Without this, TOOL_CALL_START is followed immediately by
                    # TOOL_CALL_END and TOOL_CALL_ARGS is never produced.
                    args_delta = tool_call_data.get("args")
                    if args_delta:
                        yield self._dispatch_event(
                            ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=tool_call_data["id"],
                                delta=dump_json_safe(args_delta),
                                raw_event=event,
                            )
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
            # The non-streaming channel for token usage, and the ONLY one for a
            # model call that never streamed — such a call emits no
            # OnChatModelStream event at all, so the streamed capture above
            # never sees it. `data.output` is the aggregated message
            # (AIMessage when the model did not stream, AIMessageChunk when it
            # did); dual-path access because some upstream paths deliver it as
            # a plain dict. Deduped by run id inside _record_usage, since a
            # streaming provider reports the same counts on both channels.
            output_message = (event.get("data") or {}).get("output")
            self._record_usage(
                event,
                (
                    output_message.get("usage_metadata")
                    if isinstance(output_message, dict)
                    else getattr(output_message, "usage_metadata", None)
                ),
                streamed=False,
            )

            if self.get_message_in_progress(self.active_run["id"]) and self.get_message_in_progress(self.active_run["id"]).get("tool_call_id"):
                resolved = self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=self.get_message_in_progress(self.active_run["id"])["tool_call_id"], raw_event=event)
                )
                # Clear unconditionally: a None here means subagent_visibility="hidden"
                # withheld the close from the wire, not that the model kept streaming.
                # Leaving the slot open made the PARENT's next chunks read as a
                # continuation of the suppressed entity — and vanish with it.
                self.clear_message_in_progress(self.active_run["id"])
                yield resolved
            elif self.get_message_in_progress(self.active_run["id"]) and self.get_message_in_progress(self.active_run["id"]).get("id"):
                resolved = self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=self.get_message_in_progress(self.active_run["id"])["id"], raw_event=event)
                )
                # Same rule as the tool-call branch above: the slot lifecycle is
                # bookkeeping, not wire output — it must not depend on suppression.
                self.clear_message_in_progress(self.active_run["id"])
                yield resolved

        elif event_type == LangGraphEventTypes.OnCustomEvent:
            if event["name"] == CustomEventNames.ManuallyEmitMessage:
                # Public, not raw: manual ids are caller-chosen, and a subagent's
                # graph code can emit the same id as another lane. Same-lane
                # single use keeps the caller's id verbatim (first claim).
                manual_message_id = self._resolve_public_message_id(event["data"]["message_id"])
                yield self._dispatch_event(
                    TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, role="assistant", message_id=manual_message_id, raw_event=event)
                )
                yield self._dispatch_event(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=manual_message_id,
                        delta=event["data"]["message"],
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=manual_message_id, raw_event=event)
                )

            elif event["name"] == CustomEventNames.ManuallyEmitToolCall:
                # Same resolution as streamed tool calls: the call id in its own
                # kind namespace, the parent message id in the message one.
                manual_call_id = self._resolve_public_tool_call_id(event["data"]["id"])
                manual_parent_id = self._resolve_public_message_id(event["data"]["id"])
                yield self._dispatch_event(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=manual_call_id,
                        tool_call_name=event["data"]["name"],
                        parent_message_id=manual_parent_id,
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=manual_call_id,
                        delta=event["data"]["args"] if isinstance(event["data"]["args"], str) else json.dumps(
                            event["data"]["args"]),
                        raw_event=event
                    )
                )
                yield self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=manual_call_id, raw_event=event)
                )

            elif event["name"] == CustomEventNames.ManuallyEmitState:
                # No subagent guard here, deliberately. An audit revision dropped
                # this payload when a subagent was active, on the grounds that only
                # the parent owns state. That was an invented rule -- the protocol
                # lists STATE_* as attributable -- and dropping silently discarded
                # a state write the user had explicitly asked for.
                #
                # `manually_emit_state` is an explicit request to set the run's
                # state, and `manually_emitted_state` is run-global by design. A
                # subagent making that request means it, so it is recorded and
                # emitted like any other. The dispatch chokepoint stamps
                # subagent_run_id on the snapshot, which is provenance: it records
                # who wrote the state, while the state itself stays run-scoped.
                self.active_run["manually_emitted_state"] = event["data"]
                yield self._dispatch_event(
                    StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=self.get_state_snapshot(self.active_run["manually_emitted_state"]), raw_event=event)
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
                    messages = _command_update_tool_messages(update.get('messages', []) or [])
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
                    # Same lane as the streamed call, so the resolve returns the
                    # public id its START carried (or the raw id when this call
                    # was never streamed and is being emitted here first).
                    public_call_id = self._resolve_public_tool_call_id(tool_msg.tool_call_id)
                    already_streamed = self._streamed_call_key(public_call_id) in self.active_run["streamed_tool_call_ids"]
                    if not already_streamed:
                        yield self._dispatch_event(
                            ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                tool_call_id=public_call_id,
                                tool_call_name=tool_msg.name or event.get("name", ""),
                                parent_message_id=self._resolve_public_message_id(
                                    str(tool_msg.id or tool_msg.tool_call_id)
                                ),
                                raw_event=event,
                            )
                        )
                        yield self._dispatch_event(
                            ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=public_call_id,
                                delta=dump_json_safe(event["data"].get("input", {})),
                                raw_event=event
                            )
                        )
                        yield self._dispatch_event(
                            ToolCallEndEvent(
                                type=EventType.TOOL_CALL_END,
                                tool_call_id=public_call_id,
                                raw_event=event
                            )
                        )
                    self.active_run["streamed_tool_call_ids"].discard(self._streamed_call_key(public_call_id))

                    yield self._dispatch_event(
                        ToolCallResultEvent(
                            type=EventType.TOOL_CALL_RESULT,
                            tool_call_id=public_call_id,
                            # Match ToolMessage.id (or tool_call_id) so MESSAGES_SNAPSHOT merge works.
                            # Resolved through the same lane map as the START above.
                            message_id=self._resolve_public_message_id(
                                str(tool_msg.id or tool_msg.tool_call_id)
                            ),
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

            # Same lane as the streamed call, so the resolve returns the public
            # id its START carried (or the raw id when this call was never
            # streamed and is being emitted here first).
            public_call_id = self._resolve_public_tool_call_id(tool_call_output.tool_call_id)
            already_streamed = self._streamed_call_key(public_call_id) in self.active_run["streamed_tool_call_ids"]
            if not already_streamed:
                yield self._dispatch_event(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=public_call_id,
                        tool_call_name=tool_call_output.name or event.get("name", ""),
                        parent_message_id=self._resolve_public_message_id(
                            str(tool_call_output.id or tool_call_output.tool_call_id)
                        ),
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=public_call_id,
                        delta=dump_json_safe(event["data"]["input"]),
                        raw_event=event
                    )
                )
                yield self._dispatch_event(
                    ToolCallEndEvent(
                        type=EventType.TOOL_CALL_END,
                        tool_call_id=public_call_id,
                        raw_event=event
                    )
                )
            self.active_run["streamed_tool_call_ids"].discard(self._streamed_call_key(public_call_id))

            yield self._dispatch_event(
                ToolCallResultEvent(
                    type=EventType.TOOL_CALL_RESULT,
                    tool_call_id=public_call_id,
                    # Match ToolMessage.id (or tool_call_id) so MESSAGES_SNAPSHOT merge works.
                    # Resolved through the same lane map as the START above.
                    message_id=self._resolve_public_message_id(
                        str(tool_call_output.id or tool_call_output.tool_call_id)
                    ),
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
            raw_reasoning_id = (
                reasoning_data.get("id")
                or (self.active_run.get("pending_reasoning_ids") or {}).pop(lane, None)
                or str(uuid.uuid4())
            )
            # Public, not raw: reasoning ids are run-global on the client (its
            # owner map keys reasoning messages by id), so two lanes presenting
            # the same provider id must not collide — same rule as text and
            # tool-call ids, in reasoning's own kind namespace. The snapshot
            # converter translates state reasoning blocks through the same map
            # (see _translate_snapshot_ids), so streamed and snapshot copies
            # still reconcile by id.
            message_id = self._resolve_public_id(raw_reasoning_id, "reasoning", lane)
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
            pins[lane] = self._resolve_public_message_id(fallback_id, lane)
            pin_nodes[lane] = node
        return pins[lane]

    def _resolve_public_id(self, upstream_id: str, kind: str, lane: Optional[str] = None) -> str:
        """Map an upstream id to a run-globally unique public id, per lane.

        Public ids are run-global: the clients reject a second
        TEXT_MESSAGE_START / TOOL_CALL_START for an in-progress id, and the
        snapshot accumulator is keyed by public message id, so two lanes
        presenting the same upstream id crossed their entities into one entry.
        Distinct LangChain runs mint distinct ``lc_run--*`` ids and providers
        mint per-response call ids, so a genuine collision needs upstream to
        repeat itself — nothing guarantees it never does.

        Resolution is a per-(lane, kind) mapping so every reference to the
        same upstream id from the same lane yields the same public id — a
        lane's text START, its tool call's parent_message_id, and its
        on_tool_end result all land on one assistant message, exactly as with
        raw ids. The first lane to present an id keeps it verbatim
        (single-lane streams stay byte-identical, and the raw id is what the
        graph state's own message carries, which the snapshot merge matches
        on); only colliders get a minted id, namespaced by lane so it is
        stable and self-describing.

        Renaming happens at the emission boundary only — graph state keeps the
        raw ids, and every internal correlation (ToolNode dispatch matching,
        ``task_tool_call_ids_by_ns``, on_tool_end lookup) stays raw-keyed.
        Both halves of a public pair (the assistant tool_call and its
        TOOL_CALL_RESULT) resolve through the same lane map, so the client's
        view stays self-consistent.

        Flag-off is untouched by construction: every event maps to the root
        lane and the registry is only maintained when subagent events are on,
        so pre-subagent streams keep their exact ids.
        """
        if not self.emit_subagent_events:
            return upstream_id
        lane = lane if lane is not None else self._current_lane()
        maps = self.active_run.setdefault("public_id_maps", {}).setdefault(kind, {})
        lane_map = maps.setdefault(lane, {})
        public_id = lane_map.get(upstream_id)
        if public_id is not None:
            return public_id
        used = self.active_run.setdefault("used_public_ids", {}).setdefault(kind, set())
        # A verbatim upstream id that LOOKS minted must never be emitted
        # as-is. Two suffixes are load-bearing on the next turn's input:
        # '::__root__' is reverse-translated for graph consumption, and the
        # claiming lane's own '::<lane>' is stripped by tagged seeding to
        # recover the raw form a HITL resume replays. A genuine upstream id
        # matching either would be stripped to a DIFFERENT id — duplicating
        # against the checkpoint (root) or forking the resumed call (lane).
        # Minting keeps both suffixes' exclusivity real: the mint gains a
        # second suffix layer, which the stripping unwinds one layer per turn,
        # converging. An id ending in ANOTHER lane's suffix is never stripped
        # by anything, so no check is needed for it.
        upstream_looks_minted = (
            _minted_root_suffix_re().search(upstream_id) is not None
            or _lane_mint_suffix_re(lane).search(upstream_id) is not None
        )
        public_id = upstream_id
        suffix = 0
        while public_id in used or (suffix == 0 and upstream_looks_minted):
            suffix += 1
            public_id = (
                f"{upstream_id}::{lane}"
                if suffix == 1
                else f"{upstream_id}::{lane}::{suffix}"
            )
        used.add(public_id)
        lane_map[upstream_id] = public_id
        return public_id

    def _seed_public_ids_from_input(self, input: RunAgentInput) -> RunAgentInput:
        """Seed the public-id registry from client-echoed history, translating
        minted ROOT ids back to raw for graph consumption.

        The registry is per-run, so without seeding it knows nothing about ids
        the client already displays: (a) a lane claiming a raw id equal to a
        HISTORY message's id kept it verbatim, and the snapshot merge then
        deduped that lane's entry against the history message — content loss;
        (b) a root id minted in a PRIOR run ('{raw}::__root__') came back from
        the client as a new-looking id, and the graph's message merge
        duplicated the message against its checkpoint copy, which still holds
        the raw id.

        Everything here derives from the run's input — no state persists
        between runs. Untagged (root-owned) history seeds the root lane's
        maps; a minted root id is recognized by its '::__root__' suffix
        (producer-chosen — only the mint ever writes it) and is rewritten to
        its raw form for the graph, with the raw->public mapping recorded so
        this run's stream and snapshot keep presenting the id the client
        knows. Subagent-tagged history never enters the graph (see the split
        in run()); its ids seed their own lanes and the used set, so a new
        lane colliding with them mints. Both raw and public forms are
        reserved. Flag-off is a no-op, preserving byte identity.
        """
        if not self.emit_subagent_events:
            return input
        minted_re = _minted_root_suffix_re()

        def raw_form(public_id: str) -> str:
            match = minted_re.search(public_id)
            return public_id[: match.start()] if match else public_id

        def reserve(kind: str, lane: str, raw_id: str, public_id: str) -> None:
            maps = self.active_run.setdefault("public_id_maps", {}).setdefault(kind, {})
            maps.setdefault(lane, {}).setdefault(raw_id, public_id)
            used = self.active_run.setdefault("used_public_ids", {}).setdefault(kind, set())
            used.add(public_id)
            used.add(raw_id)

        def kind_for(message) -> str:
            return "reasoning" if getattr(message, "role", None) == "reasoning" else "message"

        # Subagent-tagged history (split out of the graph input in run()).
        # Recover the RAW form from the lane's own mint suffix: a HITL resume
        # replays the SAME lane (checkpoint namespaces persist), and its
        # upstream events carry the raw id — recording only public->public left
        # both forms reserved but unmapped, so the resumed lane minted a THIRD
        # id and the replayed call/result no longer matched its own history.
        for message in getattr(self, "_inbound_subagent_messages", None) or []:
            lane = getattr(message, "subagent_run_id", None) or _ROOT_LANE
            lane_suffix_re = _lane_mint_suffix_re(lane)

            def lane_raw_form(public_id: str) -> str:
                match = lane_suffix_re.search(public_id)
                return public_id[: match.start()] if match else public_id

            message_id = getattr(message, "id", None)
            if isinstance(message_id, str):
                reserve(kind_for(message), lane, lane_raw_form(message_id), message_id)
            for tool_call in getattr(message, "tool_calls", None) or []:
                if isinstance(getattr(tool_call, "id", None), str):
                    reserve("tool_call", lane, lane_raw_form(tool_call.id), tool_call.id)

        # Root-owned history: seed and reverse-translate minted ids.
        rewritten = []
        changed_any = False
        for message in input.messages or []:
            if getattr(message, "subagent_run_id", None) is not None:
                # Tagged messages reaching here means the caller bypassed the
                # run() split; seed their own lane (recovering the raw form,
                # as above) and leave them alone.
                lane = getattr(message, "subagent_run_id")
                bypass_suffix_re = _lane_mint_suffix_re(lane)
                if isinstance(getattr(message, "id", None), str):
                    match = bypass_suffix_re.search(message.id)
                    raw_bypass = message.id[: match.start()] if match else message.id
                    reserve(kind_for(message), lane, raw_bypass, message.id)
                rewritten.append(message)
                continue
            update: dict = {}
            message_id = getattr(message, "id", None)
            if isinstance(message_id, str):
                raw_id = raw_form(message_id)
                reserve(kind_for(message), _ROOT_LANE, raw_id, message_id)
                if raw_id != message_id:
                    update["id"] = raw_id
            tool_calls = getattr(message, "tool_calls", None)
            if tool_calls:
                new_calls = []
                calls_changed = False
                for tool_call in tool_calls:
                    call_id = getattr(tool_call, "id", None)
                    if isinstance(call_id, str):
                        raw_call = raw_form(call_id)
                        reserve("tool_call", _ROOT_LANE, raw_call, call_id)
                        if raw_call != call_id:
                            new_calls.append(tool_call.model_copy(update={"id": raw_call}))
                            calls_changed = True
                            continue
                    new_calls.append(tool_call)
                if calls_changed:
                    update["tool_calls"] = new_calls
            call_ref = getattr(message, "tool_call_id", None)
            if isinstance(call_ref, str):
                raw_ref = raw_form(call_ref)
                reserve("tool_call", _ROOT_LANE, raw_ref, call_ref)
                if raw_ref != call_ref:
                    update["tool_call_id"] = raw_ref
            if update:
                changed_any = True
                rewritten.append(message.model_copy(update=update))
            else:
                rewritten.append(message)
        if changed_any:
            return input.model_copy(update={"messages": rewritten})
        return input

    def _resolve_public_message_id(self, upstream_id: str, lane: Optional[str] = None) -> str:
        return self._resolve_public_id(upstream_id, "message", lane)

    def _resolve_public_tool_call_id(self, upstream_id: str, lane: Optional[str] = None) -> str:
        return self._resolve_public_id(upstream_id, "tool_call", lane)

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

        # Steps are tracked PER LANE (the parent is lane None; each subagent is its own).
        # With a single current-node slot a subagent's first node transition closed the
        # PARENT's step -- so the `tools` step wrapping a delegation ended the moment the
        # subagent started work, and reopened when it returned, putting a parent-owned
        # STEP_STARTED inside the subagent's run. A design partner reported exactly that
        # from a real deepagents run. The parent's step now stays open across the whole
        # delegation, which the clients accept since steps are keyed by (owner, name).
        # Lane None when the flag is off: steps then behave exactly as they did before
        # subagent support, a single flat sequence. Keeping per-lane tracking while
        # emitting no tags would put two untagged steps of the same name open at once,
        # which the clients reject (they key untagged steps by name).
        lane = (
            self.active_run.get("current_subagent_run_id")
            if self.emit_subagent_events
            else None
        )
        lane_nodes = self.active_run.setdefault("lane_nodes", {})
        # Seed the PARENT lane from the legacy flat field on first use. Several paths
        # assign active_run["node_name"] directly -- the resume path and the
        # interrupt/writes handling -- so a step can already be open for the parent
        # without lane_nodes knowing. Without this the parent's open step is invisible
        # here and never gets closed.
        if lane is None and None not in lane_nodes:
            lane_nodes[None] = self.active_run.get("node_name")
        current = lane_nodes.get(lane)

        if node_name != current:
            # End the current step IN THIS LANE if there is one
            if current:
                yield self.end_step(lane)

            # Start new step if we have a node name
            if node_name:
                for event in self.start_step(node_name, lane):
                    yield event

            lane_nodes[lane] = node_name

            # Clear THIS LANE's text pin so the new node mints its own bubble.
            # _get_or_pin_text_message_id also re-mints lazily, but only when the
            # chunk carries its own langgraph_node — and plenty of providers /
            # LangChain versions attach none. Without this a supervisor -> specialist
            # flow whose OnChatModelStream chunks lack that metadata merged two nodes
            # into ONE bubble, re-opening #1317 (reproducible with the flag off).
            # Only this lane is touched: a node change in one subagent must never
            # re-mint another's in-flight bubble, which is why the lazy reset exists.
            pin_lane = lane if lane is not None else _ROOT_LANE
            self.active_run.setdefault("current_text_message_ids", {}).pop(pin_lane, None)
            self.active_run.setdefault("current_text_message_nodes", {}).pop(pin_lane, None)

        # Kept in step with the lane that produced this transition. Other paths read
        # node_name for graph-level purposes (aupdate_state's as_node, interrupt
        # handling, the exiting-node state check), which are about the graph's position
        # rather than which lane owns a step, so they keep their existing behaviour.
        self.active_run["node_name"] = node_name

    def start_step(self, step_name: str, lane: str | None = None) -> Generator[ProcessedEvents, None, None]:
        """Emit STEP_STARTED for ``step_name``; node_name bookkeeping is done by handle_node_change."""
        step_owner = lane if lane is not None else None
        # Remember who opened this step so end_step can attribute the close to the
        # same owner. Read back off the dispatched event rather than from
        # current_subagent_run_id so the two halves can never disagree about what the
        # chokepoint actually stamped.
        self.active_run.setdefault("step_owners", {})[lane] = step_owner
        event = StepStartedEvent(
            type=EventType.STEP_STARTED,
            step_name=step_name
        )
        event.subagent_run_id = step_owner
        event = self._dispatch_event(
            event
        )
        yield event

    def end_step(self, lane: str | None = None) -> ProcessedEvents:
        """Emit STEP_FINISHED for this lane's active step; bookkeeping is done by handle_node_change."""
        # Invariant: end_step is only called mid-run, from handle_node_change.
        if self.active_run is None:
            raise RuntimeError("end_step called outside an active run")
        node_name = self.active_run.get("lane_nodes", {}).get(lane)
        if not node_name:
            raise ValueError("No active step to end")

        step_owner = self.active_run.get("step_owners", {}).get(lane)
        event = StepFinishedEvent(
            type=EventType.STEP_FINISHED,
            step_name=node_name
        )
        event.subagent_run_id = step_owner
        event = self._dispatch_event(
            event
        )
        if event is None:
            # Suppressed by subagent_visibility="hidden": the step bookkeeping
            # below already ran for the open half; just tidy and emit nothing.
            self.active_run.get("step_owners", {}).pop(lane, None)
            return None
        # Overwrite whatever the chokepoint stamped. In the stream loop
        # reconcile_subagents runs BEFORE handle_node_change, so current_subagent_run_id
        # already points at the lane whose event triggered the transition, not the
        # lane that opened the step being closed. Without this, interleaved
        # subagents produce `STEP_STARTED research` under s1 paired with
        # `STEP_FINISHED research` under s2. Assigned after dispatch because the
        # correct value may be None (a parent-owned step), which the chokepoint
        # treats as "unset, go ahead and stamp".
        event.subagent_run_id = step_owner
        self.active_run.get("step_owners", {}).pop(lane, None)
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
        # Checkpoint snapshots are suppressed while a subagent is active for the
        # same reason as the node-exit ones: a subgraph's state is a partial view of
        # the run's document. A producer-side choice, not a protocol rule. The
        # MESSAGES_SNAPSHOT below is
        # still emitted and carries the subagent's messages (merged + tagged), so
        # attribution and history survive without leaking subagent state.
        #
        # Gated on the flag for the same reason as the node-exit path: the lane
        # bookkeeping runs regardless of the flag, so an ungated suppression withheld
        # snapshots from callers who never opted into subagent behaviour.
        if not (
            self.emit_subagent_events
            and self.active_run.get("current_subagent_run_id")
        ):
            yield self._dispatch_event(
                StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=self.get_state_snapshot(state_values))
            )

        snapshot_messages = self._filter_orphan_tool_messages(state_values.get("messages", []))
        agui_messages = self._merge_subagent_messages(
            self._translate_snapshot_ids(langchain_messages_to_agui(snapshot_messages))
        )
        yield self._dispatch_event(
            MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=agui_messages,
            )
        )

    def _translate_snapshot_ids(self, agui_messages: list) -> list:
        """Rewrite root-graph snapshot ids to the PUBLIC ids the stream emitted.

        Graph state carries raw upstream ids, but the stream resolves every
        emitted id through the per-lane public registry (see _resolve_public_id)
        — so when the root's raw id was minted (another lane claimed it first),
        the snapshot's copy of that message no longer matches what the client
        saw streamed. Worse, _merge_subagent_messages dedups the accumulated
        subagent entries against snapshot ids: comparing PUBLIC accumulator ids
        with RAW snapshot ids made a root/subagent raw-id collision discard the
        subagent's entry entirely — attribution and content loss at snapshot
        time.

        Root state holds only the root lane's messages (subagent output lives
        in subagent checkpoints and is merged from the accumulator), so the
        translation reads the ROOT lane's maps, read-only: ids the stream never
        claimed pass through unchanged, which also covers client-echoed history
        that already carries public ids. Messages are copied on change, never
        mutated — they alias graph state. Flag-off: the registry is empty by
        construction, so this is a no-op and the snapshot stays byte-identical.
        """
        maps = (self.active_run or {}).get("public_id_maps") or {}
        root = {
            kind: (maps.get(kind) or {}).get(_ROOT_LANE) or {}
            for kind in ("message", "tool_call", "reasoning")
        }
        if not any(root.values()):
            return agui_messages
        translated = []
        for message in agui_messages:
            update: dict = {}
            kind = "reasoning" if getattr(message, "role", None) == "reasoning" else "message"
            raw_id = getattr(message, "id", None)
            public_id = root[kind].get(raw_id)
            if public_id is not None and public_id != raw_id:
                update["id"] = public_id
            tool_calls = getattr(message, "tool_calls", None)
            if tool_calls:
                new_calls = []
                calls_changed = False
                for tool_call in tool_calls:
                    public_call = root["tool_call"].get(tool_call.id)
                    if public_call is not None and public_call != tool_call.id:
                        new_calls.append(tool_call.model_copy(update={"id": public_call}))
                        calls_changed = True
                    else:
                        new_calls.append(tool_call)
                if calls_changed:
                    update["tool_calls"] = new_calls
            raw_call_ref = getattr(message, "tool_call_id", None)
            if raw_call_ref is not None:
                public_call_ref = root["tool_call"].get(raw_call_ref)
                if public_call_ref is not None and public_call_ref != raw_call_ref:
                    update["tool_call_id"] = public_call_ref
            translated.append(message.model_copy(update=update) if update else message)
        return translated

    def _merge_subagent_messages(self, agui_messages: list) -> list:
        """Append subagent-attributed messages to a snapshot's message list,
        preserving each message's ``subagent_run_id`` so the client keeps the
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
        the declared-``subgraphs`` demo, which never sets a ``subagent_run_id``)
        produce an identical snapshot. Messages already present (matched by id)
        are not duplicated. An assistant turn with neither text nor tool calls is
        skipped so the snapshot gains no empty bubbles; tool calls are preserved
        even when the turn has no text (a tool-call-only subagent message).

        With ``emit_subagent_events`` OFF, source (1) is skipped -- those messages
        already reached the client as the parent's own work, so merging them would
        duplicate them -- but source (2) is still appended with the
        ``subagent_run_id`` STRIPPED. ``run()`` splits inbound subagent messages out
        of the graph input unconditionally (they must never enter supervisor state),
        and the client's snapshot apply is authoritative, so omitting them here made
        the client DELETE every subagent message from prior turns. Stripping the
        attribution keeps them visible as ordinary parent messages, which is exactly
        what the flag-off contract promises: the subagent's output reaches the client
        as the parent's own work.
        """
        active_run = getattr(self, "active_run", None)
        sub_msgs = (active_run.get("subagent_messages") if active_run else None) or {}
        inbound = (active_run.get("inbound_subagent_messages") if active_run else None) or []
        if not self.emit_subagent_events:
            return self._append_untagged_inbound(agui_messages, inbound)
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
                        subagent_run_id=entry["subagent_run_id"],
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
                        subagent_run_id=entry["subagent_run_id"],
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
                    subagent_run_id=entry["subagent_run_id"],
                )
            )
            existing_ids.add(entry["id"])
        # 2. Prior turns' subagent messages echoed back by the client. Re-emit
        #    verbatim (they are already well-formed AG-UI messages carrying
        #    subagent_run_id) so the client retains them in place across turns.
        for m in inbound:
            mid = getattr(m, "id", None)
            if mid in existing_ids:
                continue
            agui_messages.append(m)
            existing_ids.add(mid)
        return agui_messages

    @staticmethod
    def _append_untagged_inbound(agui_messages: list, inbound: list) -> list:
        """Re-append prior turns' subagent messages with their attribution removed.

        The flag-off half of _merge_subagent_messages. A copy is made rather than
        mutating in place: ``inbound`` holds the caller's own RunAgentInput messages,
        which must not be altered by emitting a snapshot.
        """
        if not inbound:
            return agui_messages
        existing_ids = {getattr(m, "id", None) for m in agui_messages}
        for m in inbound:
            mid = getattr(m, "id", None)
            if mid in existing_ids:
                continue
            if hasattr(m, "model_copy"):
                m = m.model_copy(update={"subagent_run_id": None})
            elif isinstance(m, dict):
                m = {k: v for k, v in m.items() if k not in ("subagent_run_id", "subagentRunId")}
            else:
                logger.debug(
                    "inbound subagent message of unexpected type %r left as-is",
                    type(m).__name__,
                )
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
