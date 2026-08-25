"""Agentic Chat Multimodal — Accepts images, audio, video, and documents."""

from agno.agent.agent import Agent
from agno.models.google import Gemini
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI

agent = Agent(
    model=Gemini(id="gemini-2.5-flash"),
    description="You are a helpful assistant that can analyze images, audio, video, and documents.",
    instructions=[
        "Analyze any media the user sends and answer their questions about it.",
        "Be descriptive when analyzing visual content.",
        "If the user sends multiple files, analyze each one.",
    ],
    markdown=True,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
