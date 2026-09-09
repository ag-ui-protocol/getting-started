import { ADKJSAgent } from "@ag-ui/adk-js";
import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpointSingleRoute,
} from "@copilotkit/runtime/v2";
import { Agent, InMemorySessionService } from "@google/adk";
import { handle } from "hono/vercel";

export const runtime = "nodejs";
export const maxDuration = 60;

// Frontend tools declared by CopilotKit are attached to this agent by the
// bridge; nothing to wire here.
const rootAgent = new Agent({
  name: "assistant",
  model: process.env.ADK_JS_MODEL ?? "gemini-2.5-flash",
  instruction:
    "You are a concise assistant. Use frontend tools when they are available and relevant.",
});

const runtimeAgent = new ADKJSAgent({
  appName: "ag_ui_adk_js_starter",
  sessionService: new InMemorySessionService(),
  agent: rootAgent,
  userId: "starter-user",
});

const copilotRuntime = new CopilotRuntime({
  agents: { assistant: runtimeAgent },
  runner: new InMemoryAgentRunner(),
});

const endpoint = createCopilotEndpointSingleRoute({
  runtime: copilotRuntime,
  basePath: "/api/copilotkit",
});

export const POST = handle(endpoint);
