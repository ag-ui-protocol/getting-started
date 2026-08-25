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
    # Reasoning / thinking
    "reasoning_process": NotRequired[Optional[ThinkingProcess]],
    # Pinned text message id for the current node. Set on the first
    # auto-streamed text chunk emitted from a node (from the chunk's id) and
    # reused for every subsequent TEXT_MESSAGE_START emitted from the same
    # node, so text resuming after a tool call (or after a fresh model
    # invocation within the same node) stays in the same UI bubble. Cleared
    # by handle_node_change on every node transition, so multi-node graphs
    # (e.g. supervisor routing to specialist agents) preserve separate
    # bubbles per node. Reset implicitly on the next run when active_run is
    # replaced. Not used by ManuallyEmitMessage events: those carry their
    # own message_id and bypass this field entirely.
    "current_text_message_id": NotRequired[Optional[str]],
})

MessagesInProgressRecord = Dict[str, Optional[MessageInProgress]]

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
