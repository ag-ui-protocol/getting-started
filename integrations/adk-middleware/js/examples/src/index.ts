import type { AbstractAgent } from "@ag-ui/client";
import { createAgenticChatAgent } from "./agentic-chat";
import { createBackendToolRenderingAgent } from "./backend-tool-rendering";
import { createInterruptAgent } from "./interrupt";
import { createMultiAgentAgent } from "./multi-agent";
import { createSharedStateAgent } from "./shared-state";
import { createToolBasedGenerativeUIAgent } from "./tool-based-generative-ui";

export type ADKJSDojoAgentName =
  | "agentic_chat"
  | "backend_tool_rendering"
  | "tool_based_generative_ui"
  | "shared_state"
  | "interrupt"
  | "multi_agent";

export type ADKJSDojoAgents = Record<ADKJSDojoAgentName, AbstractAgent>;

export function createADKJSDojoAgents(): ADKJSDojoAgents {
  return {
    agentic_chat: createAgenticChatAgent(),
    backend_tool_rendering: createBackendToolRenderingAgent(),
    tool_based_generative_ui: createToolBasedGenerativeUIAgent(),
    shared_state: createSharedStateAgent(),
    interrupt: createInterruptAgent(),
    multi_agent: createMultiAgentAgent(),
  };
}
