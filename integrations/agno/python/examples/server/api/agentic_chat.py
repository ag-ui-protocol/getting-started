"""Example: Agno Agent with Finance tools

This example shows how to create an Agno Agent with tools (YFinanceTools) and expose it in an AG-UI compatible way.
"""

from agno.agent.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.models.openai import OpenAIChat
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI
from agno.tools import tool
from agno.tools.yfinance import YFinanceTools


@tool(external_execution=True)
def change_background(background: str) -> str:  # pylint: disable=unused-argument
    """
    Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.

    Args:
        background: str: The background color to change to. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.
    """  # pylint: disable=line-too-long


agent = Agent(
    db=InMemoryDb(),
    model=OpenAIChat(id="gpt-4o"),
    tools=[
        YFinanceTools(),
        change_background,
    ],
    description="You are an investment analyst that researches stock prices, analyst recommendations, and stock fundamentals.",
    instructions="Format your response using markdown and use tables to display data where possible.",
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
