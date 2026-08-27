/**
 * Agentic Chat with Multimodal support for AWS Strands (TypeScript).
 *
 * Demonstrates multimodal message handling. When the user uploads an image,
 * the adapter converts AG-UI InputContent to Strands ContentBlock format and
 * passes it to whichever model the factory built, which the operator is
 * responsible for pointing at something that can read images.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, listenOrExit, runIfMain } from "../run-if-main";

export const SYSTEM_PROMPT = `
    You are a helpful assistant that can analyze images and documents.
    When the user shares an image, describe what you see in detail.
    When the user shares a document, summarize its contents.
    Always be descriptive and specific about visual content.
  `;

export async function createAgenticChatMultimodalAgent(): Promise<StrandsAgent> {
  return new StrandsAgent({
    agent: new Agent({
      model: await createModel(),
      systemPrompt: SYSTEM_PROMPT,
    }),
    name: "agentic_chat_multimodal",
    description: "Conversational Strands agent with multimodal content support",
  });
}

runIfMain(import.meta.url, async () => {
  // Port first: it throws on a malformed PORT, and building the agent first
  // would surface a missing API key instead and hide the real complaint.
  const port = demoPort();
  const app = await createStrandsApp(await createAgenticChatMultimodalAgent(), {
    path: "/",
  });
  listenOrExit(app, "agentic-chat-multimodal", port);
});
