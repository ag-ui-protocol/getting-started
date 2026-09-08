"""Shared State Agent - Recipe collaboration between agent and UI."""
# Force reload - no tools version
import os
import json
from typing import Dict, Any, List
from enum import Enum
from pydantic import BaseModel, Field
from strands import Agent, tool
from ag_ui_strands import StrandsAgent, create_strands_app, StrandsAgentConfig, ToolBehavior
from server.model_factory import create_model
from server.settings import cors_origins


class SkillLevel(str, Enum):
    """The level of skill required for the recipe."""
    BEGINNER = "Beginner"
    INTERMEDIATE = "Intermediate"
    ADVANCED = "Advanced"


class SpecialPreferences(str, Enum):
    """Special preferences for the recipe."""
    HIGH_PROTEIN = "High Protein"
    LOW_CARB = "Low Carb"
    SPICY = "Spicy"
    BUDGET_FRIENDLY = "Budget-Friendly"
    ONE_POT_MEAL = "One-Pot Meal"
    VEGETARIAN = "Vegetarian"
    VEGAN = "Vegan"


class CookingTime(str, Enum):
    """The cooking time of the recipe."""
    FIVE_MIN = "5 min"
    FIFTEEN_MIN = "15 min"
    THIRTY_MIN = "30 min"
    FORTY_FIVE_MIN = "45 min"
    SIXTY_PLUS_MIN = "60+ min"


class Ingredient(BaseModel):
    """An ingredient."""
    icon: str = Field(description="Icon: the actual emoji like 🥕")
    name: str = Field(description="The name of the ingredient")
    amount: str = Field(description="The amount of the ingredient")


class Recipe(BaseModel):
    """A recipe."""
    title: str = Field(description="The title of the recipe", default="Make Your Recipe")
    skill_level: str = Field(description="The skill level required for the recipe")
    special_preferences: List[str] = Field(description="A list of special preferences for the recipe")
    cooking_time: str = Field(description="The cooking time of the recipe")
    ingredients: List[Dict[str, str]] = Field(
        description="""Entire list of ingredients for the recipe, including the new ingredients
        and the ones that are already in the recipe: Icon (emoji like 🥕), name and amount.
        Like so: {\"icon\": \"🥕\", \"name\": \"Carrots\", \"amount\": \"250g\"}"""
    )
    instructions: List[str] = Field(
        description="""Entire list of instructions for the recipe,
        including the new instructions and the ones that are already there"""
    )
    changes: str = Field(description="A description of the changes made to the recipe", default="")


@tool
def generate_recipe(recipe: Recipe):
    """Using the existing (if any) ingredients and instructions, proceed with the recipe to finish it.
    Make sure the recipe is complete. ALWAYS provide the entire recipe, not just the changes.
    
    Args:
        recipe: The complete updated recipe with all fields
    """
    # Return success message - the recipe data is captured from tool arguments
    return "Recipe updated successfully"


# Initialize the recipe state
INITIAL_RECIPE_STATE = {
    "title": "Make Your Recipe",
    "skill_level": SkillLevel.INTERMEDIATE.value,
    "special_preferences": [],
    "cooking_time": CookingTime.FORTY_FIVE_MIN.value,
    "ingredients": [
        {"icon": "🥕", "name": "Carrots", "amount": "3 large, grated"},
        {"icon": "🌾", "name": "All-Purpose Flour", "amount": "2 cups"},
    ],
    "instructions": ["Preheat oven to 350°F (175°C)"],
    "changes": ""
}


def build_recipe_prompt(input_data, user_message: str) -> str:
    """Inject the current recipe state into the prompt."""
    state_dict = getattr(input_data, "state", None)
    if isinstance(state_dict, dict) and "recipe" in state_dict:
        recipe_json = json.dumps(state_dict["recipe"], indent=2)
        return (
            f"Current recipe state:\n{recipe_json}\n\n"
            f"User request: {user_message}\n\n"
            "Please update the recipe by calling the registered tool."
        )
    return user_message


async def recipe_state_from_args(context):
    """Emit recipe snapshot as soon as tool arguments are available."""
    try:
        tool_input = context.tool_input
        if isinstance(tool_input, str):
            tool_input = json.loads(tool_input)
        recipe_data = tool_input.get("recipe", tool_input)
        return {"recipe": recipe_data}
    except Exception:
        return None


shared_state_config = StrandsAgentConfig(
    state_context_builder=build_recipe_prompt,
    tool_behaviors={
        "generate_recipe": ToolBehavior(
            state_from_args=recipe_state_from_args,
        )
    },
)


# Create model from MODEL_PROVIDER env var (default: openai)
model = create_model()

system_prompt = """You are a helpful recipe assistant. When asked to improve or modify a recipe:

1. Call the generate_recipe tool ONCE with the COMPLETE updated recipe
2. Include ALL fields: title, skill_level, special_preferences, cooking_time, ingredients, instructions, and changes
3. After calling the tool, respond to the user with a brief confirmation of what you changed (1-2 sentences)
4. Do NOT call the tool multiple times in a row
5. Keep existing elements that aren't being changed

Be creative and helpful!"""

strands_agent = Agent(
    model=model,
    system_prompt=system_prompt,
    tools=[generate_recipe]  # Tool to update recipe state
)

# Create the AG-UI Strands agent wrapper
agent = StrandsAgent(
    agent=strands_agent,
    name="shared_state",
    description="A recipe assistant that collaborates with you to create amazing recipes",
    config=shared_state_config,
)

# Create the FastAPI app
app = create_strands_app(agent, origins=cors_origins())

