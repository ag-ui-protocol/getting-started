"""AG-UI Dojo server for AWS Strands Integration 2.

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

# Suppress OpenTelemetry warnings
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

# Load environment variables
env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

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
    shared_state_app,
)

# Create main app
app = FastAPI(title='AWS Strands Integration 2 - Dojo')

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

@app.get("/")
def root():
    return {
        "message": "AWS Strands Integration 2 - AG-UI Dojo",
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
            "human_in_the_loop": "/human-in-the-loop"
        }
    }

def main():
    """Start the server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()

__all__ = ["main", "app"]
