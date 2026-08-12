"""Dynamic system prompt — reply language driven by the AG-UI ``context`` channel.

The frontend sends a language choice in ``RunAgentInput.context`` and the SDK
rebuilds its instructions for that request.
"""

from __future__ import annotations

from agents import Agent, RunContextWrapper
from fastapi import FastAPI

from ag_ui.core import Context
from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint
from .constants import DEFAULT_MODEL

BASE_INSTRUCTIONS = (
    "You are a helpful, concise assistant. Answer the user's questions directly."
)

# Fallback when the frontend hasn't picked a language yet.
DEFAULT_LANGUAGE = "English"


def _read_language(ctx: RunContextWrapper[list[Context]]) -> str:
    """Pull the reply language out of the AG-UI context list.

    ``ctx.context`` here IS the raw ``list[Context]`` the client sent —
    each item a ``{description, value}`` pair, nothing wrapping it. We match
    the item whose description mentions "language" and use its value.
    """
    items = ctx.context or []
    for item in items:
        if "language" in (item.description or "").lower():
            return item.value or DEFAULT_LANGUAGE
    return DEFAULT_LANGUAGE


def dynamic_instructions(ctx: RunContextWrapper[list[Context]], agent: Agent) -> str:
    """Native SDK dynamic-instructions hook: build the prompt fresh each turn,
    baking in whatever language the frontend currently has selected."""
    language = _read_language(ctx)
    return (
        f"{BASE_INSTRUCTIONS}\n"
        f"Always reply in {language}, no matter what language the user writes in. "
        f"Every word of your response must be in {language}."
    )


def create_dynamic_system_prompt_agent() -> Agent:
    return Agent(
        name="multilingual_assistant",
        model=DEFAULT_MODEL,
        instructions=dynamic_instructions,
    )


agent = OpenAIAgentsAgent(create_dynamic_system_prompt_agent(), name="dynamic_system_prompt")
app = FastAPI(title="Dynamic system prompt AG-UI demo")
add_openai_agents_fastapi_endpoint(app, agent, "/")
