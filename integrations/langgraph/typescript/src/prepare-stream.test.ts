/**
 * Failing tests describing the target shape of an upcoming refactor of
 * `LangGraphAgent.prepareStream`. None of these helpers/exports exist yet;
 * the impl follows in a separate pass. These tests must currently fail
 * with messages naming the missing exports / behaviors.
 *
 * Refactor targets covered here:
 *
 *  1. `sanitizeAssistantMessages` — pure named helper extracted from the
 *     transformer branch's inline sanitizer. Strips `tool_call` content
 *     blocks from AI message `content` arrays and drops
 *     `response_metadata.output_version === "v1"`.
 *
 *  2. `transformerThreads` cache — shared across `clone()`s. Second
 *     request on the same threadId reuses the cached ThreadStream and the
 *     persistent `custom:agui` subscription instead of opening a new one.
 *
 *  3. Resume vs submitRun routing — when `forwardedProps.command.resume`
 *     is set AND a pending interrupt is reachable (either on the cached
 *     `streamingThread.interrupts` or on `agentState.tasks[].interrupts[]`),
 *     the transformer branch must call `streamingThread.respondInput(...)`
 *     instead of `streamingThread.submitRun(...)`. When no resume, the
 *     normal `submitRun(payload)` path runs.
 */

import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import type { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock ThreadStream returned from `client.threads.stream(threadId, …)`.
 * The transformer branch:
 *   - calls `thread.subscribe(["custom:agui"])` once per fresh entry,
 *   - registers a lifecycle watcher via `thread.onEvent(...)`,
 *   - calls either `thread.submitRun(...)` (normal) or
 *     `thread.respondInput(...)` (resume + pending interrupt).
 * `interrupts` on the thread surfaces live pending interrupts populated by
 * the SDK's lifecycle watcher.
 */
function makeThreadStream(opts?: {
  interrupts?: Array<{ interruptId: string; namespace: readonly string[] }>;
}) {
  const aguiSub = {
    pause: vi.fn(),
    resume: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      // Empty stream — these tests only care about the call-path before
      // events would be consumed.
    },
  };
  const thread: any = {
    interrupts: opts?.interrupts ?? [],
    subscribe: vi.fn().mockResolvedValue(aguiSub),
    onEvent: vi.fn().mockReturnValue(() => {}),
    submitRun: vi.fn().mockResolvedValue({ run_id: "run-from-submit" }),
    respondInput: vi.fn().mockResolvedValue(undefined),
  };
  return { thread, aguiSub };
}

/**
 * Make a config + a per-test cache of ThreadStreams keyed by threadId so
 * we can assert call counts across multiple `clone()`s or instances that
 * share the same underlying client.
 */
