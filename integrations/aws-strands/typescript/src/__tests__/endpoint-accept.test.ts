import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import express from "express";
import type { AddressInfo } from "net";

import { addStrandsExpressEndpoint } from "../endpoint";
import { StrandsAgent } from "../agent";
import { minimalRunInput } from "./helpers";

class FixedAgent extends StrandsAgent {
  private readonly _events: BaseEvent[];
  constructor(events: BaseEvent[]) {
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
    for (const e of this._events) yield e;
  }
}

async function startApp(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  addStrandsExpressEndpoint(
    app,
    new FixedAgent([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "hi" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "m" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ]),
    { path: "/" },
  );
  const server = await new Promise<import("http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
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

async function postWithAccept(port: number, accept: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept },
    body: JSON.stringify(minimalRunInput()),
  });
  return res.headers.get("content-type") ?? "";
}

describe("addStrandsExpressEndpoint content negotiation", () => {
  it("returns SSE for wildcard Accept (does not silently choose protobuf)", async () => {
    const { port, close } = await startApp();
    try {
      const ct = await postWithAccept(port, "*/*");
      expect(ct.toLowerCase()).toContain("text/event-stream");
      expect(ct.toLowerCase()).not.toContain(
        "application/vnd.ag-ui.event+proto",
      );
    } finally {
      await close();
    }
  });

  it("returns SSE when Accept is missing", async () => {
    const { port, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(minimalRunInput()),
      });
      const ct = res.headers.get("content-type") ?? "";
      expect(ct.toLowerCase()).toContain("text/event-stream");
    } finally {
      await close();
    }
  });

  it("returns SSE for Accept: text/event-stream", async () => {
    const { port, close } = await startApp();
    try {
      const ct = await postWithAccept(port, "text/event-stream");
      expect(ct.toLowerCase()).toContain("text/event-stream");
    } finally {
      await close();
    }
  });

  it("returns protobuf when the client explicitly asks for it", async () => {
    const { port, close } = await startApp();
    try {
      const ct = await postWithAccept(
        port,
        "application/vnd.ag-ui.event+proto",
      );
      expect(ct.toLowerCase()).toContain("application/vnd.ag-ui.event+proto");
    } finally {
      await close();
    }
  });

  it("returns SSE when protobuf is listed but explicitly refused with q=0", async () => {
    const { port, close } = await startApp();
    try {
      const ct = await postWithAccept(
        port,
        "application/vnd.ag-ui.event+proto;q=0, text/event-stream",
      );
      expect(ct.toLowerCase()).toContain("text/event-stream");
      expect(ct.toLowerCase()).not.toContain(
        "application/vnd.ag-ui.event+proto",
      );
    } finally {
      await close();
    }
  });

  it("still selects protobuf at a low but non-zero q-factor", async () => {
    const { port, close } = await startApp();
    try {
      const ct = await postWithAccept(
        port,
        "application/vnd.ag-ui.event+proto;q=0.1",
      );
      expect(ct.toLowerCase()).toContain("application/vnd.ag-ui.event+proto");
    } finally {
      await close();
    }
  });

  it("still honours protobuf when listed alongside SSE with a q-factor", async () => {
    const { port, close } = await startApp();
    try {
      const ct = await postWithAccept(
        port,
        "application/vnd.ag-ui.event+proto;q=1, text/event-stream;q=0.5",
      );
      expect(ct.toLowerCase()).toContain("application/vnd.ag-ui.event+proto");
    } finally {
      await close();
    }
  });
});
