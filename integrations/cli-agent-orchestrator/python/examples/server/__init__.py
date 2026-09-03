"""Keyless AG-UI Dojo server for CLI Agent Orchestrator (CAO).

Mounts four Dojo features, each a thin projection of CAO's merged run plane over
a deterministic ``mock_cli`` fleet — no API keys, no tmux, no browser. Runs on
port 8027 by default with ``/health`` and CORS per the Dojo server convention.
"""

from __future__ import annotations

import os

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# The run plane requires the ``cli-agent-orchestrator[agui]`` extra
# (ag-ui-protocol). Enable the AG-UI surface for this process.
os.environ.setdefault("CAO_AGUI_ENABLED", "1")

from ._common import resolve_mode  # noqa: E402
from .agentic_chat import app as agentic_chat_app  # noqa: E402
from .agentic_generative_ui import app as agentic_generative_ui_app  # noqa: E402
from .human_in_the_loop import app as human_in_the_loop_app  # noqa: E402
from .interrupt import app as interrupt_app  # noqa: E402
from .shared_state import app as shared_state_app  # noqa: E402

# Resolve the backend once at import so a misconfiguration (CAO_AGUI_MODE=projection
# without the `cao` extra installed) fails fast at startup instead of surfacing as
# per-request 500s.
resolve_mode()

app = FastAPI(title="CLI Agent Orchestrator (CAO) — AG-UI Dojo server")

# CORS: default to the "*" wildcard for local dev. Credentials are only enabled
# for explicit, non-wildcard origins (a wildcard can never combine with
# allow_credentials=True). Mirrors the other Dojo example servers.
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

# Feature mounts — hyphenated paths, matching the Dojo agents.ts mapping.
app.mount("/agentic-chat", agentic_chat_app, "Agentic Chat")
app.mount("/shared-state", shared_state_app, "Shared State")
app.mount("/human-in-the-loop", human_in_the_loop_app, "Human in the Loop")
app.mount("/agentic-generative-ui", agentic_generative_ui_app, "Agentic Generative UI")
app.mount("/interrupt", interrupt_app, "Interrupt")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/")
def root():
    return {
        "message": "CLI Agent Orchestrator (CAO) — AG-UI Dojo server",
        "repo": "https://github.com/awslabs/cli-agent-orchestrator",
        "endpoints": {
            "agentic_chat": "/agentic-chat",
            "shared_state": "/shared-state",
            "human_in_the_loop": "/human-in-the-loop",
            "agentic_generative_ui": "/agentic-generative-ui",
            "interrupt": "/interrupt",
        },
    }


def main() -> None:
    """Start the server (``uv run dev``)."""
    port = int(os.getenv("PORT", "8027"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()


__all__ = ["app", "main"]