function makeConfig(opts?: {
  agentState?: any;
  threadStreams?: Map<string, ReturnType<typeof makeThreadStream>>;
}): {
  config: LangGraphAgentConfig;
  threadStreams: Map<string, ReturnType<typeof makeThreadStream>>;
  client: any;
} {
  const threadStreams = opts?.threadStreams ?? new Map();
  const agentState = opts?.agentState ?? {
    values: { messages: [] },
    tasks: [],
    next: [],
    metadata: { writes: {} },
  };

  const client: any = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      getState: vi.fn().mockResolvedValue(agentState),
      updateState: vi.fn().mockResolvedValue({
        checkpoint: { checkpoint_id: "ck-1" },
      }),
      // The hook under test.
      stream: vi.fn((threadId: string, _assistantId: string) => {
        let entry = threadStreams.get(threadId);
        if (!entry) {
          entry = makeThreadStream();
          threadStreams.set(threadId, entry);
        }
        return entry.thread;
      }),
    },
    runs: {
      cancel: vi.fn(),
      stream: vi.fn(),
    },
    assistants: {
      search: vi
        .fn()
        .mockResolvedValue([
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

  return { config, threadStreams, client };
}

function makeAgent(config: LangGraphAgentConfig) {
  const agent = new LangGraphAgent(config);
  const dispatched: any[] = [];
  agent.dispatchEvent = (event: any) => {
    dispatched.push(event);
    return event as any;
  };
  // prepareStream reads `this.activeRun!` immediately. In production this
  // is populated by `runAgentStream` before `prepareStream` runs; in
  // isolation we stub it.
  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
  };
  // A subscriber is read by `prepareStream` when it errors out. We stub
  // a no-op subscriber so the happy paths don't touch a real Observable.
  (agent as any).subscriber = {
    next: vi.fn(),
    error: vi.fn(),
    complete: vi.fn(),
    closed: false,
  };
  return { agent, dispatched };
}

function aiMsg(id: string, fields: Partial<any> = {}): LangGraphMessage {
  return { id, type: "ai", content: "", ...fields } as LangGraphMessage;
}

// ---------------------------------------------------------------------------
// 1. sanitizeAssistantMessages — pure helper
// ---------------------------------------------------------------------------

describe("sanitizeAssistantMessages (named export)", () => {
  /**
   * Dynamic import inside each test so module-load failure (named export
   * doesn't exist yet) surfaces as a clear failing assertion rather than
   * a suite-load error.
   */
  async function loadHelper() {
    const mod: any = await import("./agent");
    return mod.sanitizeAssistantMessages as (
      payloadInput: any,
    ) => any;
  }

  it("is exported from ./agent", async () => {
    const helper = await loadHelper();
    expect(typeof helper).toBe("function");
  });

  it("returns the input untouched when payloadInput has no messages", async () => {
    const helper = await loadHelper();
    const input = { foo: "bar" };
    expect(helper(input)).toEqual(input);
  });

  it("does not throw on null / undefined payloadInput", async () => {
    const helper = await loadHelper();
    expect(() => helper(undefined)).not.toThrow();
    expect(() => helper(null)).not.toThrow();
  });

  it("keeps text-only AI messages untouched", async () => {
    const helper = await loadHelper();
    const m = aiMsg("a1", { content: "hello world" });
    const result = helper({ messages: [m] });
    expect(result.messages[0]).toEqual(m);
  });

  it("leaves non-AI messages alone", async () => {
    const helper = await loadHelper();
    const human = { id: "h1", type: "human", content: "hi" };
    const tool = {
      id: "t1",
      type: "tool",
      tool_call_id: "tc-1",
      content: [{ type: "tool_call", id: "tc-1" }],
    };
    const result = helper({ messages: [human as any, tool as any] });
    expect(result.messages[0]).toEqual(human);
    expect(result.messages[1]).toEqual(tool);
  });

  it("flattens content to empty string when ONLY tool_call blocks remain", async () => {
    const helper = await loadHelper();
    const m = aiMsg("a1", {
      content: [
        { type: "tool_call", id: "tc-1", name: "search", args: {} },
        { type: "tool_call", id: "tc-2", name: "lookup", args: {} },
      ],
    });
    const result = helper({ messages: [m] });
    expect(result.messages[0].content).toBe("");
  });

  it("keeps remaining non-tool_call blocks when some are stripped", async () => {
    const helper = await loadHelper();
    const m = aiMsg("a1", {
      content: [
        { type: "text", text: "Here you go:" },
        { type: "tool_call", id: "tc-1", name: "search", args: {} },
      ],
    });
    const result = helper({ messages: [m] });
    expect(Array.isArray(result.messages[0].content)).toBe(true);
    expect(result.messages[0].content).toHaveLength(1);
    expect(result.messages[0].content[0]).toEqual({
      type: "text",
      text: "Here you go:",
    });
  });

  it("removes response_metadata.output_version v1 while preserving siblings", async () => {
    const helper = await loadHelper();
    const m = aiMsg("a1", {
      content: "ok",
      response_metadata: {
        output_version: "v1",
        model_name: "gpt-4o",
        finish_reason: "stop",
      },
    });
    const result = helper({ messages: [m] });
    const rm = (result.messages[0] as any).response_metadata;
    expect(rm).toBeDefined();
    expect(rm.output_version).toBeUndefined();
    expect(rm.model_name).toBe("gpt-4o");
    expect(rm.finish_reason).toBe("stop");
  });

  it("missing response_metadata does not throw", async () => {
    const helper = await loadHelper();
    const m = aiMsg("a1", { content: "ok" });
    expect(() => helper({ messages: [m] })).not.toThrow();
  });

  it("preserves the rest of the payloadInput shape (non-messages keys)", async () => {
    const helper = await loadHelper();
    const m = aiMsg("a1", { content: "ok" });
    const result = helper({ messages: [m], tools: ["t"], extra: { x: 1 } });
    expect(result.tools).toEqual(["t"]);
    expect(result.extra).toEqual({ x: 1 });
  });
});

// ---------------------------------------------------------------------------
// 2. transformerThreads cache reuse
// ---------------------------------------------------------------------------

describe("transformerThreads cache (acquireThreadStream)", () => {
  it("subscribes to custom:agui exactly once across two runs on the same threadId", async () => {
    const { config, threadStreams, client } = makeConfig();
    const { agent } = makeAgent(config);

    const input: any = {
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "u1", role: "user", content: "hi" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };

    await agent.prepareStream(input, ["events", "values"]);
    await agent.prepareStream({ ...input, runId: "run-2" }, ["events", "values"]);

    // Only one ThreadStream should ever be opened for thread-1.
    const streamCalls = client.threads.stream.mock.calls.filter(
      (c: any[]) => c[0] === "thread-1",
    );
    expect(streamCalls).toHaveLength(1);

    // And only one subscribe(...) on that stream. The v3 path subscribes
    // to the raw protocol channels (DEFAULT_STREAM_MODES), not the
    // compile-time `custom:agui` channel.
    const entry = threadStreams.get("thread-1")!;
    expect(entry.thread.subscribe).toHaveBeenCalledTimes(1);
    const subArg = entry.thread.subscribe.mock.calls[0][0];
    expect(Array.isArray(subArg)).toBe(true);
    expect(subArg).toContain("messages");
    expect(subArg).toContain("custom");
  });

  it("clone() shares the cache with its parent — second run via clone reuses subscription", async () => {
    const { config, threadStreams, client } = makeConfig();
    const { agent: parent } = makeAgent(config);

    const baseInput: any = {
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "u1", role: "user", content: "hi" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };

    await parent.prepareStream(baseInput, ["events", "values"]);

    const child = parent.clone() as LangGraphAgent;
    child.dispatchEvent = (e: any) => e as any;
    // clone() should share `transformerThreads` by reference.
    expect((child as any).transformerThreads).toBe((parent as any).transformerThreads);

    await child.prepareStream({ ...baseInput, runId: "run-2" }, ["events", "values"]);

    const entry = threadStreams.get("thread-1")!;
    expect(entry.thread.subscribe).toHaveBeenCalledTimes(1);
    expect(
      client.threads.stream.mock.calls.filter((c: any[]) => c[0] === "thread-1"),
    ).toHaveLength(1);
  });

  it("different threadIds get separate cache entries (subscribe called per thread)", async () => {
    const { config, threadStreams, client } = makeConfig();
    const { agent } = makeAgent(config);

    const baseInput: any = {
      runId: "run-1",
      messages: [{ id: "u1", role: "user", content: "hi" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };

    // Adjust the get/create to echo whatever threadId we ask for.
    (config.client as any).threads.get = vi.fn(async (id: string) => ({
      thread_id: id,
    }));
    (config.client as any).threads.create = vi.fn(async (payload: any) => ({
      thread_id: payload?.threadId ?? "thread-x",
    }));

    await agent.prepareStream({ ...baseInput, threadId: "thread-a" }, [
      "events",
      "values",
    ]);
    await agent.prepareStream({ ...baseInput, threadId: "thread-b" }, [
      "events",
      "values",
    ]);

    expect(threadStreams.has("thread-a")).toBe(true);
    expect(threadStreams.has("thread-b")).toBe(true);
    expect(threadStreams.get("thread-a")!.thread.subscribe).toHaveBeenCalledTimes(1);
    expect(threadStreams.get("thread-b")!.thread.subscribe).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Resume vs submitRun routing
// ---------------------------------------------------------------------------

describe("resume vs submitRun routing (transformer branch)", () => {
  it("no resume → submitRun is called with the prepared payload, respondInput is not", async () => {
    const { config, threadStreams } = makeConfig();
    const { agent } = makeAgent(config);

    await agent.prepareStream(
      {
        threadId: "thread-1",
        runId: "run-1",
        messages: [{ id: "u1", role: "user", content: "hi" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      } as any,
      ["events", "values"],
    );

    const entry = threadStreams.get("thread-1")!;
    expect(entry.thread.submitRun).toHaveBeenCalledTimes(1);
    expect(entry.thread.respondInput).not.toHaveBeenCalled();
  });

  it("resume + interrupt on streamingThread.interrupts → respondInput with that namespace/id", async () => {
    // Seed the ThreadStream with a live pending interrupt BEFORE the agent
    // runs, simulating that the lifecycle watcher already saw it during a
    // prior run (cached ThreadStream survived).
    const seededInterrupt = {
      interruptId: "intr-A",
      namespace: ["task-1"] as readonly string[],
    };
    const seeded = makeThreadStream({ interrupts: [seededInterrupt] });
    const threadStreams = new Map<string, ReturnType<typeof makeThreadStream>>();
    threadStreams.set("thread-1", seeded);

    const { config } = makeConfig({ threadStreams });
    const { agent } = makeAgent(config);
    // Pre-populate the cache so the agent reuses our seeded ThreadStream.
    (agent as any).transformerThreads.set("thread-1", {
      thread: seeded.thread,
      aguiSub: seeded.aguiSub,
    });

    await agent.prepareStream(
      {
        threadId: "thread-1",
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "approve" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { command: { resume: { ok: true } } },
      } as any,
      ["events", "values"],
    );

    expect(seeded.thread.respondInput).toHaveBeenCalledTimes(1);
    expect(seeded.thread.respondInput).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: seededInterrupt.namespace,
        interrupt_id: seededInterrupt.interruptId,
        response: { ok: true },
      }),
    );
    expect(seeded.thread.submitRun).not.toHaveBeenCalled();
  });

  it("resume + interrupt only on agentState.tasks fallback → respondInput uses task interrupt", async () => {
    const agentState = {
      values: { messages: [] },
      tasks: [
        {
          checkpoint: { checkpoint_ns: "ns-a|ns-b" },
          interrupts: [{ id: "intr-fallback", value: "needs approval" }],
        },
      ],
      next: [],
      metadata: { writes: {} },
    };
    const { config, threadStreams } = makeConfig({ agentState });
    const { agent } = makeAgent(config);

    await agent.prepareStream(
      {
        threadId: "thread-1",
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "approve" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { command: { resume: "yes" } },
      } as any,
      ["events", "values"],
    );

    const entry = threadStreams.get("thread-1")!;
    expect(entry.thread.respondInput).toHaveBeenCalledTimes(1);
    const call = entry.thread.respondInput.mock.calls[0][0];
    expect(call.interrupt_id).toBe("intr-fallback");
    expect(call.namespace).toEqual(["ns-a", "ns-b"]);
    expect(entry.thread.submitRun).not.toHaveBeenCalled();
  });

  it("resume but NO pending interrupt anywhere → falls back to submitRun", async () => {
    // Edge case: the user's command.resume is set but neither the cached
    // ThreadStream nor the agentState has a pending interrupt. We can't
    // call respondInput without an interrupt_id, so the refactor must
    // route to submitRun (current inline code does this — keep parity).
    const { config, threadStreams } = makeConfig();
    const { agent } = makeAgent(config);

    await agent.prepareStream(
      {
        threadId: "thread-1",
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "approve" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { command: { resume: { ok: true } } },
      } as any,
      ["events", "values"],
    );

    const entry = threadStreams.get("thread-1")!;
    expect(entry.thread.submitRun).toHaveBeenCalledTimes(1);
    expect(entry.thread.respondInput).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B5 — continuation mode is driven by forwardedProps.nodeName
//
// The mode check keyed on `this.activeRun.nodeName`, which is always
// undefined at prepareStream time, so "continue" was dead and every run fell
// through to "start". Driving it from nodeNameInput (forwardedProps.nodeName)
// mirrors the Python reader and restores continuation state updates.
// ---------------------------------------------------------------------------

describe("B5: continuation mode driven by forwardedProps.nodeName", () => {
  it("enters continue mode and updates state as the predecessor node", async () => {
    const { config, client } = makeConfig();
    client.assistants.getGraph = vi.fn().mockResolvedValue({
      nodes: [{ id: "planner" }, { id: "writer" }],
      edges: [{ source: "planner", target: "writer" }],
    });
    const { agent } = makeAgent(config);

    await agent.prepareStream(
      {
        threadId: "thread-1",
        runId: "run-1",
        messages: [{ id: "u1", role: "user", content: "go" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { nodeName: "writer" },
      } as any,
      ["events", "values"],
    );

    expect(client.threads.updateState).toHaveBeenCalledTimes(1);
    expect(client.threads.updateState).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ asNode: "planner" }),
    );
  });

  it("stays in start mode (no updateState) when nodeName is absent", async () => {
    const { config, client } = makeConfig();
    const { agent } = makeAgent(config);

    await agent.prepareStream(
      {
        threadId: "thread-1",
        runId: "run-1",
        messages: [{ id: "u1", role: "user", content: "go" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      } as any,
      ["events", "values"],
    );

    expect(client.threads.updateState).not.toHaveBeenCalled();
  });

  it("stays in start mode when nodeName is __end__", async () => {
    const { config, client } = makeConfig();
    const { agent } = makeAgent(config);

    await agent.prepareStream(
      {
        threadId: "thread-1",
        runId: "run-1",
        messages: [{ id: "u1", role: "user", content: "go" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { nodeName: "__end__" },
      } as any,
      ["events", "values"],
    );

    expect(client.threads.updateState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A4 — interrupt-only fast path keeps the STEP balanced
//
// When there are outstanding interrupts and no resume, prepareStream emits
// RUN_STARTED + interrupt-finish (RUN_FINISHED) inline. handleNodeChange with
// a set forwardedProps.nodeName opened a STEP that dangled past RUN_FINISHED
// (AG-UI verify forbids RUN_FINISHED while a step is active). The fast path
// must close the step first.
// ---------------------------------------------------------------------------

describe("A4: interrupt-only fast path STEP balance", () => {
  it("closes the node step before RUN_FINISHED when nodeName is set", async () => {
    const agentState = {
      values: { messages: [] },
      tasks: [{ interrupts: [{ id: "int-1", value: "approve?" }] }],
      next: ["writer"],
      metadata: { writes: {} },
    };
    const { config } = makeConfig({ agentState });
    const { agent, dispatched } = makeAgent(config);

    await agent.prepareStream(
      {
        threadId: "thread-1",
        runId: "run-1",
        messages: [{ id: "u1", role: "user", content: "go" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { nodeName: "writer" },
      } as any,
      ["events", "values"],
    );

    const types = dispatched.map((e) => e.type);
    expect(types.filter((t) => t === EventType.STEP_STARTED)).toHaveLength(1);
    expect(types.filter((t) => t === EventType.STEP_FINISHED)).toHaveLength(1);

    const runFinishedIdx = types.indexOf(EventType.RUN_FINISHED);
    const stepFinishedIdx = types.indexOf(EventType.STEP_FINISHED);
    expect(runFinishedIdx).toBeGreaterThan(-1);
    expect(stepFinishedIdx).toBeGreaterThan(-1);
    // Step closes BEFORE the run finishes, and nothing re-opens a step after.
    expect(stepFinishedIdx).toBeLessThan(runFinishedIdx);
    expect(types.slice(runFinishedIdx + 1)).not.toContain(EventType.STEP_STARTED);
  });
});
