"""Example: Agno Agent with Human-in-the-Loop

This example shows how an Agno Agent uses the generate_task_steps client tool
for human-in-the-loop interactions, exposed in an AG-UI compatible way.
"""

from agno.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.models.openai import OpenAIChat
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI

agent = Agent(
    db=InMemoryDb(),
    model=OpenAIChat(id="gpt-4o"),
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
