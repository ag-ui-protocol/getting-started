import asyncio

from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.encoder import EventEncoder
from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunErrorEvent,
)

from ag_ui_agentspec.agent import AgentSpecAgent
from ag_ui_agentspec.agentspec_tracing_exporter import EVENT_QUEUE


def add_agentspec_fastapi_endpoint(
    app: FastAPI | APIRouter,
    agentspec_agent: AgentSpecAgent,
    path: str = "/",
    **kwargs: Any,
):
    """Adds an Agent Spec endpoint to the FastAPI app.

    Args:
        app: FastAPI application or APIRouter to register the route on.
        agentspec_agent: Agent Spec agent to serve.
        path: Path of the agent route.
        **kwargs: Forwarded to ``app.post`` (``name``, ``tags``,
            ``operation_id``, ``dependencies``, ``include_in_schema``, ...).
    """

    @app.post(path, **kwargs)
    async def agentic_chat_endpoint(input_data: RunAgentInput, request: Request):
        """Agentic chat endpoint"""

        # Get the accept header from the request
        accept_header = request.headers.get("accept")

        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)

        async def event_generator():
            queue = asyncio.Queue()
            # Bridge telemetry -> SSE by setting the per-request queue into ContextVar
            token = EVENT_QUEUE.set(queue)

            async def run_and_close():
                try:
                    # Run the agent; telemetry will emit events into the queue via ContextVar
                    await agentspec_agent.run(input_data)
                except Exception as e:  # pylint: disable=broad-exception-caught
                    # Forward errors as a RunErrorEvent so the client receives failure info
                    queue.put_nowait(
                        RunErrorEvent(message=repr(e))
                    )
                finally:
                    # Signal the stream to end after all events have been emitted
                    queue.put_nowait(None)

            try:
                # Important: create the task after setting the ContextVar so the new Task inherits it
                asyncio.create_task(run_and_close())

                while True:
                    item = await queue.get()
                    if item is None:
                        break

                    # Patch lifecycle events with canonical thread/run IDs for the frontend
                    if item.type == EventType.RUN_STARTED or item.type == EventType.RUN_FINISHED:
                        item.thread_id = input_data.thread_id
                        item.run_id = input_data.run_id

                    yield encoder.encode(item)

            except Exception as e:  # pylint: disable=broad-exception-caught
                yield encoder.encode(
                    RunErrorEvent(message=str(e))
                )
            finally:
                # Reset the ContextVar to avoid leaking queues across requests
                EVENT_QUEUE.reset(token)

        return StreamingResponse(event_generator(), media_type=encoder.get_content_type())
