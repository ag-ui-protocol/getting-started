"""Aggregate FastAPI server for the OpenAI Agents SDK Dojo demos.

Each demo owns a small FastAPI app. This server mounts those apps under the
Dojo feature paths and serves them together on port 8027.
"""

from __future__ import annotations

import os
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from agents_examples import (
    ag_ui_docs_copilot,
    agentic_chat,
    backend_tool_rendering,
    custom_lifecycle_events,
    dynamic_system_prompt,
    human_in_the_loop,
    human_in_the_loop_approval,
    subagents,
    tool_based_generative_ui,
)

# Tracing follows the SDK's own OPENAI_AGENTS_DISABLE_TRACING env var and its
# own default (tracing on) — nothing to set up here.

DEMOS = {
    "ag_ui_docs_copilot": ag_ui_docs_copilot.copilot_agent,
    "agentic_chat": agentic_chat.agent,
    "backend_tool_rendering": backend_tool_rendering.agent,
    "human_in_the_loop": human_in_the_loop.agent,
    "human_in_the_loop_approval": human_in_the_loop_approval.agent,
    "tool_based_generative_ui": tool_based_generative_ui.agent,
    "subagents": subagents.agent,
    "custom_lifecycle_events": custom_lifecycle_events.agent,
    "dynamic_system_prompt": dynamic_system_prompt.agent,
}

DEMO_APPS = {
    "ag_ui_docs_copilot": ag_ui_docs_copilot.app,
    "agentic_chat": agentic_chat.app,
    "backend_tool_rendering": backend_tool_rendering.app,
    "human_in_the_loop": human_in_the_loop.app,
    "human_in_the_loop_approval": human_in_the_loop_approval.app,
    "tool_based_generative_ui": tool_based_generative_ui.app,
    "subagents": subagents.app,
    "custom_lifecycle_events": custom_lifecycle_events.app,
    "dynamic_system_prompt": dynamic_system_prompt.app,
}

app = FastAPI(title="AG-UI × OpenAI Agents SDK examples")

for demo_name, demo_app in DEMO_APPS.items():
    app.mount(f"/{demo_name}", demo_app, name=demo_name)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "agents": list(DEMOS)}


def main() -> int:
    if not os.getenv("OPENAI_API_KEY"):
        print("Error: OPENAI_API_KEY required")
        return 1
    port = int(os.getenv("PORT", "8027"))
    host = os.getenv("HOST", "0.0.0.0")
    print(f"Starting server on port {port} — agents: {list(DEMOS)}")
    if os.getenv("RELOAD"):
        uvicorn.run(
            "server:app",
            host=host,
            port=port,
            reload=True,
            reload_dirs=[str(Path(__file__).parent), str(Path(__file__).parent.parent / "src")],
            log_level="info",
        )
    else:
        uvicorn.run(app, host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
