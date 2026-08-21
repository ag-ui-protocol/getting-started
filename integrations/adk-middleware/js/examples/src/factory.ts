import type { RunAgentInput } from "@ag-ui/core";
import { ADKAgent } from "@ag-ui/adk-js";
import {
  Agent,
  type BaseLlm,
  InMemorySessionService,
  Runner,
  type ToolUnion,
} from "@google/adk";

import { OpenAICompatibleLlm } from "./openai-compatible-llm";

interface DojoAgentConfig {
  name: string;
  instruction: string;
  createTools: () => ToolUnion[];
}

function dojoUserId(input: RunAgentInput): string {
  const props = input.forwardedProps;
  if (props && typeof props === "object" && "userId" in props) {
    const userId = (props as Record<string, unknown>).userId;
    if (typeof userId === "string" && userId.length > 0) {
      return userId;
    }
  }
  return "dojo-user";
}

function dojoModel(): string | BaseLlm {
  const baseUrl = process.env.ADK_JS_OPENAI_BASE_URL;
  if (!baseUrl) {
    return process.env.ADK_JS_MODEL ?? "gemini-2.5-flash";
  }
  return new OpenAICompatibleLlm({
    baseUrl,
    model: process.env.ADK_JS_MODEL ?? "gemma-4-26b-a4b-it",
    apiKey: process.env.ADK_JS_API_KEY,
  });
}

/** Create one Dojo bridge with persistent sessions and fresh ADK tool trees. */
export function createDojoAgent(config: DojoAgentConfig): ADKAgent {
  const sessionService = new InMemorySessionService();
  const model = dojoModel();

  return new ADKAgent({
    userId: dojoUserId,
    usageProvider: process.env.ADK_JS_OPENAI_BASE_URL
      ? "openai-compatible"
      : "google",
    runnerFactory: () =>
      new Runner({
        appName: `ag_ui_dojo_${config.name}`,
        sessionService,
        agent: new Agent({
          name: config.name,
          model,
          instruction: config.instruction,
          tools: config.createTools(),
        }),
      }),
  });
}
