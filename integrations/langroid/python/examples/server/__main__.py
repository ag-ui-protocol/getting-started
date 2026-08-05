"""Main entry point for running the Langroid AG-UI examples server."""

import os
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.agentic_chat import app as agentic_chat_app
from .api.backend_tool_rendering import app as backend_tool_rendering_app
from .api.agentic_generative_ui import app as agentic_generative_ui_app
from .api.shared_state import app as shared_state_app

app = FastAPI(title="Langroid AG-UI Examples Server")

# Allowed CORS origins come from CORS_ALLOW_ORIGINS (comma-separated) and default
# to the "*" wildcard for local development. Credentials are only enabled for
# explicit, non-wildcard origins — a wildcard can never be combined with
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

# Mount endpoints
app.mount("/agentic_chat", agentic_chat_app)
app.mount("/backend_tool_rendering", backend_tool_rendering_app)
app.mount("/agentic_generative_ui", agentic_generative_ui_app)
app.mount("/shared_state", shared_state_app)


def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8018"))
    # Use import string for reload to work properly
    uvicorn.run(
        "server.__main__:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )


if __name__ == "__main__":
    main()

