"""FastAPI endpoint helper."""

from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder

from .agent import ManagedAgentsAgent


def add_managed_agents_fastapi_endpoint(
    app: FastAPI | APIRouter,
    agent: ManagedAgentsAgent,
    path: str = "/",
    **kwargs: Any,
) -> None:
    """Add a Managed Agents endpoint to the FastAPI app.

    POST `path` runs one turn and streams the encoded AG-UI events. Closing
    the response (a client disconnect) cancels the run, which interrupts the
    managed session. GET `{path}/health` is a liveness probe and deliberately
    says nothing else: it is reachable by whoever can reach the endpoint, and
    the managed agent id it used to return is an internal identifier probes have
    no use for.

    Args:
        app: FastAPI application or APIRouter to register the routes on.
        agent: Managed Agents agent to serve.
        path: Path of the agent route.
        **kwargs: Forwarded to ``app.post`` for the agent route (``name``,
            ``tags``, ``operation_id``, ``dependencies``, ``include_in_schema``,
            ...). They do not apply to the other routes this helper registers,
            because values such as ``operation_id`` and ``name`` must stay
            unique per operation.
    """

    @app.post(path, **kwargs)
    async def managed_agents_endpoint(input_data: RunAgentInput, request: Request):
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)

        async def event_generator():
            async for event in agent.run(input_data):
                yield encoder.encode(event)

        return StreamingResponse(
            event_generator(), media_type=encoder.get_content_type()
        )

    @app.get(f"{path.rstrip('/')}/health")
    def health():
        """Liveness probe. Returns no identifiers: see the note above."""
        return {"status": "ok"}
