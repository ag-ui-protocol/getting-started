"""Example: Tool-based Generative UI Agent

This example shows how to create an Agno Agent that uses the generate_haiku client
tool, exposed in an AG-UI compatible way.
"""

from agno.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.models.openai import OpenAIChat
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI

agent = Agent(
    db=InMemoryDb(),
    model=OpenAIChat(id="gpt-4o"),
    description="Help the user with writing Haikus. If the user asks for a haiku, use the generate_haiku tool to display the haiku to the user.",
    debug_mode=True,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
