/**
 * A demo of shared state between the agent and CopilotKit using LangGraph.
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { Command, Annotation, MessagesAnnotation, StateGraph, END, START } from "@langchain/langgraph";
import { aguiTransformer } from "@ag-ui/langgraph/transformer";

enum SkillLevel {
  BEGINNER = "Beginner",
  INTERMEDIATE = "Intermediate",
  ADVANCED = "Advanced"
}

enum SpecialPreferences {
  HIGH_PROTEIN = "High Protein",
  LOW_CARB = "Low Carb",
  SPICY = "Spicy",
  BUDGET_FRIENDLY = "Budget-Friendly",
  ONE_POT_MEAL = "One-Pot Meal",
  VEGETARIAN = "Vegetarian",
  VEGAN = "Vegan"
}

enum CookingTime {
  FIVE_MIN = "5 min",
  FIFTEEN_MIN = "15 min",
  THIRTY_MIN = "30 min",
  FORTY_FIVE_MIN = "45 min",
  SIXTY_PLUS_MIN = "60+ min"
}

interface Ingredient {
  icon: string;
  name: string;
  amount: string;
}

interface Recipe {
  skill_level: SkillLevel;
  special_preferences: SpecialPreferences[];
  cooking_time: CookingTime;
  ingredients: Ingredient[];
  instructions: string[];
  changes?: string;
}

const GENERATE_RECIPE_TOOL = {
  type: "function",
  function: {
    name: "generate_recipe",
    description: "Using the existing (if any) ingredients and instructions, proceed with the recipe to finish it. Make sure the recipe is complete. ALWAYS provide the entire recipe, not just the changes.",
    parameters: {
      type: "object",
      properties: {
        recipe: {
          type: "object",
          properties: {
            skill_level: {
              type: "string",
              enum: Object.values(SkillLevel),
              description: "The skill level required for the recipe"
            },
            special_preferences: {
              type: "array",
              items: {
                type: "string",
                enum: Object.values(SpecialPreferences)
              },
              description: "A list of special preferences for the recipe"
            },
            cooking_time: {
              type: "string",
              enum: Object.values(CookingTime),
              description: "The cooking time of the recipe"
            },
            ingredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  icon: { type: "string", description: "The icon emoji (not emoji code like '\\u1f35e', but the actual emoji like 🥕) of the ingredient" },
                  name: { type: "string" },
                  amount: { type: "string" }
                }
              },
              description: "Entire list of ingredients for the recipe, including the new ingredients and the ones that are already in the recipe"
            },
            instructions: {
              type: "array",
              items: { type: "string" },
              description: "Entire list of instructions for the recipe, including the new instructions and the ones that are already there"
            },
            changes: {
              type: "string",
              description: "A description of the changes made to the recipe"
            }
          },
        }
      },
      required: ["recipe"]
    }
  }
};

export const AgentStateAnnotation = Annotation.Root({
  recipe: Annotation<Recipe | undefined>(),
  tools: Annotation<any[]>(),
  ...MessagesAnnotation.spec,
});
export type AgentState = typeof AgentStateAnnotation.State;

async function startFlow(state: AgentState, config?: RunnableConfig): Promise<Command> {
  /**
   * This is the entry point for the flow.
   */

  // Initialize recipe if not exists
  if (!state.recipe) {
    state.recipe = {
      skill_level: SkillLevel.BEGINNER,
      special_preferences: [],
      cooking_time: CookingTime.FIFTEEN_MIN,
      ingredients: [{ icon: "🍴", name: "Sample Ingredient", amount: "1 unit" }],
      instructions: ["First step instruction"]
    };
    // Emit the initial state to ensure it's properly shared with the frontend
    await dispatchCustomEvent("manually_emit_intermediate_state", state, config);
  }
  
  return new Command({
    goto: "chat_node",
    update: {
      messages: state.messages,
      recipe: state.recipe
    }
  });
}

