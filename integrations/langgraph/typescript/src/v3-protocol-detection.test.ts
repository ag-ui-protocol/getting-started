/**
 * Findings 1, 2, 5 — v3 protocol detection scope, listener leak, resume.
 *
 * Finding 1: only a protocol-404 at the v3 SUBSCRIBE means "no v3 route"
 *   → memoise v2 + fall back. A transient subscribe error falls back for
 *   this run WITHOUT memoising. A submit/respondInput failure is a real run
 *   error that must surface (throw), never a fallback / v2 memoisation.
 *
 * Finding 2: when submit/respondInput throws after a healthy subscribe, the
 *   lifecycle listener registered by watchForRootTerminal must be released
 *   (no leak).
 *
 * Finding 5: a canonical `input.resume[]` (with a pending interrupt) routes
 *   to respondInput, not a fresh submitRun.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 } as Response));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeThreadStream(opts: {
  subscribeReject?: Error;
  submitReject?: Error;
  interrupts?: Array<{ interruptId: string; namespace: readonly string[] }>;
}) {
  const aguiSub = {
    pause: vi.fn(),
    resume: vi.fn(),
    [Symbol.asyncIterator]: async function* () {},
  };
  const unsubscribe = vi.fn();
  const thread: any = {
    interrupts: opts.interrupts ?? [],
    subscribe: opts.subscribeReject
      ? vi.fn().mockRejectedValue(opts.subscribeReject)
      : vi.fn().mockResolvedValue(aguiSub),
    onEvent: vi.fn().mockReturnValue(unsubscribe),
    submitRun: opts.submitReject
      ? vi.fn().mockRejectedValue(opts.submitReject)
      : vi.fn().mockResolvedValue({ run_id: "run-from-submit" }),
    respondInput: vi.fn().mockResolvedValue(undefined),
  };
  return { thread, aguiSub, unsubscribe };
}

function makeConfig(streamEntry: ReturnType<typeof makeThreadStream>, agentState?: any) {
  const client: any = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      getState: vi.fn().mockResolvedValue(
        agentState ?? { values: { messages: [] }, tasks: [], next: [], metadata: { writes: {} } },
      ),
      updateState: vi.fn().mockResolvedValue({ checkpoint: { checkpoint_id: "ck-1" } }),
      stream: vi.fn(() => streamEntry.thread),
    },
    runs: {
      cancel: vi.fn(),
      stream: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: async function* () {} }),
    },
    assistants: {
      search: vi.fn().mockResolvedValue([
        { assistant_id: "asst-1", graph_id: "test-graph", config: {}, metadata: {} },
      ]),
      getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getSchemas: vi.fn().mockResolvedValue({
        input_schema: { properties: { messages: {} } },
        output_schema: { properties: { messages: {} } },
        config_schema: { properties: {} },
        context_schema: { properties: {} },
      }),
    },
  };
  const config: LangGraphAgentConfig = {
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
    client,
  };
  return { config, client };
}

function makeAgent(config: LangGraphAgentConfig) {
  const agent = new LangGraphAgent(config);
  agent.dispatchEvent = (e: any) => e as any;
  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
  };
  (agent as any).subscriber = { next: vi.fn(), error: vi.fn(), complete: vi.fn(), closed: false };
  return agent;
}

const baseInput = () => ({
  threadId: "thread-1",
  runId: "run-1",
  messages: [{ id: "u1", role: "user", content: "hi" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

// ---------------------------------------------------------------------------
// Finding 1 — subscribe-scoped detection
// ---------------------------------------------------------------------------

describe("protocol detection is scoped to subscribe", () => {
  it("subscribe protocol-404 → memoise v2 and fall back to runs.stream", async () => {
    const entry = makeThreadStream({
      subscribeReject: new Error("Protocol request failed: 404 Not Found"),
    });
    const { config, client } = makeConfig(entry);
    const agent = makeAgent(config);

    await agent.prepareStream(baseInput() as any, ["events", "values"]);

    expect((agent as any).v3Support.value).toBe(false);
    expect(client.runs.stream).toHaveBeenCalledTimes(1);
    expect(entry.thread.submitRun).not.toHaveBeenCalled();
  });

  it("transient subscribe error → fall back WITHOUT memoising v2", async () => {
    const entry = makeThreadStream({
      subscribeReject: new Error("Protocol request failed: 503 Service Unavailable"),
    });
    const { config, client } = makeConfig(entry);
    const agent = makeAgent(config);

    await agent.prepareStream(baseInput() as any, ["events", "values"]);

    // NOT memoised — the next run may retry v3.
    expect((agent as any).v3Support.value).toBeUndefined();
    // Still falls back to legacy for this run.
    expect(client.runs.stream).toHaveBeenCalledTimes(1);
  });

  it("submitRun failure surfaces as a run error (no fall back, no v2 memoise)", async () => {
    const entry = makeThreadStream({
      submitReject: new Error("Protocol request failed: 404 Not Found"),
    });
    const { config, client } = makeConfig(entry);
    const agent = makeAgent(config);

    await expect(agent.prepareStream(baseInput() as any, ["events", "values"])).rejects.toThrow();

    // Subscribe was healthy → v3 IS present, must not be memoised as v2.
    expect((agent as any).v3Support.value).not.toBe(false);
    // The error surfaced; we did NOT silently fall back to the legacy path.
    expect(client.runs.stream).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — no lifecycle-listener leak on submit failure
// ---------------------------------------------------------------------------

describe("submit failure releases the lifecycle listener", () => {
  it("calls the watchForRootTerminal unsubscribe when submitRun throws", async () => {
    const entry = makeThreadStream({
      submitReject: new Error("Protocol request failed: 404 Not Found"),
    });
    const { config } = makeConfig(entry);
    const agent = makeAgent(config);

    await expect(agent.prepareStream(baseInput() as any, ["events", "values"])).rejects.toThrow();

    expect(entry.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Finding 5 — canonical input.resume[] routes to respondInput
// ---------------------------------------------------------------------------

describe("canonical input.resume[] routes to respondInput", () => {
  it("uses respondInput (not submitRun) for a canonical resume with a pending interrupt", async () => {
    const seededInterrupt = { interruptId: "intr-A", namespace: ["task-1"] as readonly string[] };
    const entry = makeThreadStream({ interrupts: [seededInterrupt] });
    const { config } = makeConfig(entry);
    const agent = makeAgent(config);
    // Pre-populate the cache so the agent reuses our seeded ThreadStream.
    (agent as any).transformerThreads.set("thread-1", {
      thread: entry.thread,
      aguiSub: entry.aguiSub,
    });

    await agent.prepareStream(
      {
        ...baseInput(),
        // Canonical AG-UI resume — NOT the legacy forwardedProps.command.resume.
        resume: [{ interruptId: "intr-A", value: { approved: true } }],
      } as any,
      ["events", "values"],
    );

    expect(entry.thread.respondInput).toHaveBeenCalledTimes(1);
    expect(entry.thread.respondInput).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: seededInterrupt.namespace,
        interrupt_id: seededInterrupt.interruptId,
      }),
    );
    expect(entry.thread.submitRun).not.toHaveBeenCalled();
  });
});
