import { describe, it, expect } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import { EventType } from "@ag-ui/core";
import type { AgentStreamEvent } from "@strands-agents/sdk";

import {
  addCapabilities,
  capabilitiesFor,
  DEFAULT_CAPABILITIES,
} from "../endpoint";
import { StrandsAgent } from "../agent";
import { collect, scriptedStrandsAgent } from "./helpers";

async function startApp(configure: (app: express.Express) => void): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  configure(app);
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

describe("addCapabilities", () => {
  it("returns the default capabilities document", async () => {
    const { port, close } = await startApp((app) =>
      addCapabilities(app, "/capabilities"),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body).toEqual(DEFAULT_CAPABILITIES);
      expect(body.events.RUN_STARTED).toBe(true);
      expect(body.events.ACTIVITY_SNAPSHOT).toBe(false);
      expect(body.features.interrupts).toBe(true);
      expect(body.features.protobuf).toBe(true);
    } finally {
      await close();
    }
  });

  it("merges consumer overrides over the defaults", async () => {
    const { port, close } = await startApp((app) =>
      addCapabilities(app, "/capabilities", {
        events: { MESSAGES_SNAPSHOT: true, ACTIVITY_SNAPSHOT: true },
        features: { messagesSnapshot: true },
      }),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
      const body = await res.json();
      expect(body.events.MESSAGES_SNAPSHOT).toBe(true);
      expect(body.events.ACTIVITY_SNAPSHOT).toBe(true);
      // Untouched defaults survive the merge.
      expect(body.events.RUN_STARTED).toBe(true);
      expect(body.features.messagesSnapshot).toBe(true);
      expect(body.features.interrupts).toBe(true);
    } finally {
      await close();
    }
  });

  it("strips unknown override keys (typos don't leak into the JSON)", async () => {
    const { port, close } = await startApp((app) =>
      addCapabilities(app, "/capabilities", {
        events: {
          RUN_SRARTED: true, // typo
          Run_Started: false, // wrong case
          RUN_STARTED: true,
        } as unknown as Partial<(typeof DEFAULT_CAPABILITIES)["events"]>,
        features: {
          bogusFeature: true,
        } as unknown as Partial<(typeof DEFAULT_CAPABILITIES)["features"]>,
      }),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
      const body = await res.json();
      expect("RUN_SRARTED" in body.events).toBe(false);
      expect("Run_Started" in body.events).toBe(false);
      expect(body.events.RUN_STARTED).toBe(true);
      expect("bogusFeature" in body.features).toBe(false);
    } finally {
      await close();
    }
  });
});

describe("capabilitiesFor / addCapabilities { agent }", () => {
  function makeAgent(
    emitChunkEvents: boolean,
    emitMessagesSnapshot?: boolean,
  ): StrandsAgent {
    return new StrandsAgent({
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
      name: "cap",
      config: {
        emitChunkEvents,
        ...(emitMessagesSnapshot !== undefined && { emitMessagesSnapshot }),
      },
    });
  }

  it("advertises chunk events when the agent emits chunks", () => {
    const caps = capabilitiesFor(makeAgent(true));
    expect(caps.events.TEXT_MESSAGE_CHUNK).toBe(true);
    expect(caps.events.TOOL_CALL_CHUNK).toBe(true);
    expect(caps.events.REASONING_MESSAGE_CHUNK).toBe(true);
    // Triples flip off — the client will NOT observe them in chunk mode.
    expect(caps.events.TEXT_MESSAGE_START).toBe(false);
    expect(caps.events.TEXT_MESSAGE_CONTENT).toBe(false);
    expect(caps.events.TEXT_MESSAGE_END).toBe(false);
    expect(caps.events.TOOL_CALL_START).toBe(false);
    expect(caps.events.TOOL_CALL_END).toBe(false);
  });

  it("keeps triples when the agent is in default triple mode", () => {
    const caps = capabilitiesFor(makeAgent(false));
    expect(caps.events.TEXT_MESSAGE_CHUNK).toBe(false);
    expect(caps.events.TEXT_MESSAGE_START).toBe(true);
    expect(caps.events.TEXT_MESSAGE_END).toBe(true);
  });

  it("advertises citations in every configuration", () => {
    // Chunk mode drops TEXT_MESSAGE_END but re-emits its metadata as a final
    // metadata-only chunk, so the closing citation survives with or without
    // message snapshots. Nothing here may report a capability the runtime does
    // not deliver; `citations.test.ts` pins the delivery.
    expect(capabilitiesFor(makeAgent(false)).features.citations).toBe(true);
    expect(capabilitiesFor(makeAgent(true)).features.citations).toBe(true);
    expect(capabilitiesFor(makeAgent(false, false)).features.citations).toBe(
      true,
    );
    expect(capabilitiesFor(makeAgent(true, false)).features.citations).toBe(
      true,
    );
  });

  it("addCapabilities({ agent }) serves the derived matrix", async () => {
    const agent = makeAgent(true);
    const { port, close } = await startApp((app) =>
      addCapabilities(app, "/capabilities", { agent }),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
      const body = await res.json();
      expect(body.events.TEXT_MESSAGE_CHUNK).toBe(true);
      expect(body.events.TEXT_MESSAGE_START).toBe(false);
    } finally {
      await close();
    }
  });
});

describe("the advertised matrix against what a run publishes", () => {
  // An unmapped provider event: real, carries a payload no mapped AG-UI event
  // conveys, and the adapter has no branch for it. Same guardrail redaction
  // `raw-fallback.test.ts` uses to pin the fallback itself.
  const UNMAPPED_EVENT = {
    type: "modelRedactionEvent",
    outputRedaction: { text: "[redacted]" },
  } as unknown as AgentStreamEvent;

  async function runEmitsRaw(): Promise<boolean> {
    const events = await collect(scriptedStrandsAgent([UNMAPPED_EVENT]));
    return events.some((e) => e.type === EventType.RAW);
  }

  it("advertises RAW exactly when a run publishes one", async () => {
    // Read off a real run rather than hardcoded, so the flag cannot drift away
    // from the adapter again: the terminal fallback in `agent.ts` forwards
    // every unmapped Strands event as RAW, unconditionally.
    const emitsRaw = await runEmitsRaw();
    expect(
      emitsRaw,
      "no RAW event on the wire to compare the flag against",
    ).toBe(true);

    const { port, close } = await startApp((app) =>
      addCapabilities(app, "/capabilities"),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
      const body = await res.json();
      expect(body.events.RAW).toBe(emitsRaw);
    } finally {
      await close();
    }
  });

  it("keeps RAW advertised in chunk mode", async () => {
    // The fallback is not gated on `emitChunkEvents`, so neither is the flag.
    const emitsRaw = await runEmitsRaw();
    const agent = new StrandsAgent({
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
      name: "cap",
      config: { emitChunkEvents: true },
    });
    expect(capabilitiesFor(agent).events.RAW).toBe(emitsRaw);
  });
});
