"""Agentic Generative UI — Task steps generator that streams tool arguments to frontend."""

from typing import List

from agno.agent.agent import Agent
from agno.models.openai import OpenAIChat
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI
from agno.tools import tool
from pydantic import BaseModel, Field


class Step(BaseModel):
    description: str = Field(description="The text of the step in gerund form")
    status: str = Field(description="The status of the step", default="pending")


@tool(external_execution=True)
def generate_task_steps_generative_ui(steps: List[Step]) -> str:
    """Generate steps required for a task. Each step should be in gerund form (e.g., 'Digging hole', 'Opening door').

    Args:
        steps: An array of 10 step objects, each containing description and status
    """


agent = Agent(
    model=OpenAIChat(id="gpt-4o"),
    tools=[generate_task_steps_generative_ui],
    description="You are a helpful assistant that breaks down tasks into steps.",
    instructions=[
        "When asked to do something, you MUST call the generate_task_steps_generative_ui function.",
        "Generate exactly 10 steps for the task.",
        "Each step should be in gerund form (e.g., 'Analyzing requirements', 'Setting up environment').",
        "After calling the function, give a brief one-sentence summary with some emojis.",
        "Do NOT repeat the steps in your response.",
    ],
    markdown=True,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
