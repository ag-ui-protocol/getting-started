"""Example usage of the AG-UI adapter for Agno.

This provides a FastAPI application that demonstrates how to use the
Agno agent with the AG-UI protocol. It includes examples for
AG-UI dojo features:
- Agentic Chat (Investment Analyst with Finance tools)
- Agentic Chat with Reasoning (o4-mini with thinking)
- Agentic Chat Multimodal (images, audio, video, documents)
- Agentic Generative UI (task steps streaming)
- Backend Tool Rendering (weather tools)
- Human in the Loop (confirmation dialogs)
- Predictive State Updates (document writer)
- Shared State (recipe assistant)
- Tool-based Generative UI (haiku generator)
"""

from __future__ import annotations

import os

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv()

from .api import (
    agentic_chat_app,
    agentic_chat_multimodal_app,
    agentic_chat_reasoning_app,
    agentic_generative_ui_app,
    backend_tool_rendering_app,
    human_in_the_loop_app,
    predictive_state_updates_app,
    shared_state_app,
    tool_based_generative_ui_app,
)

app = FastAPI(title="Agno AG-UI server")
app.mount("/agentic_chat", agentic_chat_app, "Agentic Chat")
app.mount("/agentic_chat_reasoning", agentic_chat_reasoning_app, "Agentic Chat Reasoning")
app.mount("/agentic_chat_multimodal", agentic_chat_multimodal_app, "Agentic Chat Multimodal")
app.mount("/agentic_generative_ui", agentic_generative_ui_app, "Agentic Generative UI")
app.mount("/backend_tool_rendering", backend_tool_rendering_app, "Backend Tool Rendering")
app.mount("/human_in_the_loop", human_in_the_loop_app, "Human in the Loop")
app.mount("/predictive_state_updates", predictive_state_updates_app, "Predictive State Updates")
app.mount("/shared_state", shared_state_app, "Shared State")
app.mount("/tool_based_generative_ui", tool_based_generative_ui_app, "Tool-based Generative UI")


def main():
    """Main function to start the FastAPI server."""
    port = int(os.getenv("PORT", "9001"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()

__all__ = ["main"]
