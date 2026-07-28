"""FastAPI endpoint helper for serving an OpenAI Agents SDK agent over AG-UI."""

import logging
import re
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent, RunStartedEvent
from ag_ui.encoder import EventEncoder
from .agent import OpenAIAgentsAgent

logger = logging.getLogger(__name__)


def add_openai_agents_fastapi_endpoint(
    app: FastAPI,
    agent: OpenAIAgentsAgent,
    path: str = "/",
    *,
    include_health: bool = True,
) -> None:
    """Add an OpenAI Agents SDK agent endpoint to a FastAPI app.

    Args:
        app: The FastAPI application to register the route on.
        agent: The wrapped agent to serve.
        path: The POST path for the agent. Defaults to "/".
        include_health: Whether to register a GET health check alongside the
            agent endpoint. Defaults to True.
    """
    # Unique per-route names/operation_ids so mounting several agents on one app
    # does not collide (FastAPI derives both from the handler __name__ otherwise,
    # producing duplicate operation ids and an ambiguous OpenAPI schema).
    slug = re.sub(r"\W+", "_", path).strip("_") or "root"
    # Guarantee uniqueness even if two mount paths normalize to the same slug
    # (e.g. "/a/b" and "/a_b"), so route names / operation ids never collide.
    used_slugs = getattr(app.state, "_openai_agents_slugs", None)
    if used_slugs is None:
        used_slugs = set()
        app.state._openai_agents_slugs = used_slugs
    base_slug, suffix = slug, 1
    while slug in used_slugs:
        slug = f"{base_slug}_{suffix}"
        suffix += 1
    used_slugs.add(slug)

    @app.post(path, name=f"openai_agents_run_{slug}", operation_id=f"openai_agents_run_{slug}")
    async def openai_agents_endpoint(
        input_data: RunAgentInput,
        request: Request,
    ) -> StreamingResponse:
        """Run the agent and stream AG-UI events back to the client."""
        logger.info(
            "Starting agent run: agent=%s thread_id=%s run_id=%s",
            agent.name,
            input_data.thread_id,
            input_data.run_id,
        )
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)

        async def event_generator() -> AsyncIterator[str]:
            started = False
            try:
                async for event in agent.run_streamed(input_data):
                    if event.type == EventType.RUN_STARTED:
                        started = True
                    yield encoder.encode(event)
            except Exception:
                # If the run never emitted RUN_STARTED it failed in setup (input
                # translation / clone / Runner.run_streamed) before to_agui ran, so
                # no lifecycle reached the client — an empty 200 otherwise. Emit a
                # minimal well-formed RUN_STARTED + RUN_ERROR — deliberately even
                # when emit_run_error=False, since a silent empty 200 the client
                # can't distinguish from success is worse than a terminal error at
                # the transport boundary. If the run DID start, to_agui already
                # handled the error per its emit_run_error config (possibly
                # deliberately silent), so add nothing — just log. Either way,
                # never sever the stream with an ASGI-level traceback.
                if not started:
                    yield encoder.encode(
                        RunStartedEvent(
                            type=EventType.RUN_STARTED,
                            thread_id=input_data.thread_id,
                            run_id=input_data.run_id,
                            # Preserve parent linkage for nested/branched runs,
                            # matching the normal to_agui RUN_STARTED path.
                            parent_run_id=getattr(input_data, "parent_run_id", None),
                        )
                    )
                    yield encoder.encode(
                        RunErrorEvent(type=EventType.RUN_ERROR, message="Agent run failed")
                    )
                logger.exception(
                    "Agent run failed: agent=%s run_id=%s",
                    agent.name,
                    input_data.run_id,
                )

        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type(),
        )

    if include_health:

        @app.get(
            path.rstrip("/") + "/health",
            name=f"openai_agents_health_{slug}",
            operation_id=f"openai_agents_health_{slug}",
        )
        def health():
            """Health check."""
            return {"status": "ok", "agent": {"name": agent.name}}
