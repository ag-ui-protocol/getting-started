"""AG2 AG-UI example server for the Dojo.

Exposes AG-UI compatible endpoints using AG2's AGUIStream.
"""

import os

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv()

from .api import (
    agentic_chat,
    agentic_chat_multimodal,
    agentic_generative_ui,
    backend_tool_rendering,
    human_in_the_loop,
    shared_state,
    tool_based_generative_ui,
)

app = FastAPI(title="AG2 AG-UI server")
app.mount(
    "/agentic_chat",
    agentic_chat.agentic_chat_app,
    "Agentic Chat",
)
app.mount(
    "/agentic_chat_multimodal",
    agentic_chat_multimodal.agentic_chat_multimodal_app,
    "Agentic Chat Multimodal",
)
app.mount(
    "/backend_tool_rendering",
    backend_tool_rendering.backend_tool_rendering_app,
    "Backend Tool Rendering",
)
app.mount(
    "/human_in_the_loop",
    human_in_the_loop.human_in_the_loop_app,
    "Human in the Loop",
)
app.mount(
    "/agentic_generative_ui",
    agentic_generative_ui.agentic_generative_ui_app,
    "Agentic Generative UI",
)
app.mount(
    "/tool_based_generative_ui",
    tool_based_generative_ui.tool_based_generative_ui_app,
    "Tool-based Generative UI",
)
app.mount(
    "/shared_state",
    shared_state.shared_state_app,
    "Shared State",
)


def main():
    """Start the FastAPI server."""
    port = int(os.getenv("PORT", "8018"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)


if __name__ == "__main__":
    main()

__all__ = ["main"]
