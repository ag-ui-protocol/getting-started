"""Human-in-the-loop — a *frontend*-owned tool, approved before execution.

Unlike :mod:`backend_tool_rendering`, ``generate_task_steps`` has no server
implementation — it arrives per-request as an AG-UI client tool
(``RunAgentInput.tools``), gets wrapped into an SDK ``FunctionTool`` proxy by
``AGUIToOpenAITranslator.translate_tools()``, and is merged onto this agent by
the run loop (see ``server.py``).

``tool_use_behavior=StopAtTools(...)`` is the SDK's built-in for "the model
may only *call* this tool, never execute it": the run ends the moment the
model emits the call, before the (dead-code) proxy body would ever run. The
frontend renders the steps for user approval, then sends the result back as
an AG-UI ``ToolMessage`` in the *next* request — ordinary multi-turn history,
no custom pause/resume machinery needed.
"""

from __future__ import annotations

from agents import Agent, StopAtTools
from fastapi import FastAPI

from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint
from .constants import DEFAULT_MODEL

# Must match the AG-UI client tool name the frontend declares in
# RunAgentInput.tools for this demo.
FRONTEND_TOOL_NAME = "generate_task_steps"

INSTRUCTIONS = """You are a task planning assistant that breaks work into clear, actionable steps.

When the user asks for help with a task:
1. Immediately call the `generate_task_steps` tool with an array of steps.
   Each step is an object: {"description": "...", "status": "enabled"}.
2. Do not restate the steps as plain text — the frontend renders them.
3. After the call, wait for the user to approve/select steps; do not call
   the tool again until they respond.
"""


def create_human_in_the_loop_agent() -> Agent:
    return Agent(
        name="task_planner",
        model=DEFAULT_MODEL,
        instructions=INSTRUCTIONS,
        tool_use_behavior=StopAtTools(stop_at_tool_names=[FRONTEND_TOOL_NAME]),
    )


agent = OpenAIAgentsAgent(create_human_in_the_loop_agent(), name="human_in_the_loop")
app = FastAPI(title="Human in the loop AG-UI demo")
add_openai_agents_fastapi_endpoint(app, agent, "/")
