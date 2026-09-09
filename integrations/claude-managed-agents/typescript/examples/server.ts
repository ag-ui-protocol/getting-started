/**
 * Dojo example server: one AG-UI endpoint per feature, each backed by a
 * managed agent. Provision the agents first with `pnpm setup:examples`.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-xxx pnpm dev:examples
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { EventEncoder } from "@ag-ui/encoder";
import type { RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { ManagedAgentsAgent } from "../src";
import type { BackendCustomTool } from "../src";
import { FEATURE_AGENTS } from "./agents";
import { isEntry } from "./entry";
import { IDS_PATH, type ProvisionedIds } from "./setup";

const loadIds = (): ProvisionedIds | undefined => {
  try {
    return JSON.parse(readFileSync(IDS_PATH, "utf-8")) as ProvisionedIds;
  } catch {
    console.warn(`No provisioned agents (${IDS_PATH} missing); run \`pnpm setup:examples\`. Serving no routes.`);
    return undefined;
  }
};

const getWeather: BackendCustomTool = {
  name: "get_weather",
  description: "Get the current weather for a location.",
  parameters: {
    type: "object",
    properties: { location: { type: "string", description: "City name" } },
    required: ["location"],
  },
  handler: (input) => {
    const location = (input as { location?: string }).location ?? "somewhere";
    return JSON.stringify({ location, temperature: 21, conditions: "sunny", humidity: 48, windSpeed: 12 });
  },
};

const BACKEND_TOOLS: Record<string, BackendCustomTool[]> = {
  backend_tool_rendering: [getWeather],
};

const buildAgents = (): Record<string, ManagedAgentsAgent> => {
  const ids = loadIds();
  const agents: Record<string, ManagedAgentsAgent> = {};
  if (!ids) return agents;
  const { environmentId, agents: agentIds } = ids;
  for (const spec of FEATURE_AGENTS) {
    const managedAgentId = agentIds[spec.feature];
    if (!managedAgentId) {
      console.warn(`No agent provisioned for ${spec.feature}; skipping. Re-run setup.`);
      continue;
    }
    agents[spec.feature] = new ManagedAgentsAgent({
      managedAgentId,
      environmentId,
      backendTools: BACKEND_TOOLS[spec.feature],
    });
  }
  return agents;
};

const agents = buildAgents();

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const route = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname.replace(/^\//, "");

  if (req.method === "GET" && route === "health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", agents: Object.keys(agents) }));
    return;
  }

  const agent = Object.hasOwn(agents, route) ? agents[route] : undefined;
  if (req.method !== "POST" || !agent) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", availableRoutes: Object.keys(agents) }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  // Parsed, not cast. A conformant client MAY omit `tools` and `context` —
  // absent and empty mean the same thing on the wire — so `as RunAgentInput`
  // promised `Tool[]` for a value that is `undefined` at runtime, and the
  // first `input.tools.length` downstream threw inside an already-open
  // response. The schema supplies the defaults and rejects the rest at the
  // edge, where a 400 is still possible.
  const parsed = RunAgentInputSchema.safeParse(body);
  if (!parsed.success) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Invalid RunAgentInput",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      }),
    );
    return;
  }
  const input: RunAgentInput = parsed.data;

  const encoder = new EventEncoder({ accept: req.headers.accept ?? "text/event-stream" });
  res.writeHead(200, {
    "Content-Type": encoder.getContentType(),
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  await streamRun(agent.clone(), input, encoder, res);
}

/**
 * Stream one run into an already-open SSE response, resolving when the run
 * finishes, fails, or the client goes away. Exported so the failure path can be
 * exercised without provisioning a managed agent.
 */
export function streamRun(
  agent: Pick<ManagedAgentsAgent, "run">,
  input: RunAgentInput,
  encoder: EventEncoder,
  res: http.ServerResponse,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const subscription = agent.run(input).subscribe({
      next: (event) => res.write(encoder.encode(event)),
      // A stream that failed must not look like one that finished: ending the
      // response cleanly would hand the client a silently truncated run, which
      // it has no way to tell from a complete one. Break the connection instead.
      error: (err: unknown) => {
        console.error("Run failed mid-stream:", err);
        res.destroy(err instanceof Error ? err : new Error(String(err)));
        resolve();
      },
      complete: () => {
        res.end();
        resolve();
      },
    });
    res.on("close", () => {
      subscription.unsubscribe();
      resolve();
    });
  });
}

/**
 * Node treats a rejected request handler as an unhandled rejection, which by
 * default takes the whole process down. Answer with a 500 when nothing has been
 * written yet, and otherwise break the stream rather than closing it cleanly.
 */
export const safeHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  handleRequest(req, res).catch((err: unknown) => {
    // An aborted request is the client's choice, not a server fault.
    const aborted = req.destroyed || res.destroyed || (err as { code?: string } | undefined)?.code === "ECONNRESET";
    if (!aborted) console.error("Request failed:", err);
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!res.writableEnded) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
};

function main() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error("Error: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)");
    process.exit(1);
  }
  const port = parseInt(process.env.PORT ?? "8024", 10);
  http.createServer(safeHandler).listen(port, "0.0.0.0", () => {
    console.log(`Claude Managed Agents server running on http://localhost:${port}`);
    for (const name of Object.keys(agents)) console.log(`  POST http://localhost:${port}/${name}`);
    console.log(`  GET  http://localhost:${port}/health`);
  });
}

// Only listen when this file is the process entry point, so importing the
// handlers (from a test, or another server) does not bind a port.
if (isEntry(import.meta.url)) {
  main();
}
