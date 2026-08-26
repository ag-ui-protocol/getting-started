from typing import TypedDict, Optional, List, Any, Dict, Set, Union, Literal
from typing_extensions import NotRequired
from enum import Enum

class LangGraphEventTypes(str, Enum):
    OnChainStart = "on_chain_start"
    OnChainStream = "on_chain_stream"
    OnChainEnd = "on_chain_end"
    OnChatModelStart = "on_chat_model_start"
    OnChatModelStream = "on_chat_model_stream"
    OnChatModelEnd = "on_chat_model_end"
    OnToolStart = "on_tool_start"
    OnToolEnd = "on_tool_end"
    OnToolError = "on_tool_error"
    OnCustomEvent = "on_custom_event"
    OnInterrupt = "on_interrupt"

class CustomEventNames(str, Enum):
    ManuallyEmitMessage = "manually_emit_message"
    ManuallyEmitToolCall = "manually_emit_tool_call"
    ManuallyEmitState = "manually_emit_state"
    Exit = "exit"

State = Dict[str, Any]

SchemaKeys = TypedDict("SchemaKeys", {
    "input": NotRequired[Optional[List[str]]],
    "output": NotRequired[Optional[List[str]]],
    "config": NotRequired[Optional[List[str]]],
    "context": NotRequired[Optional[List[str]]],
})

ThinkingProcess = TypedDict("ThinkingProcess", {
    "index": int,
    "message_id": NotRequired[str],
    "type": NotRequired[Optional[str]],
    "signature": NotRequired[Optional[str]],
})

MessageInProgress = TypedDict("MessageInProgress", {
    "id": str,
    "tool_call_id": NotRequired[Optional[str]],
    "tool_call_name": NotRequired[Optional[str]]
})

