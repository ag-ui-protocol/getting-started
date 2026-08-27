/**
 * Agentic Chat with Reasoning example for AWS Strands (TypeScript).
 *
 * Demonstrates reasoning/thinking event streaming. When the underlying model
 * supports extended thinking, the adapter emits REASONING_* events that the
 * frontend can display as a "thinking" indicator.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, listenOrExit, runIfMain } from "../run-if-main";

export const SYSTEM_PROMPT = `
    You are a helpful assistant that thinks through problems step by step.
    When the user greets you, always greet them back. Your greeting should always start with "Hello".
    Your greeting should also always ask (exact wording) "how can I assist you?"
    When reasoning about a problem, break it down into clear steps before answering.
  `;

export async function createAgenticChatReasoningAgent(): Promise<StrandsAgent> {
  return new StrandsAgent({
    agent: new Agent({
      // API mode named rather than inherited: reasoning summaries are what
      // this demo exists to show, and they only come back on the Responses
      // API. The Python reference names it here for the same reason.
      model: await createModel({ openaiApi: "responses", reasoning: true }),
      systemPrompt: SYSTEM_PROMPT,
    }),
    name: "agentic_chat_reasoning",
    description:
      "Conversational Strands agent with reasoning/thinking event streaming",
  });
}

runIfMain(import.meta.url, async () => {
  // Port first: it throws on a malformed PORT, and building the agent first
  // would surface a missing API key instead and hide the real complaint.
  const port = demoPort();
  const app = await createStrandsApp(await createAgenticChatReasoningAgent(), {
    path: "/",
  });
  listenOrExit(app, "agentic-chat-reasoning", port);
});
