/**
 * Finding 8 — handleSingleEventV3 stream-balance.
 *
 * The client raw-translate path (v3 `messages` channel) must emit balanced
 * START/END events for text / reasoning / tool content blocks:
 *
 *  - message-error closes any open text/reasoning/tool block (previously it
 *    cleared the text tracker WITHOUT a TEXT_MESSAGE_END).
 *  - multiple text content-blocks sharing one message id yield exactly one
 *    START and one END (previously a duplicate START/END per block).
 *  - message-finish closes open tool/reasoning blocks (previously only text).
 *  - a tool call whose name arrives on a later block-delta gets a non-empty
 *    toolCallName on its single TOOL_CALL_START (previously START fired with
 *    an empty name at content-block-start).
 */

import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";
import { CustomEventNames } from "./types";

const EMPTY_STATE = {
  values: { messages: [] },
  tasks: [],
  next: [],
  metadata: { writes: {} },
};

function makeConfig(getStateResult: any = EMPTY_STATE): LangGraphAgentConfig {
  return {
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
    client: {
      threads: { getState: vi.fn().mockResolvedValue(getStateResult) },
      runs: { cancel: vi.fn() },
    } as any,
  };
}

function makeChunk(method: string, data: any) {
  return { type: "event", seq: 0, method, params: { namespace: [], timestamp: 0, data } };
}

async function* makeStream(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

async function runV3(chunks: any[]) {
  const agent = new LangGraphAgent(makeConfig());
  const dispatched: any[] = [];
  agent.dispatchEvent = (event: any) => {
    dispatched.push(event);
    return true as any;
  };
  (agent as any).activeRun = {
    id: "run1",
    threadId: "thread1",
    nodeName: "chat",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
    textBlockMessageIds: new Map(),
    toolBlocks: new Map(),
    reasoningBlocks: new Map(),
  };
  (agent as any).emittedToolCallStartIds = new Set();

  await (agent as any).handleStreamEventsV3(
    { streamResponse: makeStream(chunks), state: { ...EMPTY_STATE } },
    "thread1",
    { next: (e: any) => dispatched.push(e), error: () => {}, complete: () => {} },
    {
      runId: "run1",
      threadId: "thread1",
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: { nodeName: "chat" },
    },
    [],
  );
  return dispatched;
}

const byType = (d: any[], t: EventType) => d.filter((e) => e.type === t);

// ---------------------------------------------------------------------------
// message-error closes open blocks (was: cleared without END)
// ---------------------------------------------------------------------------

describe("message-error closes open blocks", () => {
  it("emits TEXT_MESSAGE_END for an open text block on message-error", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", { event: "content-block-start", index: 0, content: { type: "text" } }),
      makeChunk("messages", { event: "content-block-delta", index: 0, delta: { type: "text-delta", text: "hi" } }),
      makeChunk("messages", { event: "message-error" }),
    ]);
    const starts = byType(dispatched, EventType.TEXT_MESSAGE_START);
    const ends = byType(dispatched, EventType.TEXT_MESSAGE_END);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0].messageId).toBe("m1");
  });

  it("closes an open tool block on message-error", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tc-1", name: "search" },
      }),
      makeChunk("messages", { event: "message-error" }),
    ]);
    expect(byType(dispatched, EventType.TOOL_CALL_START)).toHaveLength(1);
    expect(byType(dispatched, EventType.TOOL_CALL_END)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// multiple text content-blocks reusing one message id
// ---------------------------------------------------------------------------

describe("multiple text blocks under one message id", () => {
  it("emits exactly one START and one END across two text blocks", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", { event: "content-block-start", index: 0, content: { type: "text" } }),
      makeChunk("messages", { event: "content-block-start", index: 1, content: { type: "text" } }),
      makeChunk("messages", { event: "content-block-finish", index: 0, content: { type: "text" } }),
      makeChunk("messages", { event: "content-block-finish", index: 1, content: { type: "text" } }),
    ]);
    const starts = byType(dispatched, EventType.TEXT_MESSAGE_START);
    const ends = byType(dispatched, EventType.TEXT_MESSAGE_END);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0].messageId).toBe("m1");
    expect(ends[0].messageId).toBe("m1");
  });
});

