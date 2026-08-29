# examples/other/context_usage.py

"""Example demonstrating AG-UI context usage in ADK agents.

This example shows how to access context data from AG-UI's RunAgentInput
via session state. Context is stored under the '_ag_ui_context' key
(CONTEXT_STATE_KEY) and is accessible in both:

1. Tools via tool_context.state[CONTEXT_STATE_KEY]
2. Instruction providers via ctx.state[CONTEXT_STATE_KEY]

Context is automatically passed through by the ADK middleware, following the
pattern established by LangGraph's context handling.

Alternative (ADK 1.22.0+):
For users on ADK 1.22.0 or later, context is also available via RunConfig:
    ctx.run_config.custom_metadata.get('ag_ui_context', [])

The session state approach is recommended as it works with all ADK versions.
"""

import asyncio
import logging
from typing import List

from google.adk.agents import LlmAgent
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools import ToolContext
from ag_ui_adk import ADKAgent, CONTEXT_STATE_KEY
from ag_ui.core import RunAgentInput, BaseEvent, UserMessage, Context

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# =============================================================================
# Access context in instruction provider via session state
# =============================================================================

def context_aware_instructions(ctx: ReadonlyContext) -> str:
    """Dynamic instruction provider that uses AG-UI context.

    Context is available via ctx.state[CONTEXT_STATE_KEY].
    Each context item has 'description' and 'value' keys.

    Args:
        ctx: The readonly context containing session state

    Returns:
        Dynamically generated instructions based on context
    """
    base_instructions = "You are a helpful assistant."

    # Access context from session state
    context_items = ctx.state.get(CONTEXT_STATE_KEY, [])
    if context_items:
        base_instructions += "\n\nAdditional context provided:"
        for item in context_items:
            base_instructions += f"\n- {item['description']}: {item['value']}"

    return base_instructions


# =============================================================================
# Access context in tools via session state
# =============================================================================

def get_user_preferences(tool_context: ToolContext) -> dict:
    """Tool that accesses AG-UI context from session state.

    Context is available via tool_context.state[CONTEXT_STATE_KEY].

    Args:
        tool_context: The tool context containing session state

    Returns:
        Dictionary of user preferences extracted from context
    """
    preferences = {}

    # Access context from session state using the constant
    context_items = tool_context.state.get(CONTEXT_STATE_KEY, [])

    for item in context_items:
        # Convert context items to preferences
        if item["description"] == "user_timezone":
            preferences["timezone"] = item["value"]
        elif item["description"] == "preferred_language":
            preferences["language"] = item["value"]
        elif item["description"] == "user_role":
            preferences["role"] = item["value"]

    return preferences


def personalized_greeting(tool_context: ToolContext) -> str:
    """Tool that generates a personalized greeting based on context.

    Args:
        tool_context: The tool context containing session state

    Returns:
        Personalized greeting string
    """
    prefs = get_user_preferences(tool_context)

    greeting = "Hello"
    if prefs.get("language") == "spanish":
        greeting = "Hola"
    elif prefs.get("language") == "french":
        greeting = "Bonjour"

    if prefs.get("role"):
        greeting += f", {prefs['role']}"

    return f"{greeting}! How can I assist you today?"


# =============================================================================
# Example Agent Setup
# =============================================================================

async def main():
    """Main function demonstrating context-aware agent usage."""

    # Create an ADK agent with context-aware instructions
    context_agent = LlmAgent(
        name="context_assistant",
        model="gemini-3.5-flash",
        instruction=context_aware_instructions,  # Callable instruction provider
        tools=[personalized_greeting]  # Tools can access context via state
    )

    # Create the middleware wrapper
    agent = ADKAgent(
        adk_agent=context_agent,
        user_id="demo_user",
    )

    # Create input with context
    run_input = RunAgentInput(
        thread_id="context_demo_thread",
        run_id="run_001",
        messages=[
            UserMessage(
                id="msg_001",
                role="user",
                content="Please greet me!"
            )
        ],
        context=[
            Context(description="user_timezone", value="America/New_York"),
            Context(description="preferred_language", value="spanish"),
            Context(description="user_role", value="Administrator"),
            Context(description="company_name", value="Acme Corp"),
        ],
        state={},
        tools=[],
        forwarded_props={}
    )

    # Run the agent
    print("Starting context-aware agent...")
    print("-" * 50)
    print("Context items:")
    for ctx in run_input.context:
        print(f"  - {ctx.description}: {ctx.value}")
    print("-" * 50)

    async for event in agent.run(run_input):
        handle_event(event)

    print("-" * 50)
    print("Demonstration complete!")

    await agent.close()


def handle_event(event: BaseEvent):
    """Handle and display AG-UI events."""
    event_type = event.type.value if hasattr(event.type, 'value') else str(event.type)

    if event_type == "RUN_STARTED":
        print("Agent run started")
    elif event_type == "RUN_FINISHED":
        print("Agent run finished")
    elif event_type == "RUN_ERROR":
        print(f"Error: {event.message}")
    elif event_type == "TEXT_MESSAGE_START":
        print("Assistant: ", end="", flush=True)
    elif event_type == "TEXT_MESSAGE_CONTENT":
        print(event.delta, end="", flush=True)
    elif event_type == "TEXT_MESSAGE_END":
        print()
    elif event_type == "STATE_SNAPSHOT":
        # Show that context is in state
        if hasattr(event, 'snapshot') and CONTEXT_STATE_KEY in event.snapshot:
            print(f"[State contains {CONTEXT_STATE_KEY}]")


if __name__ == "__main__":
    asyncio.run(main())
