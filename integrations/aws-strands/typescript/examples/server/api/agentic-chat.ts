/**
 * Agentic Chat example for AWS Strands (TypeScript).
 *
 * Simple conversational agent. Frontend tools sent in RunAgentInput.tools
 * are automatically registered as proxy tools, so there is no server-side
 * `tool()` definition here: the LLM calls them and the browser runs them.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, listenOrExit, runIfMain } from "../run-if-main";

export const SYSTEM_PROMPT = `
    You are a helpful assistant.
    When the user greets you, always greet them back. Your greeting should always start with "Hello".
    Your greeting should also always ask (exact wording) "how can I assist you?"
  `;

export async function createAgenticChatAgent(): Promise<StrandsAgent> {
  return new StrandsAgent({
    agent: new Agent({
      model: await createModel(),
      systemPrompt: SYSTEM_PROMPT,
    }),
    name: "agentic_chat",
    description: "Conversational Strands agent with AG-UI streaming",
  });
}

runIfMain(import.meta.url, async () => {
  // Port first: it throws on a malformed PORT, and building the agent first
  // would surface a missing API key instead and hide the real complaint.
  const port = demoPort();
  const app = await createStrandsApp(await createAgenticChatAgent(), {
    path: "/",
  });
  listenOrExit(app, "agentic-chat", port);
});
