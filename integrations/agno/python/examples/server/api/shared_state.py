"""Shared State — Recipe assistant that syncs state with the frontend via AG-UI.

Uses enable_agentic_state=True which provides a generic update_session_state tool
that the LLM uses to modify the recipe state. The AG-UI protocol streams state
snapshots to the frontend on every change.
"""

from agno.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.models.openai import OpenAIChat
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI

agent = Agent(
    db=InMemoryDb(),
    model=OpenAIChat(id="gpt-4o"),
    session_state={},
    add_session_state_to_context=True,
    enable_agentic_state=True,
    instructions="""You are a recipe assistant that helps users create and modify recipes.

The current recipe state is shown in <session_state>. Use it to understand what exists.

Use update_session_state to modify the recipe. session_state_updates must have exactly one top-level key: "recipe".
The nested recipe value must be the complete recipe object with all of these fields:
- "title": Recipe name
- "skill_level": "Beginner", "Intermediate", or "Advanced"
- "cooking_time": "5 min", "15 min", "30 min", "45 min", or "60+ min"
- "special_preferences": List like "High Protein", "Low Carb", "Spicy", "Budget-Friendly", "One-Pot Meal", "Vegetarian", "Vegan"
- "ingredients": List of {name, amount, icon} objects. Use emoji icons like 🥕 🧅 🥚 🌾 🧈 🥛
- "instructions": List of cooking step strings

Never send recipe fields at the top level. Never send a partial recipe object.
Copy every unchanged field from the current recipe and change only the requested values.
After updating, briefly summarize the changes in one sentence.""",
    markdown=False,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])

app = agent_os.get_app()
