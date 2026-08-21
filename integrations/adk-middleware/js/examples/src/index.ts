import { createAgenticChatAgent } from "./agentic-chat";
import { createBackendToolRenderingAgent } from "./backend-tool-rendering";
import { createInterruptAgent } from "./interrupt";
import { createSharedStateAgent } from "./shared-state";
import { createToolBasedGenerativeUIAgent } from "./tool-based-generative-ui";

export function createADKJSDojoAgents() {
  return {
    agentic_chat: createAgenticChatAgent(),
    backend_tool_rendering: createBackendToolRenderingAgent(),
    tool_based_generative_ui: createToolBasedGenerativeUIAgent(),
    shared_state: createSharedStateAgent(),
    interrupt: createInterruptAgent(),
  };
}

export type ADKJSDojoAgents = ReturnType<typeof createADKJSDojoAgents>;
