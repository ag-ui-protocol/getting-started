"""Shared State feature.

Recipe assistant that maintains shared state (recipe) across turns.
The frontend sends the current state in `RunAgentInput.state`; AGUIStream
merges it into the run's variables, tools read and mutate `ctx.variables`,
and a STATE_SNAPSHOT with the updated recipe is emitted when the run ends.
"""

from enum import StrEnum
from textwrap import dedent

from ag2 import Agent, Context, tool
from ag2.ag_ui import AGUIStream
from ag2.config import OpenAIConfig
from fastapi import FastAPI
from pydantic import BaseModel, Field


class SkillLevel(StrEnum):
    """The level of skill required for the recipe."""

    BEGINNER = "Beginner"
    INTERMEDIATE = "Intermediate"
    ADVANCED = "Advanced"


class SpecialPreferences(StrEnum):
    """Special preferences for the recipe."""

    HIGH_PROTEIN = "High Protein"
    LOW_CARB = "Low Carb"
    SPICY = "Spicy"
    BUDGET_FRIENDLY = "Budget-Friendly"
    ONE_POT_MEAL = "One-Pot Meal"
    VEGETARIAN = "Vegetarian"
    VEGAN = "Vegan"


class CookingTime(StrEnum):
    """The cooking time of the recipe."""

    FIVE_MIN = "5 min"
    FIFTEEN_MIN = "15 min"
    THIRTY_MIN = "30 min"
    FORTY_FIVE_MIN = "45 min"
    SIXTY_PLUS_MIN = "60+ min"


class Ingredient(BaseModel):
    """A class representing an ingredient in a recipe."""

    icon: str = Field(
        default="ingredient",
        description="The icon emoji (e.g. 🥕) of the ingredient",
    )
    name: str = Field(description="Name of the ingredient")
    amount: str = Field(description="Amount of the ingredient")


class Recipe(BaseModel):
    """A class representing a recipe."""

    skill_level: SkillLevel = Field(
        default=SkillLevel.BEGINNER,
        description="The skill level required for the recipe",
    )
    special_preferences: list[SpecialPreferences] = Field(
        default_factory=list,
        description="Any special preferences for the recipe",
    )
    cooking_time: CookingTime = Field(
        default=CookingTime.FIVE_MIN,
        description="The cooking time of the recipe",
    )
    ingredients: list[Ingredient] = Field(
        default_factory=list,
        description="Ingredients for the recipe",
    )
    instructions: list[str] = Field(
        default_factory=list,
        description="Instructions for the recipe",
    )


class RecipeSnapshot(BaseModel):
    """A class representing the state of the recipe."""

    recipe: Recipe = Field(
        default_factory=Recipe,
        description="The current state of the recipe",
    )


@tool
async def get_current_recipe(ctx: Context) -> str:
    """Return the current recipe state as JSON so you can read it before updating.

    Call this when you need to see the existing recipe (e.g. ingredients, instructions)
    before making changes or when the user asks to modify the recipe.
    """
    if not ctx.variables:
        return RecipeSnapshot().model_dump_json(indent=2)
    snapshot = RecipeSnapshot.model_validate(ctx.variables)
    return snapshot.model_dump_json(indent=2)


@tool
async def display_recipe(ctx: Context, recipe: Recipe) -> str:
    """Display the recipe to the user.

    Use this to present the full recipe (or an updated version) to the user.
    Append new ingredients to existing ones when extending the recipe.
    Do not repeat the recipe in your message after calling this tool.

    Args:
        recipe: The recipe to display (full snapshot including ingredients and instructions).
    """
    snapshot = RecipeSnapshot(recipe=recipe)
    ctx.variables.update(snapshot.model_dump())
    return "Recipe displayed"


agent = Agent(
    name="recipe_assistant",
    prompt=dedent("""
        You are a helpful assistant for creating recipes.

        IMPORTANT:
        - Create a complete recipe using the existing ingredients
        - Append new ingredients to the existing ones
        - Use the `display_recipe` tool to present the recipe to the user
        - Do NOT repeat the recipe in the message, use the tool instead
        - Do NOT run the `display_recipe` tool multiple times in a row

        Once you have created the updated recipe and displayed it to the user,
        summarise the changes in one sentence, don't describe the recipe in
        detail or send it as a message to the user.
    """),
    config=OpenAIConfig(model="gpt-4o-mini"),
    tools=[get_current_recipe, display_recipe],
)

stream = AGUIStream(agent)
shared_state_app = FastAPI()
shared_state_app.mount("", stream.build_asgi())
