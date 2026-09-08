/**
 * Agentic Generative UI example for AWS Strands (TypeScript).
 *
 * Demonstrates streaming agent state updates to the frontend for real-time
 * UI rendering. Uses ONLY the canonical Strands + @ag-ui/aws-strands surface:
 *
 * - `predictState` mapping streams the predicted `steps` to the FE while
 *   the LLM is still emitting `plan_task_steps` arguments.
 * - The tool itself is an async generator. Each `yield` of `{ state: {...} }`
 *   reaches the @ag-ui/aws-strands adapter as a tool stream update, which it
 *   translates into an AG-UI `StateSnapshotEvent`.
 * - The FINAL value returned by the generator is the tool's result.
 *
 * The agent never emits AG-UI events directly. State updates flow through
 * Strands' native streaming mechanism, mirroring the Python reference
 * (integrations/aws-strands/python/examples/server/api/agentic_generative_ui.py).
 */

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent, type StrandsAgentConfig } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, listenOrExit, runIfMain } from "../run-if-main";

/**
 * Reduce whatever arrived to `{ description, status }` entries.
 *
 * Follows Python's `_normalize_steps` in the ways that matter: a non-list
 * becomes no steps, plain strings become descriptions, and a `description` of
 * any type is coerced the way Python's `str()` coerces it, so `{description: 42}`
 * survives as "42" rather than failing the call.
 *
 * Deliberately stricter in one place. Python keeps an entry whose description is
 * blank or `None`, which puts an empty row on the page; this drops those, so a
 * plan of nothing but blanks reaches the fallback rather than rendering as gaps.
 */
