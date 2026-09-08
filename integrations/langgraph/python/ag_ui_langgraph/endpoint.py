from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder

from .agent import LangGraphAgent

def add_langgraph_fastapi_endpoint(
    app: FastAPI | APIRouter,
    agent: LangGraphAgent,
    path: str = "/",
    **kwargs: Any,
):
    """Adds an endpoint to the FastAPI app.

    Args:
        app: FastAPI application or APIRouter to register the routes on.
        agent: LangGraph agent to serve.
        path: Path of the agent route.
        **kwargs: Forwarded to ``app.post`` for the agent route (``name``,
            ``tags``, ``operation_id``, ``dependencies``, ``include_in_schema``,
            ...). They do not apply to the other routes this helper registers,
            because values such as ``operation_id`` and ``name`` must stay
            unique per operation.
    """

    @app.post(path, **kwargs)
    async def langgraph_agent_endpoint(input_data: RunAgentInput, request: Request):
        # Get the accept header from the request
        accept_header = request.headers.get("accept")

        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)

        # Clone the agent so each request gets its own isolated state.
        # LangGraphAgent stores per-request state in self.active_run; sharing a
        # single instance across concurrent requests corrupts that state.
        request_agent = agent.clone()

        async def event_generator():
            async for event in request_agent.run(input_data):
                yield encoder.encode(event)

        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type()
        )

    @app.get(f"{path.rstrip('/')}/health")
    def health():
        """Health check."""
        return {
            "status": "ok",
            "agent": {
                "name": agent.name,
            }
        }