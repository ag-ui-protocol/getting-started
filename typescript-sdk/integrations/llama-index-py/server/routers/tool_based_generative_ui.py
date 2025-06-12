from typing import List
from pydantic import BaseModel

from llama_index.llms.openai import OpenAI
from llama_index.protocols.ag_ui.server import get_ag_ui_workflow_router


class Haiku(BaseModel):
    japanese: List[str]
    english: List[str]


async def generate_haiku(haiku: Haiku) -> str:
    """Useful for recording a generated haiku."""
    haiku = Haiku.model_validate(haiku)

    return "Haiku generated!"


tool_based_generative_ui_router = get_ag_ui_workflow_router(
    llm=OpenAI(model="gpt-4.1"),
    tools=[generate_haiku],
)
