"""
Multi-agent server for Claude Agent SDK integration.

The adapter manages the SDK lifecycle internally — the server just
calls adapter.run(input_data) and streams the resulting AG-UI events.
"""

import os
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ag_ui_claude_sdk import add_claude_fastapi_endpoint

from agents.agentic_chat import create_agentic_chat_adapter
from agents.backend_tool_rendering import create_backend_tool_adapter
from agents.shared_state import create_shared_state_adapter
from agents.human_in_the_loop import create_human_in_the_loop_adapter
from agents.tool_based_generative_ui import create_tool_based_generative_ui_adapter

app = FastAPI(title="Claude Agent SDK Server")

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

adapters = {
    "agentic_chat": create_agentic_chat_adapter(),
    "backend_tool_rendering": create_backend_tool_adapter(),
    "shared_state": create_shared_state_adapter(),
    "human_in_the_loop": create_human_in_the_loop_adapter(),
    "tool_based_generative_ui": create_tool_based_generative_ui_adapter(),
}

for name, adapter in adapters.items():
    add_claude_fastapi_endpoint(app=app, adapter=adapter, path=f"/{name}")


@app.get("/health")
async def health():
    return {"status": "healthy", "agents": len(adapters)}


def main():
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("Error: ANTHROPIC_API_KEY required")
        return 1

    port = int(os.getenv("PORT", "8019"))
    print(f"Starting server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    exit(main())
