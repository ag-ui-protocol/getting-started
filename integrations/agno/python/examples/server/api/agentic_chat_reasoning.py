"""Agentic Chat with Reasoning.

Uses o4-mini to expose its thinking process.
"""

from agno.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.models.openai import OpenAIResponses
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI

agent = Agent(
    db=InMemoryDb(),
    model=OpenAIResponses(id="o4-mini"),
    reasoning_model=OpenAIResponses(
        id="o4-mini",
        reasoning_effort="high",
        reasoning_summary="auto",
    ),
    description="You are a helpful AI assistant with deep reasoning capabilities.",
    instructions=[
        "Think step by step through complex problems.",
        "Explain your reasoning clearly.",
    ],
    markdown=True,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
