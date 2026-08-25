import { Mastra } from "@mastra/core";
import { agenticChatAgent } from "./agents/agentic-chat";
import { humanInTheLoopAgent } from "./agents/human-in-the-loop";
import { backendToolRenderingAgent } from "./agents/backend-tool-rendering";
import { sharedStateAgent } from "./agents/shared-state";
import { toolBasedGenerativeUIAgent } from "./agents/tool-based-generative-ui";
import { interruptAgent } from "./agents/interrupt";
import { backgroundAgentsAgent } from "./agents/background-agents";
import { a2uiDynamicSchemaAgent, a2uiRecoveryAgent } from "./agents/a2ui";
import { a2uiFixedSchemaAgent } from "./agents/a2ui-fixed";
import { observationalMemoryAgent } from "./agents/observational-memory";
import { getStorage } from "./storage";

export const mastra = new Mastra({
  agents: {
    agentic_chat: agenticChatAgent,
    human_in_the_loop: humanInTheLoopAgent,
    backend_tool_rendering: backendToolRenderingAgent,
    shared_state: sharedStateAgent,
    tool_based_generative_ui: toolBasedGenerativeUIAgent,
    interrupt: interruptAgent,
    background_agents: backgroundAgentsAgent,
    a2ui_dynamic_schema: a2uiDynamicSchemaAgent,
    a2ui_recovery: a2uiRecoveryAgent,
    a2ui_fixed_schema: a2uiFixedSchemaAgent,
    observational_memory: observationalMemoryAgent,
  },
  // Instance-level storage is REQUIRED for suspend/resume (the `interrupt` demo:
  // Mastra persists the agentic-loop workflow snapshot on suspend and loads it
  // on `resumeStream`) and it also backs the Background Task manager below.
  storage: getStorage(),
  // Background Tasks are storage-backed; enable the manager (the
  // `background_agents` demo).
  backgroundTasks: { enabled: true },
});
