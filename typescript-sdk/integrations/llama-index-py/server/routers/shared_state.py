from typing import Literal, List
from pydantic import BaseModel

from llama_index.core.workflow import Context
from llama_index.llms.openai import OpenAI
from llama_index.protocols.ag_ui.events import StateSnapshotWorkflowEvent
from llama_index.protocols.ag_ui.server import get_ag_ui_workflow_router


class Ingredient(BaseModel):
    icon: str
    name: str
    amount: str

class Recipe(BaseModel):
    skill_level: str
    special_preferences: List[str]
    cooking_time: str
    ingredients: List[Ingredient]
    instructions: List[str]


async def update_recipe(ctx: Context, recipe: Recipe) -> str:
    """Useful for recording a recipe to shared state."""
    recipe = Recipe.model_validate(recipe)

    state = await ctx.get("state")
    if state is None:
        state = {}

    state["recipe"] = recipe.model_dump()

    ctx.write_event_to_stream(
        StateSnapshotWorkflowEvent(
            snapshot=state
        )
    )

    await ctx.set("state", state)

    return "Recipe updated!"


shared_state_router = get_ag_ui_workflow_router(
    llm=OpenAI(model="gpt-4.1"),
    tools=[update_recipe],
    initial_state={
        "recipe": None,
    }
)