// ---------------------------------------------------------------------------
// message-finish closes open tool / reasoning blocks
// ---------------------------------------------------------------------------

describe("message-finish closes non-text blocks", () => {
  it("closes an open tool block on message-finish", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tc-1", name: "search", args: "{}" },
      }),
      makeChunk("messages", { event: "message-finish" }),
    ]);
    expect(byType(dispatched, EventType.TOOL_CALL_START)).toHaveLength(1);
    expect(byType(dispatched, EventType.TOOL_CALL_END)).toHaveLength(1);
  });

  it("closes an open reasoning block on message-finish", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "reasoning", reasoning: "thinking..." },
      }),
      makeChunk("messages", { event: "message-finish" }),
    ]);
    expect(byType(dispatched, EventType.REASONING_MESSAGE_END)).toHaveLength(1);
    expect(byType(dispatched, EventType.REASONING_END)).toHaveLength(1);
  });

  it("falls back to the snapshot converter's id formula when the block has no id", async () => {
    // Snapshot copies are emitted as `${assistantId}-reasoning-${index}`
    // (utils.ts). The streamed id must use the SAME formula, or the snapshot's
    // replace semantics drop the streamed reasoning and the indicator vanishes.
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m9" }),
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "reasoning", reasoning: "no id here" },
      }),
      makeChunk("messages", { event: "message-finish" }),
    ]);
    const start = byType(dispatched, EventType.REASONING_START)[0] as any;
    expect(start.messageId).toBe("m9-reasoning-0");
  });

  it("uses the provider's canonical reasoning id so the snapshot copy reconciles", async () => {
    // The MESSAGES_SNAPSHOT reasoning copy is emitted under the block's
    // canonical id (e.g. OpenAI `rs_…`); a synthetic streamed id would be
    // dropped by the snapshot's replace semantics, wiping the indicator.
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "reasoning", id: "rs_abc123", reasoning: "hmm" },
      }),
      makeChunk("messages", { event: "message-finish" }),
    ]);
    const start = byType(dispatched, EventType.REASONING_START)[0] as any;
    expect(start.messageId).toBe("rs_abc123");
    const end = byType(dispatched, EventType.REASONING_END)[0] as any;
    expect(end.messageId).toBe("rs_abc123");
  });
});

// ---------------------------------------------------------------------------
// tool name arriving on a later block-delta
// ---------------------------------------------------------------------------

describe("deferred tool name", () => {
  it("emits a single TOOL_CALL_START with the name from a later block-delta", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      // Opening block carries NO name.
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call_chunk", id: "tc-1" },
      }),
      // Name (and args) arrive on the delta.
      makeChunk("messages", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { name: "search", args: '{"q":1}' } },
      }),
      makeChunk("messages", { event: "content-block-finish", index: 0, content: { type: "tool_call_chunk" } }),
    ]);
    const starts = byType(dispatched, EventType.TOOL_CALL_START);
    expect(starts).toHaveLength(1);
    expect(starts[0].toolCallName).toBe("search");
    // The buffered args are flushed once, and the call is balanced.
    expect(byType(dispatched, EventType.TOOL_CALL_END)).toHaveLength(1);
    const args = byType(dispatched, EventType.TOOL_CALL_ARGS);
    expect(args.map((a) => a.delta).join("")).toBe('{"q":1}');
  });
});

// ---------------------------------------------------------------------------
// A5 — block-delta arg correction ships only the common-prefix suffix
// ---------------------------------------------------------------------------

