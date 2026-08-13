/**
 * Unit tests for the v3 event bundle's `tasks` and `tools` channel
 * translation (handleStreamEventsV3):
 *
 *  - `tools` channel  → TOOL_CALL_RESULT on tool-finished / tool-error,
 *                       nothing on tool-started / tool-output-delta.
 *  - `tasks` channel  → CUSTOM OnInterrupt, deduped against the post-run
 *                       threads.getState() interrupt scan so one interrupt
 *                       renders exactly once.
 */

import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the config with a getState result the post-run scan will read. */
function makeConfig(getStateResult: any): LangGraphAgentConfig {
  return {
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
    client: {
      threads: {
        getState: vi.fn().mockResolvedValue(getStateResult),
      },
      runs: { cancel: vi.fn() },
    } as any,
  };
}

const EMPTY_STATE = {
  values: { messages: [] },
  tasks: [],
  next: [],
  metadata: { writes: {} },
};

/** A v3 ProtocolEvent: `{ method, params: { data } }`. */
function makeChunk(method: string, data: any) {
  return {
    type: "event",
    seq: 0,
    method,
    params: { namespace: [], timestamp: 0, data },
  };
}

async function* makeStream(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

function makeStreamArg(chunks: any[]) {
  return {
    streamResponse: makeStream(chunks),
    state: { ...EMPTY_STATE },
  };
}

/**
 * Drive handleStreamEventsV3 over the given chunks and return every
 * dispatched event. `getStateResult` is what the post-run getState scan
 * (and snapshot flush) sees.
 */
async function runV3(chunks: any[], getStateResult: any = EMPTY_STATE) {
  const agent = new LangGraphAgent(makeConfig(getStateResult));
  const dispatched: any[] = [];
  agent.dispatchEvent = (event: any) => {
    dispatched.push(event);
    return true as any;
  };
  (agent as any).activeRun = {
    id: "run1",
    threadId: "thread1",
    // The raw `messages` translation is gated behind an active node name
    // (in production set from lifecycle/graph_name). Preset it so the
    // messages handler is reachable in isolation.
    nodeName: "chat",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
    textBlockMessageIds: new Map(),
    toolBlocks: new Map(),
    reasoningBlocks: new Map(),
  };

  await (agent as any).handleStreamEventsV3(
    makeStreamArg(chunks),
    "thread1",
    { next: (e: any) => dispatched.push(e), error: () => {}, complete: () => {} },
    {
      runId: "run1",
      threadId: "thread1",
      messages: [],
      state: {},
      tools: [],
      context: [],
      // Seed an active node so the raw `messages` translation (gated on
      // an active node name) is reachable in isolation. handleStreamEventsV3
      // applies this via handleNodeChange at run start.
      forwardedProps: { nodeName: "chat" },
    },
    [],
  );

  return dispatched;
}

const toolResults = (d: any[]) => d.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
const interrupts = (d: any[]) =>
  d.filter((e) => e.type === EventType.CUSTOM && e.name === "on_interrupt");
const textStarts = (d: any[]) => d.filter((e) => e.type === EventType.TEXT_MESSAGE_START);

/** An agui-channel passthrough event (method === "agui"). */
function aguiChunk(event: any) {
  return makeChunk("agui", event);
}
/** Raw messages-channel frames that the v3 bundle would translate. */
function rawTextMessage(id: string) {
  return [
    makeChunk("messages", { event: "message-start", id }),
    makeChunk("messages", {
      event: "content-block-start",
      index: 0,
      content: { type: "text" },
    }),
  ];
}

// ---------------------------------------------------------------------------
// tools channel
// ---------------------------------------------------------------------------

describe("v3 tools channel → TOOL_CALL_RESULT", () => {
  it("emits TOOL_CALL_RESULT on tool-finished with stringified output", async () => {
    const dispatched = await runV3([
      makeChunk("tools", {
        event: "tool-finished",
        tool_call_id: "tc-1",
        output: { ok: true },
      }),
    ]);

    const results = toolResults(dispatched);
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("tc-1");
    expect(results[0].content).toBe(JSON.stringify({ ok: true }));
    expect(results[0].role).toBe("tool");
    expect(typeof results[0].messageId).toBe("string");
  });

  it("passes a string output through unchanged", async () => {
    const dispatched = await runV3([
      makeChunk("tools", { event: "tool-finished", tool_call_id: "tc-1", output: "done" }),
    ]);
    expect(toolResults(dispatched)[0].content).toBe("done");
  });

  it("unwraps the ToolNode result envelope to the inner content", async () => {
    // LangGraph 1.3's tools channel reports tool-finished.output as the
    // ToolNode result envelope { status, content }. The emitted
    // TOOL_CALL_RESULT.content must be the inner ToolMessage content (the raw
    // string a consumer parses), not the stringified wrapper — matching the v2
    // path. Regression guard for A2UI surfaces (a2ui_operations live in the
    // inner content and are invisible if the wrapper is stringified).
    const inner = JSON.stringify({ a2ui_operations: [{ surfaceId: "hotel-comparison" }] });
    const dispatched = await runV3([
      makeChunk("tools", {
        event: "tool-finished",
        tool_call_id: "tc-1",
        output: { status: "success", content: inner },
      }),
    ]);
    expect(toolResults(dispatched)[0].content).toBe(inner);
  });

  it("flattens an array content envelope into a single string", async () => {
    const dispatched = await runV3([
      makeChunk("tools", {
        event: "tool-finished",
        tool_call_id: "tc-1",
        output: { status: "success", content: [{ type: "text", text: "a" }, "b"] },
      }),
    ]);
    expect(toolResults(dispatched)[0].content).toBe("ab");
  });

  it("emits TOOL_CALL_RESULT carrying the error message on tool-error", async () => {
    const dispatched = await runV3([
      makeChunk("tools", { event: "tool-error", tool_call_id: "tc-1", message: "boom" }),
    ]);
    const results = toolResults(dispatched);
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("tc-1");
    expect(results[0].content).toBe("boom");
  });

  it("emits nothing for tool-started / tool-output-delta", async () => {
    const dispatched = await runV3([
      makeChunk("tools", { event: "tool-started", tool_call_id: "tc-1", tool_name: "x", input: {} }),
      makeChunk("tools", { event: "tool-output-delta", tool_call_id: "tc-1", delta: "partial" }),
    ]);
    expect(toolResults(dispatched)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// tasks channel + dedup
// ---------------------------------------------------------------------------

describe("v3 tasks channel → deduped OnInterrupt", () => {
  it("emits one OnInterrupt per live tasks-frame interrupt", async () => {
    const dispatched = await runV3([
      makeChunk("tasks", {
        id: "task-1",
        name: "node",
        interrupts: [{ id: "int-1", value: "approve?" }],
      }),
    ]);
    const ints = interrupts(dispatched);
    expect(ints).toHaveLength(1);
    expect(ints[0].value).toBe("approve?");
  });

  it("does not re-emit an interrupt the post-run getState scan also sees", async () => {
    const sameInterrupt = { id: "int-1", value: "approve?" };
    const dispatched = await runV3(
      // live frame on the tasks channel...
      [makeChunk("tasks", { id: "task-1", name: "node", interrupts: [sameInterrupt] })],
      // ...and the post-run getState returns the same pending interrupt.
      { ...EMPTY_STATE, tasks: [{ interrupts: [sameInterrupt] }] },
    );
    expect(interrupts(dispatched)).toHaveLength(1);
  });

  it("dedups the same tasks interrupt repeated across frames (create + result)", async () => {
    const sameInterrupt = { id: "int-1", value: "approve?" };
    const dispatched = await runV3([
      makeChunk("tasks", { id: "task-1", name: "node", interrupts: [sameInterrupt] }),
      makeChunk("tasks", { id: "task-1", name: "node", interrupts: [sameInterrupt] }),
    ]);
    expect(interrupts(dispatched)).toHaveLength(1);
  });

  it("dedups id-less interrupts by their value", async () => {
    const dispatched = await runV3(
      [makeChunk("tasks", { id: "task-1", name: "node", interrupts: [{ value: "approve?" }] })],
      { ...EMPTY_STATE, tasks: [{ interrupts: [{ value: "approve?" }] }] },
    );
    expect(interrupts(dispatched)).toHaveLength(1);
  });

  it("emits distinct interrupts separately", async () => {
    const dispatched = await runV3([
      makeChunk("tasks", {
        id: "task-1",
        name: "node",
        interrupts: [{ id: "int-1", value: "a" }, { id: "int-2", value: "b" }],
      }),
    ]);
    expect(interrupts(dispatched)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// transformer mode: sticky lazy flip
// ---------------------------------------------------------------------------

describe("v3 transformer mode (lazy flip)", () => {
  it("without any agui event, raw messages are translated", async () => {
    const dispatched = await runV3([
      ...rawTextMessage("m1"),
    ]);
    // Raw path opened a text message.
    expect(textStarts(dispatched)).toHaveLength(1);
    expect(textStarts(dispatched)[0].messageId).toBe("m1");
  });

  it("flips on first agui event and suppresses subsequent raw translation", async () => {
    const dispatched = await runV3([
      // agui passthrough first (mux pushes it ahead of the raw source)...
      aguiChunk({ type: EventType.TEXT_MESSAGE_START, messageId: "agui-1", role: "assistant" }),
      // ...then raw frames that WOULD open another text message if translated.
      ...rawTextMessage("m1"),
    ]);
    const starts = textStarts(dispatched);
    // Only the passthrough one — the raw m1 must be suppressed.
    expect(starts).toHaveLength(1);
    expect(starts[0].messageId).toBe("agui-1");
  });

  it("passes through agui events verbatim and ignores raw tools/tasks once flipped", async () => {
    const dispatched = await runV3([
      aguiChunk({ type: EventType.TEXT_MESSAGE_START, messageId: "agui-1", role: "assistant" }),
      makeChunk("tools", { event: "tool-finished", tool_call_id: "tc-1", output: "x" }),
      makeChunk("tasks", { id: "t", name: "n", interrupts: [{ id: "int-1", value: "v" }] }),
    ]);
    // Raw tools must NOT produce a TOOL_CALL_RESULT in transformer mode.
    expect(toolResults(dispatched)).toHaveLength(0);
    // The agui passthrough is present.
    expect(textStarts(dispatched)).toHaveLength(1);
  });
});
