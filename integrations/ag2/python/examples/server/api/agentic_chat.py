"""Agentic Chat example using AG2 with AG-UI protocol.

Exposes an Agent via AGUIStream for the AG-UI Dojo.
See: https://docs.ag2.ai/latest/docs/user-guide/ag-ui/
"""

from fastapi import FastAPI
from ag2 import Agent
from ag2.ag_ui import AGUIStream
from ag2.config import OpenAIConfig

agent = Agent(
    name="support_bot",
    prompt="You are a helpful assistant. You answer product questions and help users.",
    config=OpenAIConfig(model="gpt-4o-mini"),
)

stream = AGUIStream(agent)
agentic_chat_app = FastAPI()
agentic_chat_app.mount("", stream.build_asgi())
