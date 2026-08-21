import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";

import { createDojoAgent } from "./factory";

const recipeSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    skill_level: {
      type: Type.STRING,
      enum: ["Beginner", "Intermediate", "Advanced"],
    },
    cooking_time: {
      type: Type.STRING,
      enum: ["5 min", "15 min", "30 min", "45 min", "60+ min"],
    },
    special_preferences: {
      type: Type.ARRAY,
      items: {
        type: Type.STRING,
        enum: [
          "High Protein",
          "Low Carb",
          "Spicy",
          "Budget-Friendly",
          "One-Pot Meal",
          "Vegetarian",
          "Vegan",
        ],
      },
    },
    ingredients: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          icon: {
            type: Type.STRING,
            description: "A single ingredient emoji.",
          },
          name: { type: Type.STRING },
          amount: { type: Type.STRING },
        },
        required: ["icon", "name", "amount"],
      },
    },
    instructions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: [
    "title",
    "skill_level",
    "cooking_time",
    "special_preferences",
    "ingredients",
    "instructions",
  ],
};

function createRecipeTool() {
  return new FunctionTool({
    name: "generate_recipe",
    description:
      "Create or update the complete recipe shown in the shared UI state.",
    parameters: recipeSchema,
    execute: (input, context) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("recipe must be an object");
      }
      const recipe = input as Record<string, unknown>;
      context?.state.set("recipe", recipe);
      return { status: "success", recipe };
    },
  });
}

export function createSharedStateAgent() {
  return createDojoAgent({
    name: "adk_js_shared_state",
    instruction: `You are a recipe assistant. The current recipe is {recipe?}.
For every request to create or change a recipe, call generate_recipe with the
complete updated recipe. Preserve user edits unless the user asks to replace
them. Keep text after the tool call brief because the UI renders the recipe.`,
    createTools: () => [createRecipeTool()],
  });
}
