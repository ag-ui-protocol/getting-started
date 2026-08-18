"""Microsoft Agent Framework Python Dojo Example Server.

This provides a FastAPI application that demonstrates how to use the
Microsoft Agent Framework with the AG-UI protocol. It includes examples for
each of the AG-UI dojo features:
- Agentic Chat
- Human in the Loop
- Backend Tool Rendering
- Agentic Generative UI
- Tool-based Generative UI
- Shared State
- Predictive State Updates

All agent implementations are from the agent-framework-ag-ui package examples.
Reference: https://github.com/microsoft/agent-framework/tree/main/python/packages/ag-ui/examples/agents
"""

import os

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI

from agent_framework.openai import OpenAIChatClient
# TODO: Uncomment this when we have a way to authenticate with Azure
# from azure.identity import DefaultAzureCredential
# from agent_framework.azure import AzureOpenAIChatClient
from agent_framework_ag_ui import add_agent_framework_fastapi_endpoint
from agent_framework_ag_ui_examples.agents import (
    document_writer_agent,
    human_in_the_loop_agent,
    recipe_agent,
    simple_agent,
    task_steps_agent_wrapped,
    ui_generator_agent,
    weather_agent,
)

load_dotenv()

app = FastAPI(title="Microsoft Agent Framework Python Dojo")

# Temp Diagnostic logging for deployment troubleshooting
print(f"AZURE_OPENAI_ENDPOINT: {'SET' if os.getenv('AZURE_OPENAI_ENDPOINT') else 'MISSING'}")
print(f"AZURE_OPENAI_CHAT_DEPLOYMENT_NAME: {'SET' if os.getenv('AZURE_OPENAI_CHAT_DEPLOYMENT_NAME') else 'MISSING'}")
print(f"AZURE_CLIENT_ID: {'SET' if os.getenv('AZURE_CLIENT_ID') else 'MISSING'}")
print(f"AZURE_TENANT_ID: {'SET' if os.getenv('AZURE_TENANT_ID') else 'MISSING'}")
print(f"AZURE_CLIENT_SECRET: {'SET' if os.getenv('AZURE_CLIENT_SECRET') else 'MISSING'}")
print(f"OPENAI_API_KEY: {'SET' if os.getenv('OPENAI_API_KEY') else 'MISSING'}")

# Resolve deployment name with fallback to support both Python and .NET env var naming
deployment_name = os.getenv("AZURE_OPENAI_CHAT_DEPLOYMENT_NAME")
if deployment_name:
    print(f"Using deployment name: {deployment_name}")
else:
    print("WARNING: No deployment name found in AZURE_OPENAI_CHAT_DEPLOYMENT_NAME")

endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
if endpoint:
    print(f"Using endpoint: {endpoint}")
else:
    print("WARNING: AZURE_OPENAI_ENDPOINT not set")

api_key = os.getenv("OPENAI_API_KEY")

# Create a shared chat client for all agents
# You can use different chat clients for different agents:

# from agent_framework.openai import OpenAIChatClient
# openai_client = OpenAIChatClient(model_id="gpt-4o")
# azure_client = AzureOpenAIChatClient(credential=AzureCliCredential())

# Then pass different clients to different agents:
# add_agent_framework_fastapi_endpoint(app, simple_agent(azure_client), "/agentic_chat")
# add_agent_framework_fastapi_endpoint(app, weather_agent(openai_client), "/backend_tool_rendering")

# If using api_key authentication remove the credential parameter
# Explicitly pass deployment_name to align with .NET behavior and support both env var names
chat_client = OpenAIChatClient(
    model=deployment_name or os.getenv("OPENAI_CHAT_MODEL_ID", "gpt-4o"),
    api_key=api_key,
)
# TODO: Uncomment this to authenticate with Azure
# chat_client = AzureOpenAIChatClient(
#     credential=DefaultAzureCredential(),
#     deployment_name=deployment_name,
#     endpoint=endpoint,
# )

# Agentic Chat - simple_agent
add_agent_framework_fastapi_endpoint(app, simple_agent(chat_client), "/agentic_chat")

# Agentic Chat Multimodal - simple_agent with a vision-capable model
add_agent_framework_fastapi_endpoint(app, simple_agent(chat_client), "/agentic_chat_multimodal")

# Backend Tool Rendering - weather_agent
add_agent_framework_fastapi_endpoint(app, weather_agent(chat_client), "/backend_tool_rendering")

# Human in the Loop - human_in_the_loop_agent with state configuration
add_agent_framework_fastapi_endpoint(
    app,
    human_in_the_loop_agent(chat_client),
    "/human_in_the_loop",
)

# Agentic Generative UI - task_steps_agent_wrapped
add_agent_framework_fastapi_endpoint(app, task_steps_agent_wrapped(chat_client), "/agentic_generative_ui")  # type: ignore[arg-type]

# Tool-based Generative UI - ui_generator_agent
add_agent_framework_fastapi_endpoint(app, ui_generator_agent(chat_client), "/tool_based_generative_ui")

# Shared State - recipe_agent
add_agent_framework_fastapi_endpoint(app, recipe_agent(chat_client), "/shared_state")

# Predictive State Updates - document_writer_agent
add_agent_framework_fastapi_endpoint(app, document_writer_agent(chat_client), "/predictive_state_updates")


def main():
    """Main function to start the FastAPI server."""
    port = int(os.getenv("PORT", "8888"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
