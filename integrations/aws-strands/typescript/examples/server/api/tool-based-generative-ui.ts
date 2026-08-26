/**
 * Tool-based Generative UI example for AWS Strands (TypeScript).
 *
 * The `generate_haiku` tool is declared on the frontend via `useFrontendTool`
 * — the @ag-ui/aws-strands adapter auto-registers it as a proxy tool when
 * `RunAgentInput.tools` arrives, so the backend does not register a native
 * tool here. Strands invokes the proxy with the structured haiku args, the
 * adapter halts the run after the proxy returns, and the browser renders the
 * haiku card from the streamed `TOOL_CALL_*` events.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { corsPolicyFromEnv } from "../cors";
import { createModel } from "../model-factory";

async function main(): Promise<void> {
  const strandsAgent = new Agent({
    model: await createModel(),
    tools: [],
    systemPrompt: `You are a creative haiku generator.

When the user asks for a haiku, ALWAYS call the \`generate_haiku\` tool with:
- 3 lines of haiku in Japanese
- 3 lines of haiku translated to English
- One relevant image_name from the provided list
- A CSS gradient for the card background

Do not respond with plain text — always use the tool.`,
  });

  const aguiAgent = new StrandsAgent({
    agent: strandsAgent,
    name: "tool_based_generative_ui",
    description: "AWS Strands haiku generator with frontend-rendered tool",
  });

  // The one example here that demonstrates the cross-origin opt-in. Its
  // siblings pass no `corsOrigin` and stay closed, and so could this one: the
  // dojo reaches every example from its own Next route handler, server side,
  // where CORS is not in the path at all. It carries the opt-in so the wiring
  // is written down somewhere runnable, for whoever points a browser page
  // straight at this server. `CORS_ALLOW_ORIGINS` (comma-separated) chooses
  // the origins; see ../cors.ts.
  const corsPolicy = corsPolicyFromEnv();

  const app = await createStrandsApp(aguiAgent, {
    path: "/",
    corsOrigin: corsPolicy.origin,
  });
  const port = Number(process.env.PORT ?? 8000);
  app.listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
    console.log(`Browser origins allowed: ${corsPolicy.description}`);
  });
}

void main();
