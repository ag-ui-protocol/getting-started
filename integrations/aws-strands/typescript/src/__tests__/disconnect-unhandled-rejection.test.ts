/**
 * A throwing generator finally on client disconnect must not produce an
 * unhandled rejection (which crashes the Node process on default
 * settings).
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import express from "express";
import type { AddressInfo } from "net";

import { addStrandsExpressEndpoint } from "../endpoint";
import { StrandsAgent } from "../agent";
import { minimalRunInput, scriptedAgent } from "./helpers";

class BooleanAgent extends StrandsAgent {
  constructor() {
    super({ agent: scriptedAgent(), name: "boom" });
  }

  async *run(_input: RunAgentInput): AsyncGenerator<BaseEvent, void, void> {
    try {
      yield { type: EventType.RUN_STARTED, threadId: "t", runId: "r" };
      for (let i = 0; i < 1000; i++) {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m",
          delta: "chunk",
        } as BaseEvent;
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      throw new Error("cleanup-hook-boom");
    }
  }
}

describe("endpoint disconnect + throwing generator finally", () => {
  it("does NOT surface an unhandled rejection when the generator's finally throws", async () => {
    const agent = new BooleanAgent();
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    addStrandsExpressEndpoint(app, agent, { path: "/" });
    const server = await new Promise<import("http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
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
      await new Promise((r) => setTimeout(r, 100));
      ctrl.abort();
      await pending;
      // Drain the microtask queue + a few more macrotask ticks so any
      // unhandled rejection would have surfaced.
      await new Promise((r) => setTimeout(r, 200));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve(undefined))),
      );
    }
  });
});
