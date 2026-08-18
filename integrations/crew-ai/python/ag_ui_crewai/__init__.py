from .endpoint import (
  add_crewai_flow_fastapi_endpoint,
  add_crewai_crew_fastapi_endpoint,
  crewai_prepare_inputs,
)
from .crews import ChatWithCrewFlow
from ._conversation import (
  ConversationCapacityExceeded,
  ConversationThreadBusy,
  ConversationWorkerAborted,
  ConversationWorkerStats,
  abandoned_conversational_run_for_thread,
  conversation_worker_stats,
  conversational_flow_key,
)
from ._hitl import AGUIFeedbackProvider, agui_feedback_provider
from .sdk import (
  CopilotKitState,
  StateItem,
  copilotkit_predict_state,
  copilotkit_emit_state,
  copilotkit_emit_tool_result,
  copilotkit_stream,
  copilotkit_exit,
)
from ._responses import copilotkit_responses, responses_channel_available
from .a2ui_tool import (
  A2UITool,
  get_a2ui_tools,
  plan_a2ui_injection,
  apply_a2ui_plan_to_tools,
  is_auto_injected_a2ui_tool,
  A2UI_STREAM_KEY,
)

from ._capabilities import get_capabilities

# The Crew chat path is reachable from the package top level: the
# crew-endpoint factory, its input-prep helper, the flow, and the exit signal,
# exported alongside the flow-path surface.
__all__ = [
    "get_capabilities",
  "add_crewai_flow_fastapi_endpoint",
  "add_crewai_crew_fastapi_endpoint",
  "crewai_prepare_inputs",
  "ChatWithCrewFlow",
  # Conversational sync-worker observability: active turns, still-running
  # abandoned turns, the oldest abandoned turn's age, and rejection counters.
  "ConversationWorkerStats",
  "conversation_worker_stats",
  "abandoned_conversational_run_for_thread",
  # The flow half of a conversation key, since the query above takes one: a
  # process serves many flows and the threadId belongs to the client.
  "conversational_flow_key",
  # The exception types behind the conversational RUN_ERROR codes, so a caller
  # driving a flow directly can catch saturation, thread conflict, and a turn
  # that was cut off (rather than finished) by type.
  "ConversationCapacityExceeded",
  "ConversationThreadBusy",
  "ConversationWorkerAborted",
  "AGUIFeedbackProvider",
  "agui_feedback_provider",
  "CopilotKitState",
  "StateItem",
  "copilotkit_predict_state",
  "copilotkit_emit_state",
  "copilotkit_emit_tool_result",
  "copilotkit_stream",
  "copilotkit_responses",
  "responses_channel_available",
  "copilotkit_exit",
  "A2UITool",
  "get_a2ui_tools",
  "plan_a2ui_injection",
  "apply_a2ui_plan_to_tools",
  "is_auto_injected_a2ui_tool",
  "A2UI_STREAM_KEY",
]
