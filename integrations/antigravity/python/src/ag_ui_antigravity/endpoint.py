"""FastAPI wiring for :class:`AntigravityAgent`.

Wire format matches the rest of the AG-UI Python integrations exactly:
``data: {json}\\n\\n`` with camelCase aliases and ``None`` fields omitted.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional, Union

from ag_ui.core import RunAgentInput, RunErrorEvent
from google.antigravity import types as ag_types
from fastapi import FastAPI
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

from .agent import AntigravityAgent

logger = logging.getLogger(__name__)


def _encode(event: Any) -> str:
    return event.model_dump_json(by_alias=True, exclude_none=True)


def _sse(raw: str, *, event: Optional[str] = None) -> ServerSentEvent:
    """Frames pre-serialized JSON as ``data: {json}\\n\\n`` without re-encoding."""
    if event is None:
        return ServerSentEvent(data=raw, sep="\n")
    return ServerSentEvent(data=raw, event=event, sep="\n")


async def _stream(agent: AntigravityAgent, input_data: RunAgentInput):
    try:
        async for event in agent.run(input_data):
            try:
                yield _sse(_encode(event))
            except Exception as encoding_error:
                logger.error("Event encoding error: %s", encoding_error, exc_info=True)
                yield _sse(
                    _encode(
                        RunErrorEvent(
                            type="RUN_ERROR",
                            message=f"Event encoding failed: {encoding_error}",
                            code="ENCODING_ERROR",
                        )
                    )
                )
                return
    except Exception as agent_error:
        logger.error("AntigravityAgent error: %s", agent_error, exc_info=True)
        try:
            yield _sse(
                _encode(
                    RunErrorEvent(
                        type="RUN_ERROR",
                        message=f"Agent execution failed: {agent_error}",
                        code="AGENT_ERROR",
                    )
                )
            )
        except Exception:  # pragma: no cover
            yield _sse('{"error": "Agent execution failed"}', event="error")


def default_capabilities(agent: AntigravityAgent) -> Dict[str, Any]:
    """Describes this integration in AG-UI's ``AgentCapabilities`` shape.

    The payload must validate against ``AgentCapabilitiesSchema`` -- the
    TypeScript client parses it strictly and throws otherwise, so the keys here
    are the schema's nested category objects, not loose booleans.
    """
    return {
        "identity": {
            "type": "antigravity",
            "description": "Google Antigravity agent exposed over AG-UI.",
        },
        "transport": {"streaming": True},
        "tools": {
            "supported": True,
            "parallelCalls": True,
            # Client tools become real Antigravity custom tools.
            "clientProvided": agent._enable_frontend_tools,
        },
        "output": {"structuredOutput": agent._response_schema is not None},
        "state": {
            # FINISH.structured_output drives the snapshot, and the harness
            # only populates it when a response_schema was configured.
            "snapshots": (
                agent._structured_output_as == "state"
                and agent._response_schema is not None
            ),
            "deltas": False,
            # History lives in the long-running harness process, keyed by thread.
            "persistentState": True,
        },
        "reasoning": {"supported": True, "streaming": True},
        "execution": {
            # The Go harness runs real shell commands on the host -- but only
            # when run_command survives the capability config.
            "codeExecution": agent.builtin_enabled(ag_types.BuiltinTools.RUN_COMMAND),
            "sandboxed": False,
        },
        "humanInTheLoop": {
            # Only true if some HITL channel actually exists.
            "supported": (
                agent._enable_frontend_tools
                or agent.ask_question_reachable
                or agent._tool_approval
            ),
            "approvals": agent._tool_approval,
            # Only advertise interrupts the client could actually receive:
            # the ask_question built-in can be switched off by capabilities.
            "interrupts": agent.ask_question_reachable or agent._tool_approval,
            "interventions": agent._enable_frontend_tools,
        },
    }


def add_antigravity_fastapi_endpoint(
    app: FastAPI,
    agent: Union[AntigravityAgent, Dict[str, AntigravityAgent]],
    path: str = "/",
    *,
    capabilities: Optional[Dict[str, Any]] = None,
) -> None:
    """Mounts an AG-UI endpoint (plus ``<path>/capabilities``) on ``app``.

    Args:
      app: The FastAPI application.
      agent: A single agent, or a mapping of sub-path -> agent so one server can
        expose several demo agents (``/agentic_chat``, ``/human_in_the_loop``…).
      path: Mount point.
      capabilities: Payload served at ``<path>/capabilities``.
    """
    base = "/" + path.strip("/") if path.strip("/") else ""
    agents: Dict[str, AntigravityAgent] = (
        agent if isinstance(agent, dict) else {"": agent}
    )

    for sub_path, sub_agent in agents.items():
        route = f"{base}/{sub_path.strip('/')}" if sub_path.strip("/") else base or "/"
        _register(app, route, sub_agent, capabilities)


def _register(
    app: FastAPI,
    route: str,
    agent: AntigravityAgent,
    capabilities: Optional[Dict[str, Any]],
) -> None:
    async def run_endpoint(input_data: RunAgentInput):
        return EventSourceResponse(_stream(agent, input_data))

    async def capabilities_endpoint():
        return capabilities or default_capabilities(agent)

    app.post(route)(run_endpoint)
    app.get(f"{route.rstrip('/')}/capabilities")(capabilities_endpoint)


def create_antigravity_app(
    agent: Union[AntigravityAgent, Dict[str, AntigravityAgent]],
    path: str = "/",
    **kwargs: Any,
) -> FastAPI:
    """Creates a FastAPI app serving ``agent``."""
    targets = list(agent.values()) if isinstance(agent, dict) else [agent]

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        for target in targets:
            await target.close()

    app = FastAPI(title="AG-UI Antigravity Integration", lifespan=lifespan)
    add_antigravity_fastapi_endpoint(app, agent, path, **kwargs)
    return app
