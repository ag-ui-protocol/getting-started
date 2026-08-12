"""Tool-based generative UI — frontend tool renders the content.

Like :mod:`human_in_the_loop`, the tool (``generate_haiku``) is *client*-owned:
it arrives per-request in ``RunAgentInput.tools``, gets wrapped into an SDK
``FunctionTool`` proxy, and ``StopAtTools`` ends the run the moment the model
calls it. The difference is intent: here the tool call *is* the deliverable —
the frontend renders the haiku card from the streamed ``TOOL_CALL_ARGS``,
no approval round-trip expected.
"""

from __future__ import annotations

from agents import Agent, StopAtTools
from fastapi import FastAPI

from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint
from .constants import DEFAULT_MODEL

# Must match the AG-UI client tool name the frontend declares in
# RunAgentInput.tools for this demo.
FRONTEND_TOOL_NAME = "generate_haiku"

INSTRUCTIONS = """You are a creative writing assistant that renders haikus with a UI component.

When the user asks for a haiku:
1. Immediately call the `generate_haiku` tool with the haiku data
   (Japanese lines, English lines, and any other fields the tool declares).
2. Do NOT write the haiku as plain text — the frontend renders it.

For non-creative requests, respond normally without the tool.
"""


def create_tool_based_generative_ui_agent() -> Agent:
    return Agent(
        name="haiku_assistant",
        model=DEFAULT_MODEL,
        instructions=INSTRUCTIONS,
        tool_use_behavior=StopAtTools(stop_at_tool_names=[FRONTEND_TOOL_NAME]),
    )


agent = OpenAIAgentsAgent(
    create_tool_based_generative_ui_agent(), name="tool_based_generative_ui"
)
app = FastAPI(title="Tool-based generative UI AG-UI demo")
add_openai_agents_fastapi_endpoint(app, agent, "/")
