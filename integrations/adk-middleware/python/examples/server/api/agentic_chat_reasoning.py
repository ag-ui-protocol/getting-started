"""Agentic Chat with Reasoning (Thinking) feature.

Demonstrates REASONING_* events emitted when Gemini's include_thoughts
is enabled, including encrypted thought signatures.
"""

from __future__ import annotations

from fastapi import FastAPI
from ag_ui_adk import ADKAgent, AGUIToolset, add_adk_fastapi_endpoint
from google.adk.agents import LlmAgent
from google.adk.planners import BuiltInPlanner
from google.genai import types

# Create a reasoning-enabled ADK agent using Gemini 2.5 Flash
reasoning_agent = LlmAgent(
    name="reasoning_assistant",
    model="gemini-3.5-flash",
    instruction="""You are a helpful assistant that thinks carefully before responding.
    Work through problems step by step in your reasoning.
    """,
    planner=BuiltInPlanner(
        thinking_config=types.ThinkingConfig(
            include_thoughts=True
        )
    ),
    tools=[
        AGUIToolset(),
    ],
)

# Create ADK middleware agent instance
chat_agent = ADKAgent(
    adk_agent=reasoning_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

# Create FastAPI app
app = FastAPI(title="ADK Middleware Reasoning Chat")

# Add the ADK endpoint
add_adk_fastapi_endpoint(app, chat_agent, path="/")
