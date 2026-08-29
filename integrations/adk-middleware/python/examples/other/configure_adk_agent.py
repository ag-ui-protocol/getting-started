#!/usr/bin/env python
"""Example of configuring and registering Google ADK agents."""

import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# from agent_registry import AgentRegistry
from ag_ui_adk import AgentRegistry
from google.adk.agents import Agent
from google.adk.tools import Tool
from google.genai import types

# Example 1: Simple conversational agent
def create_simple_agent():
    """Create a basic conversational agent."""
    agent = Agent(
        name="simple_assistant",
        instruction="""You are a helpful AI assistant.
        Be concise and friendly in your responses.
        If you don't know something, say so honestly."""
    )
    return agent


# Example 2: Agent with specific model configuration
def create_configured_agent():
    """Create an agent with specific model settings."""
    agent = Agent(
        name="advanced_assistant",
        model="gemini-3.5-flash",
        instruction="""You are an expert technical assistant.
        Provide detailed, accurate technical information.
        Use examples when explaining complex concepts.""",
        # Optional: Add generation config
        generation_config=types.GenerationConfig(
            temperature=0.7,
            top_p=0.95,
            top_k=40,
            max_output_tokens=2048,
        )
    )
    return agent


# Example 3: Agent with tools
def create_agent_with_tools():
    """Create an agent with custom tools."""

    # Define a simple tool
    def get_current_time():
        """Get the current time."""
        from datetime import datetime
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def calculate(expression: str):
        """Safely evaluate a mathematical expression."""
        try:
            # In production, use a proper math parser
            result = eval(expression, {"__builtins__": {}}, {})
            return f"Result: {result}"
        except Exception as e:
            return f"Error: {str(e)}"

    # Create tools
    time_tool = Tool(
        name="get_time",
        description="Get the current date and time",
        func=get_current_time
    )

    calc_tool = Tool(
        name="calculator",
        description="Calculate mathematical expressions",
        func=calculate
    )

    # Create agent with tools
    agent = Agent(
        name="assistant_with_tools",
        instruction="""You are a helpful assistant with access to tools.
        Use the get_time tool when asked about the current time or date.
        Use the calculator tool for mathematical calculations.""",
        tools=[time_tool, calc_tool]
    )
    return agent


# Example 4: Domain-specific agent
def create_domain_agent():
    """Create a domain-specific agent (e.g., for customer support)."""
    agent = Agent(
        name="support_agent",
        instruction="""You are a customer support specialist.

        Your responsibilities:
        1. Help users troubleshoot technical issues
        2. Provide information about products and services
        3. Escalate complex issues when needed

        Always:
        - Be empathetic and patient
        - Ask clarifying questions
        - Provide step-by-step solutions
        - Follow up to ensure issues are resolved""",
        model="gemini-2.5-pro",
    )
    return agent


# Example 5: Multi-agent setup
def setup_multi_agent_system():
    """Set up multiple agents for different purposes."""
    registry = AgentRegistry.get_instance()

    # Create different agents
    general_agent = create_simple_agent()
    technical_agent = create_configured_agent()
    support_agent = create_domain_agent()

    # Register agents with specific IDs
    registry.register_agent("general", general_agent)
    registry.register_agent("technical", technical_agent)
    registry.register_agent("support", support_agent)

    # Set default agent
    registry.set_default_agent(general_agent)

    print("Registered agents:")
    print("- general: General purpose assistant")
    print("- technical: Technical expert")
    print("- support: Customer support specialist")
    print(f"\nDefault agent: {registry.get_default_agent().name}")


# Example 6: Loading agent configuration from environment
def create_agent_from_env():
    """Create an agent using environment variables for configuration."""
    agent = Agent(
        name=os.getenv("ADK_AGENT_NAME", "assistant"),
        model=os.getenv("ADK_MODEL", "gemini-3.5-flash"),
        instruction=os.getenv("ADK_INSTRUCTIONS", "You are a helpful assistant."),
        # API key would be handled by Google ADK's auth system
    )
    return agent


# Main setup function
def setup_adk_agents():
    """Main function to set up ADK agents for the middleware."""
    registry = AgentRegistry.get_instance()

    # Choose your setup approach:

    # Option 1: Single simple agent
    agent = create_simple_agent()
    registry.set_default_agent(agent)

    # Option 2: Multiple agents
    # setup_multi_agent_system()

    # Option 3: Agent with tools
    # agent = create_agent_with_tools()
    # registry.set_default_agent(agent)

    return registry


if __name__ == "__main__":
    # Test the setup
    setup_adk_agents()

    # Test retrieval
    registry = AgentRegistry.get_instance()
    default_agent = registry.get_default_agent()
    print(f"Default agent configured: {default_agent.name}")