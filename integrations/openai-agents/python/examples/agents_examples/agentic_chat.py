"""Agentic chat — plain conversation, no tools."""

from __future__ import annotations

from agents import Agent
from fastapi import FastAPI

from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint
from .constants import DEFAULT_MODEL


def create_agentic_chat_agent() -> Agent:
    return Agent(
        name="assistant",
        model=DEFAULT_MODEL,
        instructions="You are a helpful assistant. Be concise.",
    )


agent = OpenAIAgentsAgent(create_agentic_chat_agent(), name="agentic_chat")
app = FastAPI(title="Agentic chat AG-UI demo")
add_openai_agents_fastapi_endpoint(app, agent, "/")