RunMetadata = TypedDict("RunMetadata", {
    # Identification
    "id": str,
    # LangGraph's internal chain run_id, tracked separately so it never
    # overwrites the client-supplied "id" used for the protocol RUN_STARTED /
    # RUN_FINISHED events (#1582).
    "langgraph_run_id": NotRequired[Optional[str]],
    "thread_id": NotRequired[Optional[str]],
    # Run mode/flow
    "mode": NotRequired[Literal["start", "continue"]],
    # Node tracking
    "node_name": NotRequired[Optional[str]],
    "prev_node_name": NotRequired[Optional[str]],
    # Schema
    "schema_keys": NotRequired[Optional[SchemaKeys]],
    # Streaming state
    "has_function_streaming": NotRequired[bool],
    # IDs of tool calls whose Start/Args/End were already emitted from
    # OnChatModelStream. Used as the per-id guard at OnToolEnd to skip
    # re-emitting Start/Args/End for the same id. A simple boolean flag
    # cannot model nested tool execution (e.g. a deepagents ``task`` tool
    # delegating to a subagent): the inner tool's OnToolEnd would clear the
    # flag, and the outer tool's OnToolEnd would then re-emit its Args,
    # producing duplicate / concatenated payloads in persisted history.
    "streamed_tool_call_ids": NotRequired[Set[str]],
    "model_made_tool_call": NotRequired[bool],
    "state_reliable": NotRequired[bool],
    # Message / state data
    "manually_emitted_state": NotRequired[Optional[State]],
    # Reasoning / thinking. Keyed per subagent "lane" (the derived subagent id,
    # or "__root__" for the root/supervisor) so concurrently-streaming subagents
    # do not clobber each other's in-flight reasoning. Each deepagents fan-out
    # subagent has a distinct id, so this isolates concurrent subagent reasoning
    # (see _current_lane for the attribution-less fan-out caveat).
    "reasoning_processes": NotRequired[Dict[str, ThinkingProcess]],
    # Canonical pending reasoning id (from a text-less reasoning chunk), keyed
    # per lane like reasoning_processes.
    "pending_reasoning_ids": NotRequired[Dict[str, str]],
    # Pinned text message id per (lane, node). Set on the first auto-streamed
    # text chunk from a lane's node (from the chunk's id) and reused for every
    # subsequent TEXT_MESSAGE_START from the same lane while that lane's node is
    # unchanged, so text resuming after a tool call (or after a fresh model
    # invocation within the same node) stays in the same UI bubble. The pin is
    # re-minted lazily by _get_or_pin_text_message_id when the lane's own node
    # changes (tracked in current_text_message_nodes) — NOT by handle_node_change
    # on the global node_name, which thrashes under concurrent subagents. So
    # multi-node graphs (e.g. supervisor routing to specialist agents) still get
    # separate bubbles per node. Reset implicitly on the next run when active_run
    # is replaced. Not used by ManuallyEmitMessage events: those carry their own
    # message_id and bypass this field entirely.
    #
    # Keyed per subagent "lane" (the derived subagent id, or "__root__" for the
    # root/supervisor) so concurrently-streaming subagents keep independent
    # text bubbles. Keyed by lane rather than by model run_id on purpose: a
    # single subagent's ReAct loop spans multiple model invocations (distinct
    # run_ids), and the pin must survive across them to keep text→tool→text in
    # one bubble — run_id keying would fragment it.
    "current_text_message_ids": NotRequired[Dict[str, Optional[str]]],
    # The node that owns each lane's current text pin. The pin resets when the
    # lane's own node changes (not the global node_name, which thrashes under
    # concurrent subagents). See _get_or_pin_text_message_id.
    "current_text_message_nodes": NotRequired[Dict[str, Optional[str]]],
    # Deepagents subagent tracking. Maps a stable per-invocation subagent id
    # (the DEEPEST recorded subagent-boundary segment of the event's
    # `|`-separated checkpoint_ns, e.g. "tools:<uuid>" — see
    # _record_subagent_boundaries, which is what distinguishes a nested subagent
    # from a subagent's own inner tool call) to the subagent's reported name:
    # the declared `subagent_type` from the `task` tool when it was captured,
    # falling back to the runtime metadata's lc_agent_name. Holds every subagent
    # invocation currently active on this run.
    "active_subagents": NotRequired[Dict[str, str]],
    # The subagent id (see above) whose events are currently being processed,
    # or None when the current event originates at the root/supervisor level.
    # Maintained regardless of `emit_subagent_events` (other paths read it), so
    # every site that reads it to decide what to EMIT must check the flag too.
    "current_subagent_run_id": NotRequired[Optional[str]],
    # Subagent ids that already received a terminal event (SUBAGENT_FINISHED or
    # SUBAGENT_ERROR) on this run. A terminal is terminal for the id it names, so
    # a closed id may never be re-opened by a trailing event from its namespace.
    "closed_subagents": NotRequired[Set[str]],
    # subagent id -> the id of the subagent that INVOKED it (None for a
    # top-level subagent, whose parent is the root). Used to restore
    # current_subagent_run_id to the invoking subagent when a nested child
    # finishes, so the `task` result is attributed to the parent, not the root.
    "subagent_parents": NotRequired[Dict[str, Optional[str]]],
    # Accumulated `tools:<uuid>` checkpoint_ns segments confirmed to be genuine
    # subagent boundaries (a `tools:` segment directly followed by a non-`tools`
    # node). Lets derive_subagent_context tell a nested subagent apart from a
    # subagent's own inner tool call.
    "subagent_segments": NotRequired[Set[str]],
    # LangGraph run_id of each `task` tool invocation -> the subagent id it
    # spawned, so the matching OnToolEnd finishes exactly that subagent. Keyed by
    # run_id rather than namespace because the subagent's own inner tools share
    # its namespace and would finish it prematurely.
    "subagent_task_runs": NotRequired[Dict[str, str]],
    # Steps are tracked PER LANE: lane -> the node whose step is currently open
    # in that lane. The parent/supervisor lane is the key None; each subagent's
    # lane is its subagent id. With `emit_subagent_events` off every event maps
    # to the None lane, so steps stay a single flat sequence exactly as they were
    # before subagent support.
    "lane_nodes": NotRequired[Dict[Optional[str], Optional[str]]],
    # lane -> the subagent_run_id that was stamped on that lane's STEP_STARTED,
    # so STEP_FINISHED can be attributed to whoever OPENED the step rather than
    # to whichever lane happens to be current when it closes.
    "step_owners": NotRequired[Dict[Optional[str], Optional[str]]],
    # `task` delegation calls seen streaming from the supervisor, queued as
    # {"tool_call_id", "parent_message_id"} so each spawned subagent can carry
    # parentToolCallId / parentMessageId. Normally matched by namespace (see
    # task_tool_call_ids_by_ns); FIFO order is only the fallback.
    "pending_task_calls": NotRequired[List[Dict[str, Optional[str]]]],
    # tool_call_ids already queued into pending_task_calls, since a call's id
    # recurs across every one of its arg-streaming chunks.
    "seen_task_call_ids": NotRequired[Set[str]],
    # ToolNode dispatch namespace -> the single `task` tool_call_id dispatched in
    # it. Lets a subagent be linked to its EXACT spawning call by namespace
    # instead of by emission order (which tool-start reordering violates).
    "task_tool_call_ids_by_ns": NotRequired[Dict[str, str]],
    # Snapshot of LangGraphAgent.emit_subagent_events for this run. Read by the
    # module-level subagent emitters, which have no instance, so the opt-in gate
    # cannot be bypassed by a caller that forgets to check.
    "emit_subagent_events": NotRequired[bool],
    # Subagent-attributed messages the client echoed back from prior turns,
    # split out of the graph input in run() (they must never enter supervisor
    # state). Re-emitted in MESSAGES_SNAPSHOT so they persist in the client's
    # display across turns — with their attribution stripped when the flag is
    # off. See _merge_subagent_messages.
    "inbound_subagent_messages": NotRequired[List[Any]],
    # Declared metadata for each subagent invocation, captured from the
    # deepagents `task` delegation tool's on_tool_start input (which runs in the
    # subagent's own checkpoint namespace, i.e. its subagent id). Maps subagent
    # id -> {"name": subagent_type, "description": task description,
    # "parent_tool_call_id": the `task` call that spawned it,
    # "parent_message_id": the assistant message that call streamed from}, so
    # SUBAGENT_STARTED can carry the declared subagent type, the per-invocation
    # description and the parent links rather than only the runtime
    # lc_agent_name.
    "subagent_task_meta": NotRequired[Dict[str, Dict[str, Optional[str]]]],
    # Subagent-attributed messages streamed during this run, keyed by message
    # id. Assistant entries hold {kind:"assistant", id, role, content,
    # subagent_run_id, tool_calls}; tool-result entries hold {kind:"tool", id,
    # content, tool_call_id, subagent_run_id}. These live only in the subagent
    # (subgraph) checkpoint, not main-graph state, so they are merged into
    # MESSAGES_SNAPSHOT (which is built from main-graph state) to keep the
    # streamed subagent text AND tool calls from being wiped when the client
    # applies it.
    "subagent_messages": NotRequired[Dict[str, Any]],
    # Routes a subagent tool call's streamed TOOL_CALL_ARGS deltas (which carry
    # only tool_call_id, no parent_message_id/subagent_run_id) back to the owning
    # assistant entry in subagent_messages. Maps tool_call_id -> message id.
    "subagent_tool_call_owner": NotRequired[Dict[str, str]],
})