describe("block-delta arg correction (common-prefix diff)", () => {
  it("ships only the suffix beyond the common prefix when the engine replaces the args buffer", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      // START fires immediately (name present); args start empty.
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tc-1", name: "search", args: "" },
      }),
      // Normal append: cumulative extends the buffer → ship the tail.
      makeChunk("messages", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { args: '{"a":1' } },
      }),
      // Arg correction: cumulative does NOT start with the buffer. Common
      // prefix is `{"` → only `b":2}` should be shipped (NOT the full string),
      // so a delta-accumulating consumer never sees the shared head twice.
      makeChunk("messages", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { args: '{"b":2}' } },
      }),
      makeChunk("messages", { event: "content-block-finish", index: 0, content: { type: "tool_call" } }),
    ]);
    const args = byType(dispatched, EventType.TOOL_CALL_ARGS).map((a) => a.delta);
    expect(args).toEqual(['{"a":1', 'b":2}']);
    // Balanced.
    expect(byType(dispatched, EventType.TOOL_CALL_START)).toHaveLength(1);
    expect(byType(dispatched, EventType.TOOL_CALL_END)).toHaveLength(1);
  });

  it("still ships the plain suffix on a normal monotonic append", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tc-1", name: "search", args: "" },
      }),
      makeChunk("messages", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { args: '{"q":' } },
      }),
      makeChunk("messages", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { args: '{"q":42}' } },
      }),
      makeChunk("messages", { event: "content-block-finish", index: 0, content: { type: "tool_call" } }),
    ]);
    const args = byType(dispatched, EventType.TOOL_CALL_ARGS).map((a) => a.delta);
    expect(args.join("")).toBe('{"q":42}');
    expect(args).toEqual(['{"q":', "42}"]);
  });
});

// ---------------------------------------------------------------------------
// A2 — v3-raw `custom` channel translates ManuallyEmit* (was silently dropped)
// ---------------------------------------------------------------------------

describe("v3-raw custom channel translation", () => {
  it("expands ManuallyEmitMessage into balanced TEXT_MESSAGE_* events", async () => {
    const dispatched = await runV3([
      makeChunk("custom", {
        name: CustomEventNames.ManuallyEmitMessage,
        payload: { message_id: "man-1", message: "hello from a node" },
      }),
    ]);
    const starts = byType(dispatched, EventType.TEXT_MESSAGE_START);
    const contents = byType(dispatched, EventType.TEXT_MESSAGE_CONTENT);
    const ends = byType(dispatched, EventType.TEXT_MESSAGE_END);
    expect(starts).toHaveLength(1);
    expect(contents).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0].messageId).toBe("man-1");
    expect(contents[0].delta).toBe("hello from a node");
    expect(ends[0].messageId).toBe("man-1");
    // No generic CUSTOM for the message helper (matches v2).
    expect(byType(dispatched, EventType.CUSTOM)).toHaveLength(0);
  });

  it("expands ManuallyEmitToolCall into balanced TOOL_CALL_* events", async () => {
    const dispatched = await runV3([
      makeChunk("custom", {
        name: CustomEventNames.ManuallyEmitToolCall,
        payload: { id: "mtc-1", name: "do_thing", args: '{"x":1}' },
      }),
    ]);
    const starts = byType(dispatched, EventType.TOOL_CALL_START);
    const argsEv = byType(dispatched, EventType.TOOL_CALL_ARGS);
    const ends = byType(dispatched, EventType.TOOL_CALL_END);
    expect(starts).toHaveLength(1);
    expect(starts[0].toolCallId).toBe("mtc-1");
    expect(starts[0].toolCallName).toBe("do_thing");
    expect(argsEv[0].delta).toBe('{"x":1}');
    expect(ends).toHaveLength(1);
  });

  it("emits STATE_SNAPSHOT and a generic CUSTOM for ManuallyEmitState", async () => {
    const dispatched = await runV3([
      makeChunk("custom", {
        name: CustomEventNames.ManuallyEmitState,
        payload: { counter: 7 },
      }),
    ]);
    const snapshots = byType(dispatched, EventType.STATE_SNAPSHOT);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[0].snapshot).toEqual({ counter: 7 });
    const custom = byType(dispatched, EventType.CUSTOM);
    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe(CustomEventNames.ManuallyEmitState);
    expect(custom[0].value).toEqual({ counter: 7 });
  });

  it("passes an unknown custom event through as a generic CUSTOM", async () => {
    const dispatched = await runV3([
      makeChunk("custom", { name: "app_notification", payload: { level: "info" } }),
    ]);
    const custom = byType(dispatched, EventType.CUSTOM);
    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe("app_notification");
    expect(custom[0].value).toEqual({ level: "info" });
  });
});
