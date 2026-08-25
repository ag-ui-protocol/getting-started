"""Agentic Chat with Reasoning — Uses reasoning models (o4-mini) that show their thinking process."""

from agno.agent.agent import Agent
from agno.models.openai import OpenAIResponses
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI

# o4-mini is a reasoning model that exposes its thinking process via reasoning tokens
# Use OpenAIResponses with reasoning_effort + agent reasoning=True to emit reasoning events
agent = Agent(
    model=OpenAIResponses(
        id="o4-mini",
        reasoning_effort="high",
        reasoning_summary="auto",
    ),
    reasoning=True,
    description="You are a helpful AI assistant with deep reasoning capabilities.",
    instructions=[
        "Think step by step through complex problems.",
        "Explain your reasoning clearly.",
    ],
    markdown=True,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