async function chatNode(state: AgentState, config?: RunnableConfig): Promise<Command> {
  /**
   * Standard chat node.
   */
  // Create a safer serialization of the recipe
  let recipeJson = "No recipe yet";
  if (state.recipe) {
    try {
      recipeJson = JSON.stringify(state.recipe, null, 2);
    } catch (e) {
      recipeJson = `Error serializing recipe: ${e}`;
    }
  }

  const systemPrompt = `You are a helpful assistant for creating recipes. 
    This is the current state of the recipe: ${recipeJson}
    You can improve the recipe by calling the generate_recipe tool.
    
    IMPORTANT:
    1. Create a recipe using the existing ingredients and instructions. Make sure the recipe is complete.
    2. For ingredients, append new ingredients to the existing ones.
    3. For instructions, append new steps to the existing ones.
    4. 'ingredients' is always an array of objects with 'icon', 'name', and 'amount' fields
    5. 'instructions' is always an array of strings

    If you have just created or modified the recipe, just answer in one sentence what you did. dont describe the recipe, just say what you did.
    `;

  // Define the model
  const model = new ChatOpenAI({ model: "gpt-4o-mini" });
  
  // Define config for the model
  if (!config) {
    config = { recursionLimit: 25 };
  }

  // Use "predict_state" metadata to set up streaming for the write_document tool
  if (!config.metadata) config.metadata = {};
  config.metadata.predict_state = [{
    state_key: "recipe",
    tool: "generate_recipe",
    tool_argument: "recipe"
  }];

  // Bind the tools to the model
  const modelWithTools = model.bindTools(
    [
      ...state.tools,
      GENERATE_RECIPE_TOOL
    ],
    {
      // Disable parallel tool calls to avoid race conditions
      parallel_tool_calls: false,
    }
  );

  // Run the model and generate a response
  const response = await modelWithTools.invoke([
    new SystemMessage({ content: systemPrompt }),
    ...state.messages,
  ], config);

  // Update messages with the response
  const messages = [...state.messages, response];
  
  // Handle tool calls
  if (response.tool_calls && response.tool_calls.length > 0) {
    const toolCall = response.tool_calls[0];
    
    if (toolCall.name === "generate_recipe") {
      // Update recipe state with tool_call_args
      const recipeData = toolCall.args.recipe;
      let recipe: Recipe;
      // If we have an existing recipe, update it
      if (state.recipe) {
        recipe = { ...state.recipe };
        for (const [key, value] of Object.entries(recipeData)) {
          if (value !== null && value !== undefined) {  // Only update fields that were provided
            (recipe as any)[key] = value;
          }
        }
      } else {
        // Create a new recipe
        recipe = {
          skill_level: recipeData.skill_level || SkillLevel.BEGINNER,
          special_preferences: recipeData.special_preferences || [],
          cooking_time: recipeData.cooking_time || CookingTime.FIFTEEN_MIN,
          ingredients: recipeData.ingredients || [],
          instructions: recipeData.instructions || []
        };
      }
      
      // Add tool response to messages
      const toolResponse = {
        role: "tool" as const,
        content: "Recipe generated.",
        tool_call_id: toolCall.id
      };
      
      const updatedMessages = [...messages, toolResponse];
      
      // Explicitly emit the updated state to ensure it's shared with frontend
      state.recipe = recipe;
      await dispatchCustomEvent("manually_emit_intermediate_state", state, config);
      
      // Return command with updated recipe
      return new Command({
        goto: "start_flow",
        update: {
          messages: updatedMessages,
          recipe: recipe
        }
      });
    }
  }

  return new Command({
    goto: END,
    update: {
      messages: messages,
      recipe: state.recipe
    }
  });
}

// Define the graph
const workflow = new StateGraph<AgentState>(AgentStateAnnotation);

// Add nodes
workflow.addNode("start_flow", startFlow);
workflow.addNode("chat_node", chatNode);

// Add edges
workflow.setEntryPoint("start_flow");
workflow.addEdge(START, "start_flow");
workflow.addEdge("start_flow", "chat_node");
workflow.addEdge("chat_node", END);

// Compile the graph
export const sharedStateGraph = workflow.compile({
  transformers: [aguiTransformer],
});