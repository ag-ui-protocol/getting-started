"""AG-UI Dojo server for the AWS Strands integration.

Simple server running all example agents.
"""
import os
import sys
import uvicorn
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Add src directory to Python path to import ag_ui_strands
src_dir = Path(__file__).parent.parent.parent / "src"
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

# Load environment variables from examples/.env, which is where the README tells
# the operator to put them. One `parent` fewer than the api modules use, because
# this file sits one directory shallower than they do.
env_path = Path(__file__).parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

# Quieten OpenTelemetry warnings by default. AFTER load_dotenv and via
# `setdefault`, so a value the operator set either in the environment or in
# examples/.env survives; still before the api imports below, which is what has
# to happen for the setting to take effect at all.
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("OTEL_PYTHON_DISABLED_INSTRUMENTATIONS", "all")

# Import agent apps
from .api import (
    a2ui_dynamic_schema_app,
    a2ui_fixed_schema_app,
    a2ui_recovery_app,
    agentic_chat_app,
    agentic_chat_reasoning_app,
    agentic_chat_multimodal_app,
    agentic_generative_ui_app,
    backend_tool_rendering_app,
    human_in_the_loop_app,
    interrupt_app,
    multi_agent_app,
    predictive_state_updates_app,
    shared_state_app,
    tool_based_generative_ui_app,
)

# Create main app
app = FastAPI(title='AWS Strands - AG-UI Dojo')

# Add CORS.
# Origins come from CORS_ALLOW_ORIGINS (comma-separated) and default to the "*"
# wildcard for local development. Credentials are only enabled for explicit,
# non-wildcard origins — a wildcard can never be combined with
# allow_credentials=True (any site could then read authenticated responses).
_origins = [o.strip() for o in os.getenv("CORS_ALLOW_ORIGINS", "").split(",") if o.strip()]
cors_origins = _origins or ["*"]
is_wildcard = "*" in cors_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=bool(_origins) and not is_wildcard,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount agents
app.mount('/a2ui-dynamic-schema', a2ui_dynamic_schema_app, 'A2UI Dynamic Schema')
app.mount('/a2ui-fixed-schema', a2ui_fixed_schema_app, 'A2UI Fixed Schema')
app.mount('/a2ui-recovery', a2ui_recovery_app, 'A2UI Recovery')
app.mount('/agentic-chat', agentic_chat_app, 'Agentic Chat')
app.mount('/agentic-chat-reasoning', agentic_chat_reasoning_app, 'Agentic Chat Reasoning')
app.mount('/agentic-chat-multimodal', agentic_chat_multimodal_app, 'Agentic Chat Multimodal')
app.mount('/backend-tool-rendering', backend_tool_rendering_app, 'Backend Tool Rendering')
app.mount('/agentic-generative-ui', agentic_generative_ui_app, 'Agentic Generative UI')
app.mount('/shared-state', shared_state_app, 'Shared State')
app.mount('/human-in-the-loop', human_in_the_loop_app, 'Human in the Loop')
app.mount('/interrupt', interrupt_app, 'Interrupt')
app.mount('/predictive-state-updates', predictive_state_updates_app, 'Predictive State Updates')
app.mount('/tool-based-generative-ui', tool_based_generative_ui_app, 'Tool Based Generative UI')
app.mount('/multi-agent', multi_agent_app, 'Multi Agent')

@app.get("/")
def root():
    return {
        "message": "AWS Strands - AG-UI Dojo",
        "endpoints": {
            "a2ui_dynamic_schema": "/a2ui-dynamic-schema",
            "a2ui_fixed_schema": "/a2ui-fixed-schema",
            "a2ui_recovery": "/a2ui-recovery",
            "agentic_chat": "/agentic-chat",
            "agentic_chat_reasoning": "/agentic-chat-reasoning",
            "agentic_chat_multimodal": "/agentic-chat-multimodal",
            "backend_tool_rendering": "/backend-tool-rendering",
            "agentic_generative_ui": "/agentic-generative-ui",
            "shared_state": "/shared-state",
            "human_in_the_loop": "/human-in-the-loop",
            "interrupt": "/interrupt",
            "predictive_state_updates": "/predictive-state-updates",
            "tool_based_generative_ui": "/tool-based-generative-ui",
            "multi_agent": "/multi-agent"
        }
    }

def main():
    """Start the server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()

__all__ = ["main", "app"]
