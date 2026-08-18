"""Human-in-the-Loop example using AG2 with AG-UI protocol.

The `generate_task_steps` tool is executed on the frontend (HITL): the agent
sends suggested steps to the UI, the user selects which steps to run, and the
result is sent back to the agent. The tool arrives in `RunAgentInput.tools`
and AGUIStream forwards it to the agent automatically.
See: https://docs.ag2.ai/latest/docs/user-guide/ag-ui/
"""

from textwrap import dedent

from fastapi import FastAPI
from ag2 import Agent
from ag2.ag_ui import AGUIStream
from ag2.config import OpenAIConfig

agent = Agent(
    name="hitl_planner",
    prompt=dedent("""
        You are a collaborative planning assistant.
        When planning tasks use tools only, without any other messages.
        IMPORTANT:
        - Use the `generate_task_steps` tool to display the suggested steps to the user
        - Do not call the `generate_task_steps` twice in a row, ever.
        - Never repeat the plan, or send a message detailing steps
        - If accepted, confirm the creation of the plan and the number of selected (enabled) steps only
        - If not accepted, ask the user for more information, DO NOT use the `generate_task_steps` tool again
    """),
    config=OpenAIConfig(model="gpt-4o-mini"),
)

stream = AGUIStream(agent)
human_in_the_loop_app = FastAPI()
human_in_the_loop_app.mount("", stream.build_asgi())
