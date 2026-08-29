"""Basic Chat feature."""

from __future__ import annotations

from fastapi import FastAPI
from ag_ui_adk import ADKAgent, AGUIToolset, add_adk_fastapi_endpoint
from google.adk.agents import LlmAgent
from google.adk import tools as adk_tools

# Compatibility shim for PreloadMemoryTool (renamed in newer ADK versions)
try:
    PreloadMemoryTool = adk_tools.preload_memory.PreloadMemoryTool
except AttributeError:
    PreloadMemoryTool = adk_tools.preload_memory_tool.PreloadMemoryTool

# Create a sample ADK agent (this would be your actual agent)
sample_agent = LlmAgent(
    name="assistant",
    model="gemini-3.5-flash",
    instruction="""
    You are a helpful assistant. Help users by answering their questions and assisting with their needs.
    - If the user greets you, please greet them back with specifically with "Hello".
    - If the user greets you and does not make any request, greet them and ask "how can I assist you?"
    - If the user makes a statement without making a request, you do not need to tell them you can't do anything about it.
      Try to say something conversational about it in response, making sure to mention the topic directly.
    - If the user asks you a question, if possible you can answer it using previous context without telling them that you cannot look it up.
      Only tell the user that you cannot search if you do not have enough information already to answer.
    """,
    tools=[
      AGUIToolset(), # Add the tools provided by the AG-UI client
      PreloadMemoryTool(),
    ]
)

# Create ADK middleware agent instance
chat_agent = ADKAgent(
    adk_agent=sample_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True
)

# Create FastAPI app
app = FastAPI(title="ADK Middleware Basic Chat")

# Add the ADK endpoint
add_adk_fastapi_endpoint(app, chat_agent, path="/")
