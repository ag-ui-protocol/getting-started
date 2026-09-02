"""Example: Agno Agent with Human-in-the-Loop

This example shows how to create an Agno Agent with a generate_task_steps tool
for human-in-the-loop interactions, exposed in an AG-UI compatible way.
"""

from typing import List, Literal

from agno.agent.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.models.openai import OpenAIChat
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI
from agno.tools import tool
from pydantic import BaseModel, Field


class Step(BaseModel):
    """A single step in a task plan."""

    description: str = Field(..., description="A brief description of the step")
    status: Literal["enabled", "disabled", "executing"] = Field(
        default="enabled",
        description="The status of the step",
    )


@tool(external_execution=True)
def generate_task_steps(
    steps: List[Step],
) -> str:  # pylint: disable=unused-argument
    """Generate a list of steps for the user to review and approve.

    This tool creates a task plan that will be displayed to the user for review.
    The user can enable/disable steps before confirming execution.

    Args:
        steps: A list of 10 step objects, each containing a description and status.
               Each step should be brief (a few words) and in imperative form
               (e.g., "Dig hole", "Open door", "Mix ingredients").

    Returns:
        A confirmation message.
    """
    return f"Generated {len(steps)} steps for user review"


agent = Agent(
    db=InMemoryDb(),
    model=OpenAIChat(id="gpt-4o"),
    tools=[generate_task_steps],
    description="You are a helpful task planning assistant that helps break down complex tasks into manageable steps.",
    instructions="""
    You are a task planning assistant specialized in creating clear, actionable step-by-step plans.

    **Your Primary Role:**
    - Break down any user request into exactly 10 clear, actionable steps
    - Generate steps that require human review and approval
    - Execute only human-approved steps

    **When a user requests help with a task:**
    1. ALWAYS use the `generate_task_steps` tool to create a 10-step breakdown
    2. Each step must be:
       - Brief (only a few words)
       - In imperative form (e.g., "Dig hole", "Open door", "Mix ingredients")
       - Clear and actionable
       - Logically ordered from start to finish
    3. Set all steps to "enabled" status initially
    4. After the user reviews the plan:
       - If accepted: Briefly confirm the plan and proceed (don't repeat the steps)
       - If rejected: Ask what they'd like to change (don't call generate_task_steps again until they provide input)

    **Important:**
    - NEVER call `generate_task_steps` twice in a row without user input
    - NEVER repeat the list of steps in your response after calling the tool
    - DO provide a brief, creative summary of how you would execute the approved steps
    """,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
