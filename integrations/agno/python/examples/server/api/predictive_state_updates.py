"""Predictive State Updates — Document writer that streams content to frontend state.

Uses enable_agentic_state=True for the LLM to update the document state.
The AG-UI protocol streams state snapshots on every change, so the frontend
sees the document being written in real-time.
"""

from agno.agent.agent import Agent
from agno.models.openai import OpenAIChat
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI

agent = Agent(
    model=OpenAIChat(id="gpt-4o"),
    session_state={"document": ""},
    add_session_state_to_context=True,
    enable_agentic_state=True,
    instructions="""You are a helpful assistant for writing documents.

The current document is shown in <session_state> under the "document" key.

Use update_session_state to write or modify the document:
- Set the "document" key to the full document content
- Use markdown formatting extensively
- You MUST write the full document, even when changing only a few words
- When making edits, try to make them minimal - do not change every word
- Keep stories SHORT!

After writing, DO NOT repeat the document as a message.
Just briefly summarize the changes you made in 2 sentences max.""",
    markdown=False,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
