/**
 * Citations example for AWS Strands (TypeScript).
 *
 * Demonstrates citations reaching the client attached to the message they
 * annotate. When a model answers over sources, the adapter folds each citation
 * into the assistant message's `metadata` under the `citations` key, so a
 * frontend can render the sources next to the answer without correlating a
 * second event stream back to it.
 *
 * The demo drives OpenAI's Responses API with the built-in `web_search` tool,
 * because that is the citation source reachable with the key the dojo already
 * has. Bedrock produces citations the same way over documents with citations
 * enabled; both arrive on the adapter as the same stream event and leave it in
 * the same shape, so what this demo shows is the wire behaviour rather than one
 * provider's quirk.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, listenOrExit, runIfMain } from "../run-if-main";

export const SYSTEM_PROMPT = `
    You are a research assistant. Answer questions by searching the web and
    grounding what you say in what you find.

    Always search before answering a question about the world, even one you
    believe you know, so the answer carries its sources. Keep answers to two or
    three sentences.
  `;

export async function createAgenticChatCitationsAgent(): Promise<StrandsAgent> {
  return new StrandsAgent({
    agent: new Agent({
      // API mode and the built-in tool are both named here rather than
      // inherited: citations only exist where the provider produces them, and
      // web search is the one built-in whose annotations Strands maps to
      // citations. The Python reference names them in the same place.
      model: await createModel({
        openaiApi: "responses",
        builtinTools: [{ type: "web_search" }],
      }),
      systemPrompt: SYSTEM_PROMPT,
    }),
    name: "agentic_chat_citations",
    description: "Strands agent whose answers carry the sources they came from",
  });
}

runIfMain(import.meta.url, async () => {
  // Port first: it throws on a malformed PORT, and building the agent first
  // would surface a missing API key instead and hide the real complaint.
  const port = demoPort();
  const app = await createStrandsApp(await createAgenticChatCitationsAgent(), {
    path: "/",
  });
  listenOrExit(app, "agentic-chat-citations", port);
});
