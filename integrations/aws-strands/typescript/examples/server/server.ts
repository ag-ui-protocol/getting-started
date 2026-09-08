/**
 * Verification server: mounts every TS example on the same paths the Python
 * reference server uses, so both implementations can be driven by the same
 * curl payloads.
 *
 * Every agent comes from the factory its own file under `./api` exports, which
 * is also the file the dojo's code panel shows for that demo. Building an agent
 * here instead would put a second copy of it in the repo, and the dojo would go
 * on showing the copy that is not answering.
 */
import express from "express";
import cors from "cors";
import type { StrandsAgent } from "@ag-ui/aws-strands";
import {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
} from "@ag-ui/aws-strands/server";
import { corsPolicyFromEnv } from "./cors";
import { demoPort, listenOrExit, runIfMain } from "./run-if-main";
import { createA2UIDynamicSchemaAgent } from "./api/a2ui-dynamic-schema";
import { createA2UIFixedSchemaAgent } from "./api/a2ui-fixed-schema";
import { createA2UIRecoveryAgent } from "./api/a2ui-recovery";
import { createAgenticChatAgent } from "./api/agentic-chat";
import { createAgenticChatMultimodalAgent } from "./api/agentic-chat-multimodal";
import { createAgenticChatCitationsAgent } from "./api/agentic-chat-citations";
import { createAgenticChatReasoningAgent } from "./api/agentic-chat-reasoning";
import { createAgenticGenerativeUIAgent } from "./api/agentic-generative-ui";
import { createBackendToolRenderingAgent } from "./api/backend-tool-rendering";
import { createHumanInTheLoopAgent } from "./api/human-in-the-loop";
import { createInterruptAgent } from "./api/interrupt";
import { createMultiAgentGraphAgent } from "./api/multi-agent";
import { createPredictiveStateUpdatesAgent } from "./api/predictive-state-updates";
import { createSharedStateAgent } from "./api/shared-state";
import { createToolBasedGenerativeUIAgent } from "./api/tool-based-generative-ui";

/**
 * Mount path to the factory that builds the agent answering on it.
 *
 * The paths are the hyphenated ones `apps/dojo/src/agents.ts` maps for the
 * `aws-strands-typescript` integration, and they match the Python reference
 * server's mounts.
 */
export const DEMOS: Record<string, () => Promise<StrandsAgent>> = {
  "agentic-chat": createAgenticChatAgent,
  "agentic-chat-citations": createAgenticChatCitationsAgent,
  "agentic-chat-reasoning": createAgenticChatReasoningAgent,
  "agentic-chat-multimodal": createAgenticChatMultimodalAgent,
  "backend-tool-rendering": createBackendToolRenderingAgent,
  "shared-state": createSharedStateAgent,
  "agentic-generative-ui": createAgenticGenerativeUIAgent,
  "human-in-the-loop": createHumanInTheLoopAgent,
  // `schedule_meeting` pauses itself mid-body by calling the tool context's
  // `interrupt()`, and resumes with the time the user picked.
  interrupt: createInterruptAgent,
  // `write_document` is a FRONTEND tool; the predictState mapping tells the UI
  // to paint `state.document` from its streaming args.
  "predictive-state-updates": createPredictiveStateUpdatesAgent,
  "tool-based-generative-ui": createToolBasedGenerativeUIAgent,
  // A Graph orchestrator rather than a single Agent: the adapter detects the
  // missing `.model` accessor and drives `.stream()` instead of cloning a
  // per-thread agent.
  "multi-agent": createMultiAgentGraphAgent,
  // Neither wires an a2ui TOOL. Each still sets `config.a2ui` to name its
  // catalog, and the CopilotKit runtime sends `injectA2UITool`; the adapter
  // infers the model and injects `generate_a2ui`, which runs the toolkit's
  // validate and retry recovery loop.
  "a2ui-dynamic-schema": createA2UIDynamicSchemaAgent,
  "a2ui-recovery": createA2UIRecoveryAgent,
  // Unlike the auto-injected demos above, the fixed-schema agent wires its OWN
  // backend tools (search_flights / search_hotels) that return a fixed-layout
  // a2ui_operations envelope. The runtime's A2UIMiddleware paints it directly;
  // no generate_a2ui injection (see apps/dojo/src/agents.ts and its
  // STRANDS_A2UI_INJECT_AGENTS list).
  "a2ui-fixed-schema": createA2UIFixedSchemaAgent,
};

/** Build the dojo app with every demo in {@link DEMOS} mounted. */
export async function createDojoApp(): Promise<express.Express> {
  const app = express();
  // Browser origins allowed to read this server's responses, from
  // `CORS_ALLOW_ORIGINS`. See ./cors.ts for what the variable accepts.
  app.use(cors({ origin: corsPolicyFromEnv().origin }));
  // Matches `createStrandsApp`, which every standalone demo here uses. A
  // smaller cap only shows up as a 413 on the multimodal demo, where an
  // uploaded image arrives inline as a data URL.
  app.use(express.json({ limit: "50mb" }));
  addPing(app, "/ping");
  addCapabilities(app, "/capabilities");

  for (const [path, createAgent] of Object.entries(DEMOS)) {
    let agent: StrandsAgent;
    try {
      agent = await createAgent();
    } catch (error) {
      // Named rather than re-thrown bare: every factory fails the same way from
      // out here (a missing key, a model that would not build), and without the
      // path the only clue is that server.ts did not start.
      throw new Error(`Could not build the agent for /${path}`, {
        cause: error,
      });
    }
    // One registration per demo. The dojo requests most of these paths with a
    // trailing slash and human-in-the-loop without one, and Express routes
    // non-strictly by default, so `/agentic-chat` answers `/agentic-chat/` too.
    // demo-agents.test.ts asserts both spellings against a booted app.
    addStrandsExpressEndpoint(app, agent, { path: `/${path}` });
  }

  return app;
}

runIfMain(import.meta.url, async () => {
  // Port first, and listenOrExit rather than a bare `listen`, for the same two
  // reasons every demo under ./api has: a malformed PORT should not surface as
  // whatever the first factory complains about, and a bind failure should not
  // print a success line and exit 0.
  const port = demoPort(8022);
  listenOrExit(await createDojoApp(), "dojo", port);
});
