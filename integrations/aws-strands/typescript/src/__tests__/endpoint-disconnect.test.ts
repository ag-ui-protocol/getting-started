/**
 * Client disconnect while streaming must `.return()` the iterator so the
 * agent generator's `finally` runs and `_activeRunsByThread` releases the
 * slot.
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import express from "express";
import type { AddressInfo } from "net";

import { addStrandsExpressEndpoint } from "../endpoint";
import { StrandsAgent } from "../agent";
import { minimalRunInput } from "./helpers";

/** Agent that streams slowly forever so we can test mid-stream abort. */
class SlowEndlessAgent extends StrandsAgent {
  public finallyRan = false;

  constructor() {
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
      name: "slow",
    });
  }

  async *run(_input: RunAgentInput): AsyncGenerator<BaseEvent, void, void> {
    try {
      yield { type: EventType.RUN_STARTED, threadId: "t", runId: "r" };
      for (let i = 0; i < 1000; i++) {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m",
          delta: `chunk-${i}`,
        } as BaseEvent;
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      this.finallyRan = true;
    }
  }
}

async function startApp(agent: StrandsAgent): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  addStrandsExpressEndpoint(app, agent, { path: "/" });
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

describe("client disconnect mid-stream", () => {
  it("invokes the agent generator's finally block when the client aborts", async () => {
    const agent = new SlowEndlessAgent();
    const { port, close } = await startApp(agent);
    try {
      const ctrl = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(minimalRunInput()),
      }).catch(() => undefined);
      // Give the handler time to start streaming, then abort.
      await new Promise((r) => setTimeout(r, 150));
      ctrl.abort();
      await pending;
      // Give the handler's `res.on('close')` callback time to fire and
      // propagate `.return()` into the generator.
      const deadline = Date.now() + 2000;
      while (!agent.finallyRan && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(agent.finallyRan).toBe(true);
    } finally {
      await close();
    }
  });
});
