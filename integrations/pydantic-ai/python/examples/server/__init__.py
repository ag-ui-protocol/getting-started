"""Example usage of the AG-UI adapter for Pydantic AI.

This provides a FastAPI application that demonstrates how to use the
Pydantic AI agent with the AG-UI protocol. It includes examples for
each of the AG-UI dojo features:
- Agentic Chat
- Agentic Chat Multimodal
- Human in the Loop
- Agentic Generative UI
- Tool Based Generative UI
- Shared State
- Predictive State Updates

Each feature module defines an agent; the routes below serve them over
the AG-UI protocol with `AGUIAdapter.dispatch_request()`, per
https://ai.pydantic.dev/ui/ag-ui/
"""

from __future__ import annotations

from fastapi import FastAPI
from starlette.requests import Request
from starlette.responses import Response
import uvicorn
import os
from dotenv import load_dotenv

load_dotenv()

from pydantic_ai.ui import StateDeps
from pydantic_ai.ui.ag_ui import AGUIAdapter

from .api import (
    agentic_chat,
    agentic_chat_multimodal,
    agentic_generative_ui,
    backend_tool_rendering,
    human_in_the_loop,
    predictive_state_updates,
    shared_state,
    tool_based_generative_ui,
)

app = FastAPI(title='Pydantic AI AG-UI server')


@app.post('/agentic_chat')
async def run_agentic_chat(request: Request) -> Response:
    return await AGUIAdapter.dispatch_request(request, agent=agentic_chat.agent)


@app.post('/agentic_chat_multimodal')
async def run_agentic_chat_multimodal(request: Request) -> Response:
    return await AGUIAdapter.dispatch_request(
        request, agent=agentic_chat_multimodal.agent
    )


@app.post('/agentic_generative_ui')
async def run_agentic_generative_ui(request: Request) -> Response:
    return await AGUIAdapter.dispatch_request(
        request, agent=agentic_generative_ui.agent
    )


@app.post('/backend_tool_rendering')
async def run_backend_tool_rendering(request: Request) -> Response:
    return await AGUIAdapter.dispatch_request(
        request, agent=backend_tool_rendering.agent
    )


@app.post('/human_in_the_loop')
async def run_human_in_the_loop(request: Request) -> Response:
    return await AGUIAdapter.dispatch_request(request, agent=human_in_the_loop.agent)


@app.post('/predictive_state_updates')
async def run_predictive_state_updates(request: Request) -> Response:
    # dispatch_request writes the request's state into deps.state, so each
    # request constructs its own deps.
    return await AGUIAdapter.dispatch_request(
        request,
        agent=predictive_state_updates.agent,
        deps=StateDeps(predictive_state_updates.DocumentState()),
    )


@app.post('/shared_state')
async def run_shared_state(request: Request) -> Response:
    # dispatch_request writes the request's state into deps.state, so each
    # request constructs its own deps.
    return await AGUIAdapter.dispatch_request(
        request,
        agent=shared_state.agent,
        deps=StateDeps(shared_state.RecipeSnapshot()),
    )


@app.post('/tool_based_generative_ui')
async def run_tool_based_generative_ui(request: Request) -> Response:
    return await AGUIAdapter.dispatch_request(
        request, agent=tool_based_generative_ui.agent
    )


def main():
    """Main function to start the FastAPI server."""
    port = int(os.getenv("PORT", "9000"))
    uvicorn.run(app, host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()

__all__ = ["main"]