export function normalizeSteps(
  raw: unknown,
): { description: string; status: string }[] {
  if (!Array.isArray(raw)) return [];
  const steps: { description: string; status: string }[] = [];
  for (const step of raw) {
    if (typeof step === "string") {
      if (step.trim()) {
        steps.push({ description: step.trim(), status: "pending" });
      }
      continue;
    }
    if (typeof step !== "object" || step === null) continue;
    if (!("description" in step)) continue;
    const { description, status } = step as {
      description?: unknown;
      status?: unknown;
    };
    const described = String(description ?? "").trim();
    if (!described) continue;
    steps.push({
      description: described,
      status: typeof status === "string" && status ? status : "pending",
    });
  }
  return steps;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A plan for a task the model described but supplied no steps for.
 *
 * Deliberately not an empty list. The state this tool writes is what the next
 * turn's `stateContextBuilder` reads, and an empty plan gives the page nothing
 * to render while still being a plan of record. The length checks below keep an
 * empty one from reaching state at all; this keeps the demo from producing one.
 */
export function fallbackSteps(
  task: string,
  context: string,
): { description: string; status: string }[] {
  let count = 6;
  for (const token of context.split(/\s+/)) {
    if (/^\d+$/.test(token)) {
      count = Math.max(4, Math.min(10, parseInt(token, 10)));
      break;
    }
  }
  const templates = [
    "Clarifying goals for {task}",
    "Gathering resources for {task}",
    "Preparing workspace for {task}",
    "Executing core work on {task}",
    "Reviewing results for {task}",
    "Wrapping up {task}",
    "Documenting learnings from {task}",
    "Celebrating completion of {task}",
  ];
  const plan: { description: string; status: string }[] = [];
  for (let i = 0; i < count; i++) {
    // Replaced through a function, because the task text comes from the model
    // and `String.replace` reads `$&` and friends in the replacement as
    // directives. Python's `.format` has no such reading.
    const raw = templates[i % templates.length]!.replace(
      "{task}",
      () => task,
    ).trim();
    const description = raw.charAt(0).toUpperCase() + raw.slice(1);
    plan.push({ description, status: "pending" });
  }
  return plan;
}

/**
 * `plan_task_steps` as an async-generator tool. Each yielded `{ state: {...} }`
 * reaches the adapter as a tool stream update, which it translates into an
 * AG-UI `StateSnapshotEvent`. The final return value is the tool result.
 */
export const planTaskSteps = tool({
  name: "plan_task_steps",
  description:
    "Plan the concrete steps required to accomplish a task and walk each step from 'pending' through 'in_progress' to 'completed' so the UI sees progress in real time.",
  inputSchema: z.object({
    task: z
      .string()
      .describe("Brief description of what the user wants to achieve"),
    // Optional, not defaulted, for the same reason as `steps` below: a default
    // keeps the field in the advertised `required` list, and Python requires
    // only `task`.
    context: z.string().optional().describe("Optional additional instructions"),
    // Optional rather than defaulted, which is the shape Python's
    // `List[Any] = None` advertises: an array in the schema, absent from
    // `required`. A `.default([])` would keep it in `required`, and dropping the
    // array type to accept anything would leave the model with no shape at all.
    // A model that omits it entirely reaches the fallback plan below.
    steps: z
      .array(z.unknown())
      .optional()
      .describe(
        "Ordered list of pending steps in gerund form. Each step is an object with `description`, a gerund phrase such as 'Sketching layout', and `status` set to 'pending'.",
      ),
  }),
  callback: async function* ({ task, context, steps }) {
    const brief = context ?? "";
    const normalized = normalizeSteps(steps);
    const workingSteps =
      normalized.length > 0
        ? normalized
        : fallbackSteps(task || "the task", brief);
    const mutable = workingSteps.map((s) => ({ ...s }));

    // Re-confirm the canonical shape now that the tool body owns the state
    // (predictState will already have streamed something similar from args).
    yield { state: { steps: mutable.map((s) => ({ ...s })) } };

    for (let i = 0; i < mutable.length; i++) {
      await sleep(300 + Math.random() * 500);
      mutable[i]!.status = "in_progress";
      yield { state: { steps: mutable.map((s) => ({ ...s })) } };

      await sleep(400 + Math.random() * 600);
      mutable[i]!.status = "completed";
      yield { state: { steps: mutable.map((s) => ({ ...s })) } };
    }

    return { task, context: brief, steps: mutable };
  },
});

/** Whether `value` is a non-empty array. Says nothing about the entries. */
function hasSteps(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

export const generativeUIConfig: StrandsAgentConfig = {
  stateContextBuilder: (input, prompt) => {
    const state = (input.state ?? {}) as Record<string, unknown>;
    const steps = state.steps;
    // Length-checked rather than truthiness-checked: an empty array is truthy
    // in JavaScript, so a plan recorded as present-but-empty would suppress
    // planning for the rest of the thread. Python's `if steps:` reads an empty
    // list as absent, and this matches it.
    if (hasSteps(steps)) {
      return (
        "A plan is already in progress. NEVER call plan_task_steps again unless the user explicitly " +
        "asks to restart. Discuss progress or ask clarifying questions instead.\n\n" +
        `Current steps:\n${JSON.stringify(steps, null, 2)}\n\nUser: ${prompt}`
      );
    }
    return prompt;
  },
  toolBehaviors: {
    plan_task_steps: {
      predictState: [
        { stateKey: "steps", tool: "plan_task_steps", toolArgument: "steps" },
      ],
      stateFromResult: async (ctx) => {
        const result = (ctx.resultData ?? {}) as { steps?: unknown };
        // Normalized rather than passed through, so what lands in shared state
        // is the same shape the page renders whatever the tool returned.
        const steps = normalizeSteps(result.steps);
        return steps.length > 0 ? { steps } : null;
      },
    },
  },
};

const SYSTEM_PROMPT = `You are an energetic project assistant who decomposes user goals into action plans.

Planning rules:
1. When the user asks for help with a task or making a plan, call plan_task_steps exactly once.
2. Do NOT call plan_task_steps again unless the user explicitly says to restart.
3. Generate 4-6 concise steps in gerund form (e.g., "Setting up repo", "Testing prototype") with status "pending".
4. After the tool call, send a short confirmation (<= 2 sentences) plus one emoji.
5. If the user is just chatting, respond conversationally without calling the tool.
6. If a plan already exists, reference the current steps instead of creating a new plan.
`;

export async function createAgenticGenerativeUIAgent(): Promise<StrandsAgent> {
  return new StrandsAgent({
    agent: new Agent({
      // Chat Completions API: the Responses adapter buffers tool-call argument
      // deltas, so the predictState mapping would have nothing to stream and
      // the steps would appear only once the call completed.
      model: await createModel({ openaiApi: "chat" }),
      tools: [planTaskSteps],
      systemPrompt: SYSTEM_PROMPT,
    }),
    name: "agentic_generative_ui",
    description: "AWS Strands agent with generative UI and state streaming",
    config: generativeUIConfig,
  });
}

runIfMain(import.meta.url, async () => {
  // Port first: it throws on a malformed PORT, and building the agent first
  // would surface a missing API key instead and hide the real complaint.
  const port = demoPort();
  const app = await createStrandsApp(await createAgenticGenerativeUIAgent(), {
    path: "/",
  });
  listenOrExit(app, "agentic-generative-ui", port);
});
