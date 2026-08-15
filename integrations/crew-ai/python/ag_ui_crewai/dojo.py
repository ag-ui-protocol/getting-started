from fastapi import FastAPI

from .endpoint import add_crewai_flow_fastapi_endpoint, add_crewai_crew_fastapi_endpoint
from .examples.crew_chat import CrewChatCrew
from .examples.agentic_chat import AgenticChatFlow
from .examples.backend_tool_rendering import BackendToolRenderingFlow
from .examples.human_in_the_loop import HumanInTheLoopFlow
from .examples.tool_based_generative_ui import ToolBasedGenerativeUIFlow
from .examples.agentic_generative_ui import AgenticGenerativeUIFlow
from .examples.shared_state import SharedStateFlow
from .examples.predictive_state_updates import PredictiveStateUpdatesFlow
from .examples.error_flow import ErrorFlow
from .examples.interrupt_flow import InterruptFlow
from .examples.a2ui_dynamic_schema import A2UIDynamicSchemaFlow
from .examples.a2ui_recovery import A2UIRecoveryFlow
from .examples.a2ui_fixed_schema import A2UIFixedSchemaFlow
from .examples.agentic_chat_multimodal import AgenticChatMultimodalFlow
from .examples.agentic_chat_reasoning import AgenticChatReasoningFlow
from .examples.conversational import CONVERSATIONAL_FLOW_TYPES

app = FastAPI(title="CrewAI Dojo Example Server")

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=AgenticChatFlow(),
    path="/agentic_chat",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=BackendToolRenderingFlow(),
    path="/backend_tool_rendering",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=HumanInTheLoopFlow(),
    path="/human_in_the_loop",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=ToolBasedGenerativeUIFlow(),
    path="/tool_based_generative_ui",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=AgenticGenerativeUIFlow(),
    path="/agentic_generative_ui",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=SharedStateFlow(),
    path="/shared_state",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=PredictiveStateUpdatesFlow(),
    path="/predictive_state_updates",
)

add_crewai_crew_fastapi_endpoint(
    app=app,
    crew=CrewChatCrew(),
    path="/crew_chat",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=ErrorFlow(),
    path="/error_flow",
)

# emit_interrupt_outcome=True: CopilotKit v2 `useInterrupt` (>=1.61.2) resumes
# from the standard RUN_FINISHED.outcome. With the default (legacy on_interrupt
# only) its resolve() does not round-trip a RunAgentInput.resume[], so the run
# re-kicks off and re-pauses in a loop. Enable the outcome for modern clients.
add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=InterruptFlow(),
    path="/interrupt",
    emit_interrupt_outcome=True,
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=A2UIDynamicSchemaFlow(),
    path="/a2ui_dynamic_schema",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=A2UIRecoveryFlow(),
    path="/a2ui_recovery",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=A2UIFixedSchemaFlow(),
    path="/a2ui_fixed_schema",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=AgenticChatMultimodalFlow(),
    path="/agentic_chat_multimodal",
)

add_crewai_flow_fastapi_endpoint(
    app=app,
    flow=AgenticChatReasoningFlow(),
    path="/agentic_chat_reasoning",
)

for feature, flow_type in CONVERSATIONAL_FLOW_TYPES.items():
    add_crewai_flow_fastapi_endpoint(
        app=app,
        flow=flow_type(),
        path=f"/conversational_flows/{feature}",
        conversational=True,
        emit_interrupt_outcome=feature == "interrupt",
    )
