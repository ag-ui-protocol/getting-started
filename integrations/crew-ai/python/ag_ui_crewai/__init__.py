from .endpoint import (
  add_crewai_flow_fastapi_endpoint,
  add_crewai_crew_fastapi_endpoint,
  crewai_prepare_inputs,
)
from .crews import ChatWithCrewFlow
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
# from .enterprise import CrewEnterpriseEventListener

from ._capabilities import get_capabilities

# CREW_ENTERPRISE_EVENT_LISTENER = CrewEnterpriseEventListener()

# The Crew chat path was undiscoverable — the four symbols below (the
# crew-endpoint factory, its input-prep helper, the flow, and the exit
# signal) were absent from the package top level. Export them alongside
# the pre-existing flow-path surface.
__all__ = [
    "get_capabilities",
  "add_crewai_flow_fastapi_endpoint",
  "add_crewai_crew_fastapi_endpoint",
  "crewai_prepare_inputs",
  "ChatWithCrewFlow",
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
