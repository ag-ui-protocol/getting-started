"""FastAPI endpoint utilities for IBM watsonx orchestrate integration."""

from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder

from .agent import WatsonxAgent


def add_watsonx_fastapi_endpoint(
    app: FastAPI | APIRouter,
    agent: WatsonxAgent,
    path: str = "/",
    **kwargs: Any,
) -> None:
    """Adds an endpoint to the FastAPI app.

    Args:
        app: FastAPI application or APIRouter to register the routes on.
        agent: watsonx orchestrate agent to serve.
        path: Path of the agent route.
        **kwargs: Forwarded to ``app.post`` for the agent route (``name``,
            ``tags``, ``operation_id``, ``dependencies``, ``include_in_schema``,
            ...). They do not apply to the other routes this helper registers,
            because values such as ``operation_id`` and ``name`` must stay
            unique per operation.
    """

    @app.post(path, **kwargs)
    async def watsonx_endpoint(input_data: RunAgentInput, request: Request):
        # Get the accept header from the request
        accept_header = request.headers.get("accept")

        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)

        # Clone the agent so each request gets its own isolated state.
        # WatsonxAgent stores per-request state (token lock, active connections);
        # sharing a single instance across concurrent requests could cause issues.
        request_agent = agent.clone()

        async def event_generator():
            async for event in request_agent.run(input_data):
                yield encoder.encode(event)

        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type(),
        )

    @app.get(f"{path}/health")
    def health():
        """Health check."""
        return {
            "status": "ok",
            "agent": {
                "name": agent.name,
            }
        }
