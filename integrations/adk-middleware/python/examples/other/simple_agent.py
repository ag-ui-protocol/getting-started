# examples/simple_agent.py

"""Simple example of using ADK middleware with AG-UI protocol.

This example demonstrates the basic setup and usage of the ADK middleware
for a simple conversational agent.
"""

import asyncio
import logging
from typing import AsyncGenerator

from ag_ui_adk import ADKAgent, AgentRegistry
from google.adk.agents import LlmAgent
from ag_ui.core import RunAgentInput, BaseEvent, Message, UserMessage, Context

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def main():
    """Main function demonstrating simple agent usage."""

    # Step 1: Create an ADK agent
    simple_adk_agent = LlmAgent(
        name="assistant",
        model="gemini-3.5-flash",
        instruction="You are a helpful AI assistant. Be concise and friendly."
    )

    # Step 2: Register the agent
    registry = AgentRegistry.get_instance()
    registry.set_default_agent(simple_adk_agent)

    # Step 3: Create the middleware agent
    # Note: app_name will default to the agent name ("assistant")
    agent = ADKAgent(
        user_id="demo_user",  # Static user for this example
    )

    # Step 4: Create a sample input
    run_input = RunAgentInput(
        thread_id="demo_thread_001",
        run_id="run_001",
        messages=[
            UserMessage(
                id="msg_001",
                role="user",
                content="Hello! Can you tell me about the weather?"
            )
        ],
        context=[
            Context(description="demo_mode", value="true")
        ],
        state={},
        tools=[],
        forwarded_props={}
    )

    # Step 5: Run the agent and print events
    print("Starting agent conversation...")
    print("-" * 50)

    async for event in agent.run(run_input):
        handle_event(event)

    print("-" * 50)
    print("Conversation complete!")

    # Cleanup
    await agent.close()


def handle_event(event: BaseEvent):
    """Handle and display AG-UI events."""
    event_type = event.type.value if hasattr(event.type, 'value') else str(event.type)

    if event_type == "RUN_STARTED":
        print("🚀 Agent run started")
    elif event_type == "RUN_FINISHED":
        print("✅ Agent run finished")
    elif event_type == "RUN_ERROR":
        print(f"❌ Error: {event.message}")
    elif event_type == "TEXT_MESSAGE_START":
        print("💬 Assistant: ", end="", flush=True)
    elif event_type == "TEXT_MESSAGE_CONTENT":
        print(event.delta, end="", flush=True)
    elif event_type == "TEXT_MESSAGE_END":
        print()  # New line after message
    elif event_type == "TEXT_MESSAGE_CONTENT":
        print(f"💬 Assistant: {event.delta}")
    else:
        print(f"📋 Event: {event_type}")


async def advanced_example():
    """Advanced example with multiple messages and state."""

    # Create a more sophisticated agent
    advanced_agent = LlmAgent(
        name="research_assistant",
        model="gemini-3.5-flash",
        instruction="""You are a research assistant.
        Keep track of topics the user is interested in.
        Be thorough but well-organized in your responses."""
    )

    # Register with a specific ID
    registry = AgentRegistry.get_instance()
    registry.register_agent("researcher", advanced_agent)

    # Create middleware with custom user extraction
    def extract_user_from_context(input: RunAgentInput) -> str:
        for ctx in input.context:
            if ctx.description == "user_email":
                return ctx.value.split("@")[0]  # Use email prefix as user ID
        return "anonymous"

    agent = ADKAgent(
        user_id_extractor=extract_user_from_context,
        # app_name will default to the agent name ("research_assistant")
    )

    # Simulate a conversation with history
    messages = [
        UserMessage(id="1", role="user", content="I'm interested in quantum computing"),
        # In a real scenario, you'd have assistant responses here
        UserMessage(id="2", role="user", content="Can you explain quantum entanglement?")
    ]

    run_input = RunAgentInput(
        thread_id="research_thread_001",
        run_id="run_002",
        messages=messages,
        context=[
            Context(description="user_email", value="researcher@example.com"),
            Context(description="agent_id", value="researcher")
        ],
        state={"topics_of_interest": ["quantum computing"]},
        tools=[],
        forwarded_props={}
    )

    print("\nAdvanced Example - Research Assistant")
    print("=" * 50)

    async for event in agent.run(run_input):
        handle_event(event)

    await agent.close()


if __name__ == "__main__":
    # Run the simple example
    asyncio.run(main())

    # Uncomment to run the advanced example
    # asyncio.run(advanced_example())