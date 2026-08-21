import assert from "node:assert/strict";

import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { ADKAgent } from "@ag-ui/adk-js";
import {
  Agent,
  FunctionTool,
  InMemorySessionService,
  Runner,
} from "@google/adk";
import { Type } from "@google/genai";

import { OpenAICompatibleLlm } from "../src/openai-compatible-llm";

const baseUrl =
  process.env.ADK_JS_OPENAI_BASE_URL ?? "http://127.0.0.1:8080/v1";
const modelName = process.env.ADK_JS_MODEL ?? "gemma-4-26b-a4b-it";

let toolInput: unknown;
const addNumbers = new FunctionTool({
  name: "add_numbers",
  description: "Add two numbers and return the exact sum.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      left: { type: Type.NUMBER },
      right: { type: Type.NUMBER },
    },
    required: ["left", "right"],
  },
  execute: (input) => {
    toolInput = input;
    const values = input as { left: number; right: number };
    return { result: values.left + values.right };
  },
});

const runner = new Runner({
  appName: "adk_js_local_llama_smoke",
  sessionService: new InMemorySessionService(),
  agent: new Agent({
    name: "local_llama_smoke",
    model: new OpenAICompatibleLlm({
      baseUrl,
      model: modelName,
      apiKey: process.env.ADK_JS_API_KEY,
    }),
    instruction:
      "Always use add_numbers for arithmetic. After the tool returns, answer with the exact numeric result.",
    tools: [addNumbers],
  }),
});

const input: RunAgentInput = {
  threadId: `local-llama-${Date.now()}`,
  runId: crypto.randomUUID(),
  state: {},
  messages: [
    {
      id: crypto.randomUUID(),
      role: "user",
      content: "Use the tool to add 20 and 22. What is the result?",
    },
  ],
  tools: [],
  context: [],
  forwardedProps: {},
};

async function main(): Promise<void> {
  const events = await new Promise<BaseEvent[]>((resolve, reject) => {
    const collected: BaseEvent[] = [];
    new ADKAgent({
      runner,
      userId: "local-smoke-user",
      usageProvider: "openai-compatible",
    })
      .run(input)
      .subscribe({
        next: (event) => collected.push(event),
        error: reject,
        complete: () => resolve(collected),
      });
  });

  const runError = events.find((event) => event.type === EventType.RUN_ERROR);
  assert.equal(
    runError,
    undefined,
    `AG-UI run failed: ${JSON.stringify(runError)}`,
  );
  assert.deepEqual(toolInput, { left: 20, right: 22 });
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TOOL_CALL_RESULT &&
        typeof event.content === "string" &&
        event.content.includes("42"),
    ),
    "Expected an AG-UI tool result containing 42.",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT &&
        typeof event.delta === "string" &&
        event.delta.includes("42"),
    ),
    "Expected the local model's final answer to contain 42.",
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);

  console.log(
    `Local ADK-JS smoke passed with ${modelName}: ${events.length} AG-UI events, backend tool executed.`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
