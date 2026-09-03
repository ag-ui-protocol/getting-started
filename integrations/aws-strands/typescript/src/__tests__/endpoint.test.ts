import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import express from "express";
import type { AddressInfo } from "net";

import { addStrandsExpressEndpoint, addPing } from "../endpoint";
import { StrandsAgent } from "../agent";
import { minimalRunInput } from "./helpers";

/**
 * Minimal Strands stub that the endpoint's agent.run() iterates over. We
 * inject the ready-to-stream events directly so we don't depend on the
 * full Strands SDK at this layer.
 */
class FixedStrandsAgent extends StrandsAgent {
  private readonly _events: BaseEvent[];

  constructor(events: BaseEvent[]) {
    // We never use the template agent — override run() entirely.
    super({
      agent: {
        model: {},
        tools: [],
        toolRegistry: {
          list: () => [],
          add() {},
          get: () => undefined,
          remove() {},
        },
        sessionManager: undefined,
      } as unknown as import("@strands-agents/sdk").Agent,
      name: "fixed",
    });
    this._events = events;
  }

  async *run(_input: RunAgentInput): AsyncGenerator<BaseEvent, void, void> {
    for (const e of this._events) {
      yield e;
    }
  }
}

async function startApp(agent: StrandsAgent): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  addStrandsExpressEndpoint(app, agent, { path: "/" });
  addPing(app, "/ping");
  const server = await new Promise<import("http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("addStrandsExpressEndpoint", () => {
  it("streams SSE frames for each yielded event", async () => {
    const agent = new FixedStrandsAgent([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "hi" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "m" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ]);
    const { port, close } = await startApp(agent);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(minimalRunInput()),
      });
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      // SSE frames are "data: {json}\n\n"
      const frames = text
        .split("\n\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line.replace(/^data:\s*/, "")));
      expect(frames.map((f) => f.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_FINISHED,
      ]);
    } finally {
      await close();
    }
  });
});

describe("addPing", () => {
  it("responds with {status:'healthy'}", async () => {
    const agent = new FixedStrandsAgent([]);
    const { port, close } = await startApp(agent);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ping`);
      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body).toEqual({ status: "healthy" });
    } finally {
      await close();
    }
  });
});
