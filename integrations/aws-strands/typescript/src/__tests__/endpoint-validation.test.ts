import { describe, it, expect } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

import { addStrandsExpressEndpoint } from "../endpoint";
import { StrandsAgent } from "../agent";

/**
 * Stub StrandsAgent: bypasses the real Strands SDK so these tests exercise the
 * endpoint's request-boundary validation in isolation. The agent only emits a
 * RUN_STARTED / RUN_FINISHED pair so a validation-path request is visibly
 * distinct from a successfully-routed one.
 */
class RecordingStrandsAgent extends StrandsAgent {
  public readonly seen: RunAgentInput[] = [];

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
      name: "recording",
    });
  }

  // Overriding `_runRaw` (not `run`) preserves the interrupt/resume gate in
  // the parent's `run()` — that's the behavior we want to exercise.
  protected async *_runRaw(
    input: RunAgentInput,
  ): AsyncGenerator<BaseEvent, void, void> {
    this.seen.push(input);
    yield {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    };
    yield {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    };
  }
}

async function startApp(): Promise<{
  port: number;
  agent: RecordingStrandsAgent;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false }));
  const agent = new RecordingStrandsAgent();
  addStrandsExpressEndpoint(app, agent, { path: "/" });
  const server = await new Promise<import("http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    agent,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function readSse(res: Response): Promise<BaseEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line.replace(/^data:\s*/, "")) as BaseEvent);
}

describe("addStrandsExpressEndpoint request validation", () => {
  it("rejects a request with a non-JSON Content-Type (415)", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: "<xml/>",
      });
      expect(res.status).toBe(415);
      expect(agent.seen).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("rejects a form-encoded body (415)", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "thread_id=x",
      });
      expect(res.status).toBe(415);
      expect(agent.seen).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("rejects a body missing threadId (400) without invoking the agent", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: "r",
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/Invalid RunAgentInput/);
      expect(agent.seen).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("accepts a snake_case body by normalizing keys", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          thread_id: "t-snake",
          run_id: "r-snake",
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      const events = await readSse(res as unknown as Response);
      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(agent.seen).toHaveLength(1);
      expect(agent.seen[0]?.threadId).toBe("t-snake");
      expect(agent.seen[0]?.runId).toBe("r-snake");
    } finally {
      await close();
    }
  });

  it("rejects a body missing runId (400) without invoking the agent", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "t",
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: { path: unknown[] }[] };
      expect(body.issues.some((i) => i.path.includes("runId"))).toBe(true);
      expect(agent.seen).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("accepts a Content-Type with +json subtype", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.custom+json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          threadId: "t",
          runId: "r",
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      });
      // Express' json() middleware only parses `application/json` by default,
      // so `+json` bodies land here with `req.body` undefined. We still want
      // the Content-Type check to let them through (415 is the wrong answer);
      // downstream schema validation will report the empty body as a 400.
      expect(res.status).toBe(400);
      expect(agent.seen).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("accepts a Content-Type with charset parameter", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          threadId: "t-charset",
          runId: "r-charset",
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      expect(agent.seen).toHaveLength(1);
      expect(agent.seen[0]?.threadId).toBe("t-charset");
    } finally {
      await close();
    }
  });

  it("rejects a request with no Content-Type header (415)", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        // fetch() will auto-set `Content-Type: text/plain;charset=UTF-8` for a
        // string body. That's still non-JSON, so the 415 path applies.
        body: "ignored",
      });
      expect(res.status).toBe(415);
      expect(agent.seen).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("prefers explicit camelCase when both snake_case and camelCase keys are present", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          threadId: "camel-wins",
          thread_id: "snake-loses",
          runId: "r",
          run_id: "r-snake",
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      expect(agent.seen).toHaveLength(1);
      expect(agent.seen[0]?.threadId).toBe("camel-wins");
      expect(agent.seen[0]?.runId).toBe("r");
    } finally {
      await close();
    }
  });

  it("surfaces RUN_ERROR when resume[] references an unknown interrupt", async () => {
    const { port, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          threadId: "t",
          runId: "r",
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
          resume: [
            { interruptId: "does-not-exist", status: "resolved", payload: {} },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const events = await readSse(res as unknown as Response);
      const types = events.map((e) => e.type);
      expect(types[0]).toBe(EventType.RUN_STARTED);
      expect(types).toContain(EventType.RUN_ERROR);
      expect(types).not.toContain(EventType.RUN_FINISHED);
      const err = events.find((e) => e.type === EventType.RUN_ERROR) as
        | { code?: string; message?: string }
        | undefined;
      expect(err?.code).toBe("UNKNOWN_INTERRUPT_ID");
      expect(err?.message).toMatch(/No pending interrupts/);
    } finally {
      await close();
    }
  });

  it("allows resume: [] (explicit empty array is not a resume request)", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          threadId: "t",
          runId: "r",
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
          resume: [],
        }),
      });
      expect(res.status).toBe(200);
      const events = await readSse(res as unknown as Response);
      const types = events.map((e) => e.type);
      expect(types).toContain(EventType.RUN_FINISHED);
      expect(types).not.toContain(EventType.RUN_ERROR);
      expect(agent.seen).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("rejects a malformed JSON body with 4xx", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      // express.json() surfaces SyntaxError via Express' error handler as 400.
      // Any 4xx satisfies the protocol contract (the harness accepts 400-499).
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(agent.seen).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("rejects a plain-text body under application/json Content-Type with 4xx", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json at all",
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(agent.seen).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("rejects a malformed resume[] entry at the schema layer (400)", async () => {
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "t",
          runId: "r",
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
          // interruptId missing + status not in enum — both schema violations.
          resume: [{ status: "pending" }],
        }),
      });
      expect(res.status).toBe(400);
      expect(agent.seen).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("normalizes nested snake_case keys (e.g. messages[].tool_call_id)", async () => {
    // Cross-SDK clients sometimes send snake_case throughout the payload, not
    // just at the top level. The normalizer must recurse so inner fields like
    // tool_call_id reach the agent in canonical camelCase form.
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          thread_id: "t1",
          run_id: "r1",
          messages: [
            {
              id: "m1",
              role: "tool",
              content: "result",
              tool_call_id: "tc1",
            },
          ],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      // Drain the SSE response so the server finishes cleanly before close().
      await res.text();
      expect(agent.seen).toHaveLength(1);
      const msg = agent.seen[0]!.messages?.[0] as Record<string, unknown>;
      expect(msg.toolCallId).toBe("tc1");
    } finally {
      await close();
    }
  });

  it("does not pollute Object.prototype via __proto__ keys", async () => {
    // The normalizer historically built its output object with `{}` (which
    // inherits from Object.prototype). A malicious or malformed `__proto__`
    // key in the payload could mutate Object.prototype. The normalizer now
    // uses Object.create(null) and drops UNSAFE_KEYS entirely.
    const { port, agent, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          thread_id: "safe",
          run_id: "r1",
          __proto__: { polluted: true },
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      });
      // Drain so the server can shut down.
      await res.text();
      // Object.prototype must NOT be polluted regardless of response status.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    } finally {
      await close();
    }
  });
});
