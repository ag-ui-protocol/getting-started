import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";

import { agenticChatAgent } from "./agents/agentic-chat";
import { agenticChatReasoningAgent } from "./agents/agentic-chat-reasoning";
import { agenticChatMultimodalAgent } from "./agents/agentic-chat-multimodal";
import { toolBasedGenerativeUIAgent } from "./agents/tool-based-generative-ui";
import { backendToolRenderingAgent } from "./agents/backend-tool-rendering";
import { humanInTheLoopAgent } from "./agents/human-in-the-loop";
import { interruptAgent } from "./agents/interrupt";
import { a2uiDynamicSchemaAgent, a2uiRecoveryAgent } from "./agents/a2ui";
import { a2uiFixedSchemaAgent } from "./agents/a2ui-fixed";
import { sharedStateAgent } from "./agents/shared-state";
import { observationalMemoryAgent } from "./agents/observational-memory";

export const mastra = new Mastra({
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 4111,
    host: "0.0.0.0",
  },
  agents: {
    agentic_chat: agenticChatAgent,
    agentic_chat_reasoning: agenticChatReasoningAgent,
    agentic_chat_multimodal: agenticChatMultimodalAgent,
    tool_based_generative_ui: toolBasedGenerativeUIAgent,
    backend_tool_rendering: backendToolRenderingAgent,
    human_in_the_loop: humanInTheLoopAgent,
    interrupt: interruptAgent,
    a2ui_dynamic_schema: a2uiDynamicSchemaAgent,
    a2ui_recovery: a2uiRecoveryAgent,
    a2ui_fixed_schema: a2uiFixedSchemaAgent,
    shared_state: sharedStateAgent,
    observational_memory: observationalMemoryAgent,
  },
  // File-backed (not ":memory:"): suspend/resume persists the agentic-loop
  // workflow snapshot to instance storage and loads it on resumeStream. An
  // in-memory store gives each pooled connection its own empty DB, so the
  // snapshot can't be found on resume ("No snapshot found for this workflow
  // run"). Powers the `interrupt` demo's remote resume (OSS-380).
  storage: new LibSQLStore({
    id: "mastra-storage",
    url: "file:../mastra.db",
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
});
