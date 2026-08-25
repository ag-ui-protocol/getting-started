import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { z } from "zod";
import { getStorage } from "../storage";

export const sharedStateAgent = new Agent({
  id: "shared_state",
  name: "shared_state",
  instructions: `
    You are a helpful assistant for creating recipes.

    The recipe in working memory is the user's CURRENT state — they edit it directly
    in the UI. Treat it as the source of truth, even when an earlier message said
    otherwise.

    IMPORTANT:
    1. Create a recipe using the existing ingredients and instructions. Make sure the recipe is complete.
    2. For ingredients, append new ingredients to the existing ones.
    3. For instructions, append new steps to the existing ones.
    4. 'ingredients' is always an array of objects with 'icon', 'name', and 'amount' fields
    5. 'instructions' is always an array of strings
    6. 'special_preferences', 'skill_level' and 'cooking_time' are chosen by the USER,
       not you. NEVER add, remove, or change them — leave them exactly as they are in
       working memory. In particular, do NOT re-add a preference the user removed, and
       do NOT add "Spicy" (or any preference) on your own.
    7. Instead, make 'ingredients' and 'instructions' MATCH the user's
       'special_preferences': if "Vegan" is set, use vegan ingredients; if "Spicy" is
       set, add heat; and if a preference is NOT set, make sure the recipe does not
       reflect it (e.g. if "Spicy" is absent, use no chili/heat).

    If you have just created or modified the recipe, just answer in one sentence what you did. Do not describe the recipe, just say what you did. Do not mention "working memory", "memory", or "state" in your answer.
  `,
  model: "openai/gpt-4.1-mini",
  memory: new Memory({
    storage: getStorage(),
    options: {
      workingMemory: {
        enabled: true,
        schema: z.object({
          recipe: z.object({
            skill_level: z
              .enum(["Beginner", "Intermediate", "Advanced"])
              .describe("The skill level required for the recipe"),
            special_preferences: z
              .array(
                z.enum([
                  "High Protein",
                  "Low Carb",
                  "Spicy",
                  "Budget-Friendly",
                  "One-Pot Meal",
                  "Vegetarian",
                  "Vegan",
                ]),
              )
              .describe("A list of special preferences for the recipe"),
            cooking_time: z
              .enum(["5 min", "15 min", "30 min", "45 min", "60+ min"])
              .describe("The cooking time of the recipe"),
            ingredients: z
              .array(
                z.object({
                  icon: z
                    .string()
                    .describe(
                      "The icon emoji (not emoji code like '\\x1f35e', but the actual emoji like 🥕) of the ingredient",
                    ),
                  name: z.string().describe("The name of the ingredient"),
                  amount: z.string().describe("The amount of the ingredient"),
                }),
              )
              .describe(
                "Entire list of ingredients for the recipe, including the new ingredients and the ones that are already in the recipe",
              ),
            instructions: z
              .array(z.string())
              .describe(
                "Entire list of instructions for the recipe, including the new instructions and the ones that are already there",
              ),
          }),
        }),
      },
    },
  }),
});
