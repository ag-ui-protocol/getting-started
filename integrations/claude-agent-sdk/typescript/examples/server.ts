/**
 * Multi-agent server for Claude Agent SDK integration (TypeScript).
 *
 * The adapter manages the SDK lifecycle internally — the server just
 * calls adapter.run(input) and streams the resulting AG-UI events.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-xxx npx tsx examples/server.ts
 */

import http from "node:http";
import { EventEncoder } from "@ag-ui/encoder";
import type { RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { ClaudeAgentAdapter } from "../src";

import { createAgenticChatAdapter } from "./agentic_chat";
import { createBackendToolAdapter } from "./backend_tool_rendering";
import { createSharedStateAdapter } from "./shared_state";
import { createHumanInTheLoopAdapter } from "./human_in_the_loop";
import { createToolBasedGenerativeUiAdapter } from "./tool_based_generative_ui";

const adapters: Record<string, ClaudeAgentAdapter> = {
  agentic_chat: createAgenticChatAdapter(),
  backend_tool_rendering: createBackendToolAdapter(),
  shared_state: createSharedStateAdapter(),
  human_in_the_loop: createHumanInTheLoopAdapter(),
  tool_based_generative_ui: createToolBasedGenerativeUiAdapter(),
};

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname.replace(/^\//, "");

  if (req.method === "GET" && path === "health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", agents: Object.keys(adapters).length }));
    return;
  }

  if (req.method === "POST" && adapters[path]) {
    const adapter = adapters[path];

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString("utf-8");

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
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
    const parsed = RunAgentInputSchema.safeParse(parsedBody);
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
    const inputData: RunAgentInput = parsed.data;

    const encoder = new EventEncoder({
      accept: req.headers.accept ?? "text/event-stream",
    });

    res.writeHead(200, {
      "Content-Type": encoder.getContentType(),
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    adapter.run(inputData).subscribe({
      next: (event) => {
        res.write(encoder.encode(event));
      },
      error: (err) => {
        res.write(encoder.encode({
          type: "RUN_ERROR",
          threadId: inputData.threadId ?? "unknown",
          runId: inputData.runId ?? "unknown",
          message: err instanceof Error ? err.message : String(err),
        } as any));
        res.end();
      },
      complete: () => {
        res.end();
      },
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", availableRoutes: Object.keys(adapters) }));
}

function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY required");
    process.exit(1);
  }

  const port = parseInt(process.env.PORT ?? "8020", 10);
  const server = http.createServer(handleRequest);

  server.listen(port, "0.0.0.0", () => {
    console.log(`Claude Agent SDK (TypeScript) server running on http://localhost:${port}`);
    for (const name of Object.keys(adapters)) {
      console.log(`  POST http://localhost:${port}/${name}`);
    }
    console.log(`  GET  http://localhost:${port}/health`);
  });
}

main();
