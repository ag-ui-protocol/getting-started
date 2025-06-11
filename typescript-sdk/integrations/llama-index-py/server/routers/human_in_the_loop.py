from typing import Literal, List
from pydantic import BaseModel

from llama_index.llms.openai import OpenAI
from llama_index.protocols.ag_ui.server import get_ag_ui_workflow_router



class Step(BaseModel):
    description: str
    status: Literal["enabled", "disabled", "executing"]


def generate_task_steps(steps: List[Step]) -> str:
    return f"Generated {len(steps)} steps"


human_in_the_loop_router = get_ag_ui_workflow_router(
    llm=OpenAI(model="gpt-4.1"),
    tools=[generate_task_steps],
)
