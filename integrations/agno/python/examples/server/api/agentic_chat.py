"""Example: Agno Agent with Finance tools

This example shows how to create an Agno Agent with tools (YFinanceTools) and expose it in an AG-UI compatible way.
Frontend tools such as change_background arrive as AG-UI client tools, so the agent does not declare them itself.
"""

from agno.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.models.openai import OpenAIChat
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI
from agno.tools.yfinance import YFinanceTools

agent = Agent(
    db=InMemoryDb(),
    model=OpenAIChat(id="gpt-4o"),
    tools=[
        YFinanceTools(),
    ],
    description="You are an investment analyst that researches stock prices, analyst recommendations, and stock fundamentals.",
    instructions="Format your response using markdown and use tables to display data where possible.",
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
