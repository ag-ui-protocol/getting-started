"""Agentic Chat Multimodal example using AG2 with AG-UI protocol.

Accepts image attachments: AG-UI multimodal content parts arrive in the run
input and are mapped to the agent's multimodal inputs, so a vision-capable
model can describe uploaded images.
"""

from fastapi import FastAPI
from ag2 import Agent
from ag2.ag_ui import AGUIStream
from ag2.config import OpenAIConfig

agent = Agent(
    name="multimodal_bot",
    prompt="You are a helpful assistant. When the user uploads images, describe and analyze them accurately.",
    config=OpenAIConfig(model="gpt-4o-mini"),
)

stream = AGUIStream(agent)
agentic_chat_multimodal_app = FastAPI()
agentic_chat_multimodal_app.mount("", stream.build_asgi())
