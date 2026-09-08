/**
 * Shared State example for AWS Strands (TypeScript): a collaborative recipe
 * editor. `predictState` is what streams the recipe into the UI while the model
 * is still emitting the tool call; `stateFromArgs` fires once the arguments are
 * complete and writes the canonical snapshot. `stateContextBuilder` feeds the
 * current recipe back in on the next turn.
 */

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent, type StrandsAgentConfig } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, listenOrExit, runIfMain } from "../run-if-main";

const recipeSchema = z.object({
  title: z.string().default("Make Your Recipe"),
  skill_level: z.string(),
  special_preferences: z.array(z.string()),
  cooking_time: z.string(),
  // Loose entries, described rather than required. Python types this as
  // `List[Dict[str, str]]`, and requiring all three fields means one ingredient
  // missing an icon fails the whole call after `stateFromArgs` has already
  // painted the card from the streamed arguments.
  ingredients: z
    .array(z.record(z.string(), z.string()))
    .describe(
      'Every ingredient, each with icon (an emoji such as 🥕), name and amount, like {"icon": "🥕", "name": "Carrots", "amount": "250g"}',
    ),
  instructions: z.array(z.string()),
  changes: z.string().default(""),
});

export const generateRecipe = tool({
  name: "generate_recipe",
  description:
    "Using the existing (if any) ingredients and instructions, proceed with the recipe to finish it. Make sure the recipe is complete. ALWAYS provide the entire recipe, not just the changes.",
  inputSchema: z.object({ recipe: recipeSchema }),
  callback() {
    return "Recipe updated successfully";
  },
});

/** The field names a recipe is recognised by, from {@link recipeSchema}. */
const RECIPE_KEYS = Object.keys(recipeSchema.shape);

/** Read the tool input as an object, whether it arrived as one or as JSON text. */
function asObject(value: unknown): Record<string, unknown> | null {
  let input = value;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

/**
 * Whether `value` carries any recipe field at all.
 *
 * Used on the WRITE path only, and checked by field rather than by truthiness.
 * `{}` is truthy, and the adapter hands over empty arguments when a tool call
 * arrives with no argument text yet, so a truthiness check writes an empty
 * recipe over the one on screen. Same shape of mistake as treating an empty
 * step list as a plan. It is a presence check, not validation: a recipe with
 * one field still replaces the whole object, which is why the prompt insists on
 * the complete recipe.
 */
function isRecipe(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return RECIPE_KEYS.some((key) => key in value);
}

export const sharedStateConfig: StrandsAgentConfig = {
  stateContextBuilder: (input, prompt) => {
    // Checked, not cast: `state` is typed as any, so a client can send a string
    // or a number, and `in` throws on those rather than returning false.
    const state = input.state;
    // On key presence, which is what Python checks. A thread that has never
    // had a recipe gets the bare message, so ordinary chat stays chat instead
    // of becoming a forced edit.
    if (typeof state !== "object" || state === null || !("recipe" in state)) {
      return prompt;
    }
    const recipe = (state as { recipe: unknown }).recipe;
    return `Current recipe state:\n${JSON.stringify(recipe, null, 2)}\n\nUser request: ${prompt}\n\nPlease update the recipe by calling the registered tool.`;
  },
  toolBehaviors: {
    generate_recipe: {
      // Stream the LLM's incremental `recipe` arg JSON into `state.recipe`
      // so the UI fills in fields progressively. Without this, the FE has
      // nothing to render until contentBlockStop fires `stateFromArgs`,
      // and the recipe pops in as a single bulk update. Mirrors the
      // langgraph shared-state demo (predict_state with state_key=recipe).
      predictState: [
        {
          stateKey: "recipe",
          tool: "generate_recipe",
          toolArgument: "recipe",
        },
      ],
      stateFromArgs: async (ctx) => {
        const input = asObject(ctx.toolInput);
        if (!input) return null;
        // A model that sends the recipe fields at the top level rather than
        // under `recipe` is still describing a recipe, so both are accepted.
        const nested = "recipe" in input ? input.recipe : input;
        // Parsed again if it is text: the outer arguments and the `recipe` value
        // itself can each arrive as JSON, and reading only the outer one drops
        // the update.
        const candidate =
          typeof nested === "string" ? asObject(nested) : nested;
        return isRecipe(candidate) ? { recipe: candidate } : null;
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a helpful recipe editor. When asked to improve or modify a recipe:

1. Call the generate_recipe tool ONCE with the COMPLETE updated recipe
2. Include ALL fields: title, skill_level, special_preferences, cooking_time, ingredients, instructions, and changes
3. After calling the tool, respond to the user with a brief confirmation of what you changed (1-2 sentences)
4. Do NOT call the tool multiple times in a row
5. Keep existing elements that aren't being changed

Be creative and helpful!`;

export async function createSharedStateAgent(): Promise<StrandsAgent> {
  return new StrandsAgent({
    agent: new Agent({
      // Chat Completions API: the Responses adapter buffers tool-call argument
      // deltas, so the predictState mapping above would have nothing to paint
      // from until the call completed and the recipe would arrive in one lump.
      model: await createModel({ openaiApi: "chat" }),
      systemPrompt: SYSTEM_PROMPT,
      tools: [generateRecipe],
    }),
    name: "shared_state",
    description: "Strands agent with shared recipe state",
    config: sharedStateConfig,
  });
}

runIfMain(import.meta.url, async () => {
  // Port first: it throws on a malformed PORT, and building the agent first
  // would surface a missing API key instead and hide the real complaint.
  const port = demoPort();
  const app = await createStrandsApp(await createSharedStateAgent(), {
    path: "/",
  });
  listenOrExit(app, "shared-state", port);
});
