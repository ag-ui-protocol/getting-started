import express, { type Request, type Response } from "express";
import { EventEncoder } from "@ag-ui/encoder";
import type { RunAgentInput } from "@ag-ui/core";
import {
  agenticChat,
  backendToolRendering,
  frontendOnlyToolCall,
  multiMessageRun,
  customEventRun,
  rawEventRun,
  runErrorScenario,
  stateEventsRun,
  reasoningRun,
  activitySnapshotRun,
  humanInTheLoopRun,
  tokenUsageRun,
  type FakeAgent,
} from "./fakeAgents";

// Mirrors the TS SDK test pattern (TextChunkAgent / FullToolCallAgent in
// middleware-chained-integration.test.ts) exposed over HTTP so non-JS
// clients can consume the exact same events on the wire. Each route is a
// fake "AbstractAgent": it converts a RunAgentInput into a canned event
// array and streams the events as SSE via @ag-ui/encoder.

const DEFAULT_PORT = Number(process.env.PORT ?? 8092);

function mountAgent(app: express.Express, route: string, agent: FakeAgent): void {
  app.post(route, (req: Request, res: Response) => {
    const input = req.body as RunAgentInput;
    const accept = req.header("accept") ?? undefined;
    const encoder = new EventEncoder({ accept });

    res.status(200);
    res.setHeader("Content-Type", encoder.getContentType());
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const events = agent(input);
    for (const event of events) {
      res.write(encoder.encodeSSE(event));
    }
    res.end();
  });
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  mountAgent(app, "/agentic_chat", agenticChat);
  mountAgent(app, "/backend_tool_rendering", backendToolRendering);
  mountAgent(app, "/frontend_only_tool", frontendOnlyToolCall);
  mountAgent(app, "/multi_message_run", multiMessageRun);
  mountAgent(app, "/custom_event", customEventRun);
  mountAgent(app, "/raw_event", rawEventRun);
  mountAgent(app, "/run_error", runErrorScenario);
  mountAgent(app, "/state_events", stateEventsRun);
  mountAgent(app, "/reasoning", reasoningRun);
  mountAgent(app, "/activity_snapshot", activitySnapshotRun);
  mountAgent(app, "/human_in_the_loop", humanInTheLoopRun);
  mountAgent(app, "/token_usage", tokenUsageRun);

  return app;
}

function main(): void {
  const app = createApp();
  app.listen(DEFAULT_PORT, () => {
    console.log(`TS fake-agent AG-UI server listening on http://localhost:${DEFAULT_PORT}`);
  });
}

// Run main when invoked directly (tsx server/main.ts) but allow importing
// createApp from tests.
const isDirectRun = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (isDirectRun) {
  main();
}

