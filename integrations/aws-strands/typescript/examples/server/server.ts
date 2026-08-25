/**
 * Verification server: mounts every TS example on the same paths the Python
 * reference server uses, so both implementations can be driven by the same
 * curl payloads.
 */
import express from "express";
import cors from "cors";
import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent, type StrandsAgentConfig } from "@ag-ui/aws-strands";
import {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
} from "@ag-ui/aws-strands/server";
import { createModel } from "./model-factory";
import { createA2UIDynamicSchemaAgent } from "./api/a2ui-dynamic-schema";
import { createA2UIFixedSchemaAgent } from "./api/a2ui-fixed-schema";
import { createA2UIRecoveryAgent } from "./api/a2ui-recovery";
import { createMultiAgentGraphAgent } from "./api/multi-agent";

function mountAgent(
  app: express.Express,
  path: string,
  aguiAgent: StrandsAgent,
): void {
  addStrandsExpressEndpoint(app, aguiAgent, { path });
  addStrandsExpressEndpoint(app, aguiAgent, { path: `${path}/` });
}

async function main(): Promise<void> {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "4mb" }));
  addPing(app, "/ping");
  addCapabilities(app, "/capabilities");

  /* ---------------- agentic-chat ---------------- */
  const chatAgent = new Agent({
    model: await createModel(),
    systemPrompt: `
      You are a helpful assistant.
      When the user greets you, always greet them back. Your greeting should always start with "Hello".
      Your greeting should also always ask (exact wording) "how can I assist you?"
    `,
  });
  mountAgent(
    app,
    "/agentic-chat",
    new StrandsAgent({
      agent: chatAgent,
      name: "agentic_chat",
      description: "Conversational Strands agent with AG-UI streaming",
    }),
  );

  /* ---------------- agentic-chat-reasoning ---------------- */
  const reasoningAgent = new Agent({
    model: await createModel({ reasoning: true }),
    systemPrompt: `
      You are a helpful assistant that thinks through problems step by step.
      When reasoning about a problem, break it down into clear steps before answering.
    `,
  });
  mountAgent(
    app,
    "/agentic-chat-reasoning",
    new StrandsAgent({
      agent: reasoningAgent,
      name: "agentic_chat_reasoning",
      description: "Reasoning agent",
    }),
  );

  /* ---------------- agentic-chat-multimodal ---------------- */
  const multimodalAgent = new Agent({
    model: await createModel(),
    systemPrompt:
      "You are a helpful assistant that can analyze images and documents. Describe images in detail.",
  });
  mountAgent(
    app,
    "/agentic-chat-multimodal",
    new StrandsAgent({
      agent: multimodalAgent,
      name: "agentic_chat_multimodal",
      description: "Multimodal chat",
    }),
  );

  /* ---------------- backend-tool-rendering ---------------- */
  // Schema mirrors python/examples/server/api/backend_tool_rendering.py so
  // the dojo's WeatherCard (which reads `location` from args and
  // `wind_speed` / `feels_like` from the result) renders identically.
  const getWeather = tool({
    name: "get_weather",
    description: "Get weather information for a location.",
    inputSchema: z.object({
      location: z.string().describe("The location to get weather for."),
    }),
    callback: () => {
      const conditions = ["sunny", "cloudy", "rainy", "clear", "partly cloudy"];
      const rand = (lo: number, hi: number) =>
        Math.floor(Math.random() * (hi - lo + 1)) + lo;
      return {
        temperature: rand(60, 85),
        conditions: conditions[rand(0, conditions.length - 1)],
        humidity: rand(30, 80),
        wind_speed: rand(5, 20),
        feels_like: rand(58, 88),
      };
    },
  });
  const renderChart = tool({
    name: "render_chart",
    description: "Render a chart with backend processing capabilities.",
    inputSchema: z.object({
      chart_type: z.string(),
      data: z.string(),
    }),
    callback: ({ chart_type, data }) => ({
      chart_type,
      data: data.slice(0, 100),
      status: "rendered",
    }),
  });
  const backendToolAgent = new Agent({
    model: await createModel(),
    systemPrompt:
      "You are a helpful assistant with backend tool rendering capabilities. You can get weather information and render charts.",
    tools: [getWeather, renderChart],
  });
  mountAgent(
    app,
    "/backend-tool-rendering",
    new StrandsAgent({
      agent: backendToolAgent,
      name: "backend_tool_rendering",
      description: "Strands agent that invokes backend tools",
    }),
  );

  /* ---------------- shared-state ---------------- */
  const recipeSchema = z.object({
    title: z.string(),
    skill_level: z.string(),
    special_preferences: z.array(z.string()),
    cooking_time: z.string(),
    ingredients: z.array(
      z.object({ icon: z.string(), name: z.string(), amount: z.string() }),
    ),
    instructions: z.array(z.string()),
    changes: z.string().default(""),
  });
  const generateRecipe = tool({
    name: "generate_recipe",
    description: "Produce a complete updated recipe.",
    inputSchema: z.object({ recipe: recipeSchema }),
    callback: () => "Recipe updated successfully",
  });
  const sharedConfig: StrandsAgentConfig = {
    stateContextBuilder: (input, prompt) => {
      const state = (input.state ?? {}) as Record<string, unknown>;
      const recipe = state.recipe ?? {};
      return `Current recipe state:\n${JSON.stringify(recipe, null, 2)}\n\nUser request: ${prompt}\n\nPlease update the recipe by calling the registered tool.`;
    },
    toolBehaviors: {
      generate_recipe: {
        // Stream the recipe arg into state.recipe while the LLM is still
        // emitting it, so the UI fills in progressively. Mirrors the
        // langgraph shared-state demo's predict_state mapping.
        predictState: [
          {
            stateKey: "recipe",
            tool: "generate_recipe",
            toolArgument: "recipe",
          },
        ],
        stateFromArgs: async (ctx) => {
          const args = ctx.toolInput as { recipe?: unknown };
          return args?.recipe ? { recipe: args.recipe } : null;
        },
      },
    },
  };
  const sharedAgent = new Agent({
    model: await createModel(),
    systemPrompt: "You are a helpful recipe editor.",
    tools: [generateRecipe],
  });
  mountAgent(
    app,
    "/shared-state",
    new StrandsAgent({
      agent: sharedAgent,
      name: "shared_state",
      description: "Shared recipe state",
      config: sharedConfig,
    }),
  );

  /* ---------------- agentic-generative-ui ---------------- */
  const stepSchema = z.object({
    description: z.string(),
    status: z.string().default("pending"),
  });
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  const planTaskSteps = tool({
    name: "plan_task_steps",
    description: "Plan the concrete steps required to accomplish a task.",
    inputSchema: z.object({
      task: z.string(),
      context: z.string().default(""),
      steps: z.array(stepSchema),
    }),
    callback: async function* ({ task, context, steps }) {
      const normalized = (steps ?? []).map(
        (s: { description: string; status?: string }) => ({
          description: s.description,
          status: s.status || "pending",
        }),
      );
      if (normalized.length === 0) {
        return { task, context, steps: [] };
      }
      yield { state: { steps: normalized.map((s) => ({ ...s })) } };
      for (let i = 0; i < normalized.length; i++) {
        await sleep(100);
        normalized[i]!.status = "in_progress";
        yield { state: { steps: normalized.map((s) => ({ ...s })) } };
        await sleep(100);
        normalized[i]!.status = "completed";
        yield { state: { steps: normalized.map((s) => ({ ...s })) } };
      }
      return { task, context, steps: normalized };
    },
  });
  const genuiConfig: StrandsAgentConfig = {
    stateContextBuilder: (input, prompt) => {
      const state = (input.state ?? {}) as Record<string, unknown>;
      const steps = state.steps;
      if (steps) {
        return `A plan is already in progress. NEVER call plan_task_steps again.\n\nCurrent steps:\n${JSON.stringify(steps, null, 2)}\n\nUser: ${prompt}`;
      }
      return prompt;
    },
    toolBehaviors: {
      plan_task_steps: {
        predictState: [
          { stateKey: "steps", tool: "plan_task_steps", toolArgument: "steps" },
        ],
        stateFromResult: async (ctx) => {
          const result = (ctx.resultData ?? {}) as { steps?: unknown[] };
          return result.steps ? { steps: result.steps } : null;
        },
      },
    },
  };
  const genuiAgent = new Agent({
    model: await createModel(),
    tools: [planTaskSteps],
    systemPrompt:
      "You are an energetic project assistant. When the user asks for a plan, call plan_task_steps once with 4-6 gerund-form steps.",
  });
  mountAgent(
    app,
    "/agentic-generative-ui",
    new StrandsAgent({
      agent: genuiAgent,
      name: "agentic_generative_ui",
      description: "Generative UI agent",
      config: genuiConfig,
    }),
  );

  /* ---------------- human-in-the-loop ---------------- */
  const hitlAgent = new Agent({
    model: await createModel(),
    tools: [],
    systemPrompt: `You are a task planning assistant specialized in creating clear, actionable step-by-step plans.

**Your Primary Role:**
- Break down any user request into exactly 10 clear, actionable steps
- Generate steps that require human review and approval
- Execute only human-approved steps

**When a user requests help with a task:**
1. ALWAYS use the \`generate_task_steps\` tool to create a breakdown (default to 10 steps unless told otherwise)
2. Each step must be:
   - Brief (only a few words)
   - In imperative form (e.g., "Dig hole", "Open door", "Mix ingredients")
   - Clear and actionable
   - Logically ordered from start to finish
3. Set all steps to "enabled" status initially
4. After the user reviews the plan, the \`generate_task_steps\` tool result will arrive as JSON of the form
   \`{ "accepted": <bool>, "steps": [...] }\`. The \`steps\` array contains ONLY the steps the user approved — disabled steps are removed entirely.
5. Treat that \`steps\` array as the SINGLE SOURCE OF TRUTH for what was approved. Do NOT fall back to the original tool arguments.
   - If accepted: briefly confirm the plan (only include the approved steps from the tool result) and proceed (don't repeat the full original list). Do not ask for more clarifying information.
   - If rejected: Ask what they'd like to change (don't call \`generate_task_steps\` again until they provide input)
6. When the user accepts the plan, "execute" the plan by repeating ONLY the approved steps (those present in the tool result's \`steps\` array) in order as if you have just done them. Then let the user know you have completed the plan.
    - example: if the tool result steps are "Dig hole", "Open door", "Mix ingredients", you would respond with "Digging hole... Opening door... Mixing ingredients..."

**Important:**
- NEVER call \`generate_task_steps\` twice in a row without user input
- NEVER repeat the list of steps in your response after calling the tool
- NEVER mention or execute steps that are absent from the tool result's \`steps\` array
- DO provide a brief, creative summary of how you would execute the approved steps
- For follow-up questions about a previously executed plan, just answer in plain text — do NOT invoke any tool
`,
  });
  mountAgent(
    app,
    "/human-in-the-loop",
    new StrandsAgent({
      agent: hitlAgent,
      name: "human_in_the_loop",
      description: "HITL agent",
    }),
  );

  /* ---------------- tool-based-generative-ui ---------------- */
  const haikuAgent = new Agent({
    model: await createModel(),
    tools: [],
    systemPrompt: `You are a creative haiku generator.

When the user asks for a haiku, ALWAYS call the \`generate_haiku\` tool with:
- 3 lines of haiku in Japanese
- 3 lines of haiku translated to English
- One relevant image_name from the provided list
- A CSS gradient for the card background

Do not respond with plain text — always use the tool.`,
  });
  mountAgent(
    app,
    "/tool-based-generative-ui",
    new StrandsAgent({
      agent: haikuAgent,
      name: "tool_based_generative_ui",
      description: "Haiku generator with frontend-rendered tool",
    }),
  );

  /* ---------------- multi-agent ---------------- */
  // A Graph orchestrator rather than a single Agent: the adapter detects the
  // missing `.model` accessor and drives `.stream()` instead of cloning a
  // per-thread agent.
  mountAgent(app, "/multi-agent", await createMultiAgentGraphAgent());

  /* ---------------- a2ui (auto-injected tool) ---------------- */
  // Both demos are PLAIN Strands agents with NO a2ui tool wiring (each in its
  // own file under ./agents). The CopilotKit runtime sends `injectA2UITool`;
  // the @ag-ui/aws-strands adapter infers the model and auto-injects
  // `generate_a2ui` (which runs the toolkit's validate→retry recovery loop).
  mountAgent(app, "/a2ui-dynamic-schema", await createA2UIDynamicSchemaAgent());
  mountAgent(app, "/a2ui-recovery", await createA2UIRecoveryAgent());

  /* ---------------- a2ui (fixed schema, direct backend tools) ---------------- */
  // Unlike the auto-injected demos above, the fixed-schema agent wires its OWN
  // backend tools (search_flights / search_hotels) that return a fixed-layout
  // a2ui_operations envelope. The runtime's A2UIMiddleware paints it directly;
  // no generate_a2ui injection (see route.ts + STRANDS_A2UI_INJECT_AGENTS).
  mountAgent(app, "/a2ui-fixed-schema", await createA2UIFixedSchemaAgent());

  const port = Number(process.env.PORT ?? 8022);
  const host = process.env.HOST ?? "0.0.0.0";
  app.listen(port, host, () => {
    console.log(`TS strands server listening on ${host}:${port}`);
  });
}

void main();
