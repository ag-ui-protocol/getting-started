import os
import uvicorn
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

def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "ag_ui_crewai.dojo:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )
