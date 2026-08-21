import { AGUIClientToolset } from "@ag-ui/adk-js";

import { createDojoAgent } from "./factory";

export function createAgenticChatAgent() {
  return createDojoAgent({
    name: "adk_js_agentic_chat",
    instruction: `You are a concise, helpful assistant.
When the user greets you, greet them and ask exactly "how can I assist you?"
The frontend may provide a change_background tool. Use it only when the user
asks to change the background.`,
    createTools: () => [new AGUIClientToolset()],
  });
}
