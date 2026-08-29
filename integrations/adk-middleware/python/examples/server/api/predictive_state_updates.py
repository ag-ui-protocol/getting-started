"""Predictive State Updates feature.

This example demonstrates how to use predictive state updates with the ADK middleware.
Predictive state updates allow the UI to show state changes in real-time as tool
arguments are being streamed, providing a smooth document editing experience.

Key concepts:
1. PredictStateMapping: Configuration that tells the UI which tool arguments map to state keys
2. When a tool is called that matches the mapping, a PredictState CustomEvent is emitted
3. The UI uses this metadata to update state as tool arguments stream in

4. The middleware emits a write_document tool call after write_document_local completes,
   which triggers the frontend's write_document action to show a confirmation dialog
   (controlled by emit_confirm_tool=True, which is the default)

Note: We use write_document_local as the backend tool name to avoid conflicting with
the frontend's write_document action that handles the confirmation UI.
"""

from __future__ import annotations

import logging
from typing import Dict

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint, PredictStateMapping, AGUIToolset

from google.adk.agents import LlmAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.tools import ToolContext

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool and agent callbacks
# ---------------------------------------------------------------------------

def write_document_local(
    tool_context: ToolContext,
    document: str
) -> Dict[str, str]:
    """
    Write a document. Use markdown formatting to format the document.
    It's good to format the document extensively so it's easy to read.
    You can use all kinds of markdown.
    However, do not use italic or strike-through formatting, it's reserved for another purpose.
    You MUST write the full document, even when changing only a few words.
    When making edits to the document, try to make them minimal - do not change every word.
    Keep stories SHORT!

    Args:
        document: The document content to write in markdown format

    Returns:
        Dict indicating success status and message
    """
    try:
        tool_context.state["document"] = document
        return {"status": "success", "message": "Document written successfully"}
    except Exception as e:
        return {"status": "error", "message": f"Error writing document: {str(e)}"}


def on_before_agent(callback_context: CallbackContext):
    """Initialize document state if it doesn't exist."""
    if "document" not in callback_context.state:
        callback_context.state["document"] = None
    return None


# ---------------------------------------------------------------------------
# Module-level configuration
# ---------------------------------------------------------------------------

predictive_state_updates_agent = LlmAgent(
    name="DocumentAgent",
    model="gemini-3.5-flash",
    instruction="""
    You are a helpful assistant for writing documents.
    To write the document, you MUST use the write_document_local tool.
    You MUST write the full document, even when changing only a few words.
    When you wrote the document, DO NOT repeat it as a message.
    Just briefly summarize the changes you made. 2 sentences max.

    IMPORTANT RULES:
    1. Always use the write_document_local tool for any document writing or editing requests
    2. Write complete documents, not fragments
    3. Use markdown formatting for better readability
    4. Keep stories SHORT and engaging
    5. After using the tool, provide a brief summary of what you created or changed
    6. Do not use italic or strike-through formatting

    Examples of when to use the tool:
    - "Write a story about..." -> Use tool with complete story in markdown
    - "Edit the document to..." -> Use tool with the full edited document
    - "Add a paragraph about..." -> Use tool with the complete updated document

    Always provide complete, well-formatted documents that users can read and use.
    """,
    tools=[
        AGUIToolset(),
        write_document_local
    ],
    before_agent_callback=on_before_agent,
)

# Create ADK middleware agent instance with predictive state configuration
adk_predictive_state_agent = ADKAgent(
    adk_agent=predictive_state_updates_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
    predict_state=[
        PredictStateMapping(
            state_key="document",
            tool="write_document_local",
            tool_argument="document",
        )
    ],
)

# Create FastAPI app
app = FastAPI(title="ADK Middleware Predictive State Updates")

# Add the ADK endpoint
add_adk_fastapi_endpoint(app, adk_predictive_state_agent, path="/")