# run_id -> lane -> in-flight message/tool-call record. The inner "lane" key is
# the derived subagent id ("__root__" for the root/supervisor), so concurrently
# streaming subagents each get their own in-flight slot and never merge tokens.
MessagesInProgressRecord = Dict[str, Dict[str, Optional[MessageInProgress]]]

ToolCall = TypedDict("ToolCall", {
    "id": str,
    "name": str,
    "args": Dict[str, Any]
})

class BaseLangGraphPlatformMessage(TypedDict):
    content: str
    role: str
    additional_kwargs: NotRequired[Dict[str, Any]]
    type: str
    id: str

class LangGraphPlatformResultMessage(BaseLangGraphPlatformMessage):
    tool_call_id: str
    name: str

class LangGraphPlatformActionExecutionMessage(BaseLangGraphPlatformMessage):
    tool_calls: List[ToolCall]

LangGraphPlatformMessage = Union[
    LangGraphPlatformActionExecutionMessage,
    LangGraphPlatformResultMessage,
    BaseLangGraphPlatformMessage,
]

PredictStateTool = TypedDict("PredictStateTool", {
    "tool": str,
    "state_key": str,
    "tool_argument": str
})

LangGraphReasoning = TypedDict("LangGraphReasoning", {
    "type": str,
    "text": str,
    "index": int,
    "signature": NotRequired[Optional[str]],
    # The provider's canonical id for the reasoning item (e.g. OpenAI
    # ``rs_…``), when the stream carries one. Used as the AG-UI reasoning
    # message id so the streamed message reconciles with the snapshot copy
    # emitted by ``_reasoning_block_to_agui_message`` under the same id.
    "id": NotRequired[Optional[str]],
})
