import type { RunAgentInput } from "@ag-ui/core";
import { ADKJSAgent, type ADKJSSubagentMode } from "@ag-ui/adk-js";
import {
  Agent,
  type BaseLlm,
  InMemorySessionService,
  type RunnableRoot,
  type ToolUnion,
} from "@google/adk";

import { OpenAICompatibleLlm } from "./openai-compatible-llm";

export interface DojoAgentConfig {
  name: string;
  instruction?: string;
  createTools?: () => ToolUnion[];
  /** Build a custom root (for example a `Workflow`) instead of a flat Agent. */
  createRoot?: (model: string | BaseLlm) => RunnableRoot;
  /** Override the environment-selected model (tests inject a scripted one). */
  model?: string | BaseLlm;
  subagents?: ADKJSSubagentMode;
}

// Demo-only: the Dojo has no authentication, so it reads userId from
// client-supplied forwardedProps to exercise per-user session scoping. Real
// applications must resolve userId from server-side authentication instead —
// a forged forwardedProps.userId would expose another user's threads.
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

export function dojoModel(): string | BaseLlm {
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
export function createDojoAgent(config: DojoAgentConfig): ADKJSAgent {
  const sessionService = new InMemorySessionService();
  const model = config.model ?? dojoModel();
  const buildRoot = (): RunnableRoot =>
    config.createRoot
      ? config.createRoot(model)
      : new Agent({
          name: config.name,
          model,
          ...(config.instruction ? { instruction: config.instruction } : {}),
          tools: config.createTools?.() ?? [],
        });

  return new ADKJSAgent({
    userId: dojoUserId,
    usageProvider:
      process.env.ADK_JS_OPENAI_BASE_URL && !config.model
        ? "openai-compatible"
        : "google",
    appName: `ag_ui_dojo_${config.name}`,
    sessionService,
    // A factory so roots with per-run state (a Workflow) start fresh each run.
    agent: buildRoot,
    ...(config.subagents ? { subagents: config.subagents } : {}),
  });
}
