import asyncio
from typing import Literal, List
from pydantic import BaseModel

from llama_index.core.workflow import Context
from llama_index.llms.openai import OpenAI
from llama_index.protocols.ag_ui.events import CustomWorkflowEvent
from llama_index.protocols.ag_ui.server import get_ag_ui_workflow_router


async def write_document(ctx: Context, document: str) -> str:
    """Used to record a document."""
    ctx.write_event_to_stream(
        CustomWorkflowEvent(
            name="PredictState",
            value=[
                {
                    "state_key": "document",
                    "tool": "write_document",
                    "tool_argument": "document"
                }
            ]
        )
    )

    await asyncio.sleep(1.0)

    return "Document written"

async def confirm_changes(changes: str) -> str:
    """Used to confirm changes after writing a document."""
    return "Changes confirmed"


predictive_state_updates_router = get_ag_ui_workflow_router(
    llm=OpenAI(model="o3-mini"),
    tools=[write_document, confirm_changes],
    system_prompt="Always confirm changes after writing a document, or I will lose my job. This means if you invoke the write_document tool, you must invoke the confirm_changes tool directly after."
)
