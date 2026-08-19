"""Tool Based Generative UI feature.

The `generate_haiku` tool is defined by the frontend and arrives in
`RunAgentInput.tools`; AGUIStream forwards it to the agent automatically,
so no special handling is required for this feature.
"""

from fastapi import FastAPI
from ag2 import Agent
from ag2.ag_ui import AGUIStream
from ag2.config import OpenAIConfig

agent = Agent(
    name="haiku_bot",
    config=OpenAIConfig(model="gpt-4o-mini"),
)

stream = AGUIStream(agent)
tool_based_generative_ui_app = FastAPI()
tool_based_generative_ui_app.mount("", stream.build_asgi())
