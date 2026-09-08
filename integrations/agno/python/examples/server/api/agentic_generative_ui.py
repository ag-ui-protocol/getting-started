"""Agentic Generative UI — Task steps generator that streams state to frontend."""

from agno.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.models.openai import OpenAIChat
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI

agent = Agent(
    db=InMemoryDb(),
    model=OpenAIChat(id="gpt-4o"),
    session_state={"steps": []},
    add_session_state_to_context=True,
    enable_agentic_state=True,
    description="You are a helpful assistant that breaks down tasks into steps.",
    instructions=[
        "When asked to do something, you MUST use update_session_state to populate the steps array.",
        'session_state_updates must have exactly one top-level key: "steps".',
        (
            'The "steps" value must always be the complete list of step objects. '
            "update_session_state replaces the whole list on every call. Never send a partial steps list. "
            "Copy every unchanged step and change only the step whose status moves."
        ),
        "Generate exactly 10 steps unless the user asks for a different number.",
        "Each step should be in gerund form (e.g., 'Analyzing requirements', 'Setting up environment').",
        (
            'Each step object must contain "description" and "status"; '
            'status must be one of "pending", "in_progress", or "completed".'
        ),
        (
            'First write every step as "pending". Then walk the steps in order: '
            'write the full list with the current step set to "in_progress"; '
            'on the next write set that step to "completed" and the following step to "in_progress". '
            'Finish by writing the full list with the last step set to "completed".'
        ),
        "After the last step is completed, give a brief one-sentence summary with some emojis.",
        "Do NOT repeat the steps in your response.",
    ],
    markdown=True,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
