from llama_index.llms.openai import OpenAI
from llama_index.protocols.ag_ui.server import get_ag_ui_workflow_router
from typing import Annotated


# This tool has a client-side version that is actually called to change the background
def change_background(
    background: Annotated[str, "The background. Prefer gradients."],
) -> str:
    """Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc."""
    return f"Changing background to {background}"

agentic_chat_router = get_ag_ui_workflow_router(
    llm=OpenAI(model="gpt-4.1"),
    tools=[change_background],
)
