import { describe, expect, it } from "vitest";
import {
  AGUI_METADATA_KEY,
  BaseEvent,
  EventType,
  StateDeltaEvent,
  StateSnapshotEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { compactEvents } from "../compact";

/**
 * Compaction replaces a run of delta events with one synthesized event. The
 * metadata those deltas carried has to come with it, or replaying a compacted
 * stream produces a different `message.metadata` than the original stream did.
 */
describe("compactEvents preserves metadata", () => {
  it("merges metadata from every content event into the compacted one", () => {
    const compacted = compactEvents([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "Hel",
        metadata: { source: "openai", chunk: 1 },
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "lo",
        metadata: { chunk: 2 },
      } as TextMessageContentEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
    ]);

    const content = compacted.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)!;
    expect((content as TextMessageContentEvent).delta).toBe("Hello");
    // Last write wins, exactly as the reducer would have applied them in order.
    expect(content.metadata).toEqual({ source: "openai", chunk: 2 });
  });

  it("leaves the compacted content event without metadata when no delta carried any", () => {
    const compacted = compactEvents([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "a",
      } as TextMessageContentEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
    ]);

    const content = compacted.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)!;
    expect(content).not.toHaveProperty("metadata");
  });

  it("merges metadata from every tool call args event into the compacted one", () => {
    const compacted = compactEvents([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc1",
        delta: '{"q":',
        metadata: { part: 1, tags: ["a"] },
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc1",
        delta: "1}",
        metadata: { part: 2 },
      } as ToolCallArgsEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent,
    ]);

    const args = compacted.find((e) => e.type === EventType.TOOL_CALL_ARGS)!;
    expect((args as ToolCallArgsEvent).delta).toBe('{"q":1}');
    expect(args.metadata).toEqual({ part: 2, tags: ["a"] });
  });

  it("merges metadata from compacted state events into the synthesized snapshot", () => {
    const compacted = compactEvents([
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { count: 1 },
        metadata: { origin: "server", revision: 1 },
      } as StateSnapshotEvent,
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "replace", path: "/count", value: 2 }],
        metadata: { revision: 2 },
      } as StateDeltaEvent,
    ]);

    const snapshot = compacted.find((e) => e.type === EventType.STATE_SNAPSHOT)!;
    expect((snapshot as StateSnapshotEvent).snapshot).toEqual({ count: 2 });
    expect(snapshot.metadata).toEqual({ origin: "server", revision: 2 });
  });

  it("replaces a value wholesale rather than deep-merging while compacting", () => {
    const compacted = compactEvents([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "a",
        metadata: { [AGUI_METADATA_KEY]: { usage: { input: 10 }, dropped: true } },
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "b",
        metadata: { [AGUI_METADATA_KEY]: { usage: { output: 20 } } },
      } as TextMessageContentEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
    ]);

    const content = compacted.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)!;
    expect(content.metadata).toEqual({ [AGUI_METADATA_KEY]: { usage: { output: 20 } } });
  });

  it("keeps start and end event metadata untouched", () => {
    const compacted = compactEvents([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        metadata: { stage: "start" },
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "a",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
        metadata: { stage: "end", usage: { total: 5 } },
      } as TextMessageEndEvent,
    ]);

    const start = compacted.find((e) => e.type === EventType.TEXT_MESSAGE_START)!;
    const end = compacted.find((e) => e.type === EventType.TEXT_MESSAGE_END)!;
    expect(start.metadata).toEqual({ stage: "start" });
    expect(end.metadata).toEqual({ stage: "end", usage: { total: 5 } });
  });
});

describe("compaction reorders entities, but not their metadata", () => {
  // compactEvents flushes a tool call when its END arrives, so parallel calls
  // can end up swapped in the assistant message's toolCalls array. Each still
  // keeps its own metadata, because a tool call is its own merge destination —
  // which is what makes a compacted replay agree with the original stream.
  it("swaps the tool call order but keeps each one's metadata", () => {
    const compacted = compactEvents([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "a",
        parentMessageId: "m1",
        metadata: { phase: "one" },
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc2",
        toolCallName: "b",
        parentMessageId: "m1",
        metadata: { phase: "two" },
      } as ToolCallStartEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc2" } as ToolCallEndEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent,
    ]);

    // tc2 flushes first because its END arrived first.
    const starts = compacted.filter((e) => e.type === EventType.TOOL_CALL_START);
    expect(starts.map((e) => (e as ToolCallStartEvent).toolCallId)).toEqual(["tc2", "tc1"]);

    // Each START keeps its own metadata; only the order they reach the shared
    // assistant message changes.
    expect(starts[0].metadata).toEqual({ phase: "two" });
    expect(starts[1].metadata).toEqual({ phase: "one" });
  });
});

describe("replayed start events", () => {
  // A backend can replay a TOOL_CALL_START that the client already holds — the
  // HITL re-sync path does exactly this, which is why the reducer's start
  // handling is idempotent. Uncompacted, both starts merge into the owner
  // message; compaction must not lose the first one's keys.
  it("merges metadata from a tool call start that is replayed before its end", () => {
    const compacted = compactEvents([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        metadata: { first: 1 },
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        metadata: { second: 2 },
      } as ToolCallStartEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent,
    ]);

    const start = compacted.find((e) => e.type === EventType.TOOL_CALL_START)!;
    expect(start.metadata).toEqual({ first: 1, second: 2 });
  });

  it("merges metadata from a text message start that is replayed before its end", () => {
    const compacted = compactEvents([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        metadata: { first: 1 },
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        metadata: { second: 2 },
      } as TextMessageStartEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
    ]);

    const start = compacted.find((e) => e.type === EventType.TEXT_MESSAGE_START)!;
    expect(start.metadata).toEqual({ first: 1, second: 2 });
  });

  it("lets a replayed start's value win for a contended key", () => {
    const compacted = compactEvents([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        metadata: { phase: "one" },
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        metadata: { phase: "two" },
      } as ToolCallStartEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent,
    ]);

    const start = compacted.find((e) => e.type === EventType.TOOL_CALL_START)!;
    expect(start.metadata).toEqual({ phase: "two" });
  });
});

describe("replayed start arriving after deltas", () => {
  // Compaction hoists START ahead of the collapsed delta event. A start replayed
  // *after* deltas must therefore not have its metadata folded into that START,
  // or it would be applied before metadata that actually arrived earlier.
  it("keeps arrival order when a start is replayed after a content delta", () => {
    const compacted = compactEvents([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        metadata: { phase: "first" },
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "a",
        metadata: { phase: "content" },
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        metadata: { phase: "replay" },
      } as TextMessageStartEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
    ]);

    // Applying the compacted stream in order must end on the value that arrived
    // last in the original stream.
    const applied = compacted.reduce<Record<string, any>>(
      (acc, e) => ({ ...acc, ...(e.metadata ?? {}) }),
      {},
    );
    expect(applied.phase).toBe("replay");
  });

  it("keeps arrival order across interleaved starts and deltas", () => {
    const compacted = compactEvents([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "s",
        metadata: { phase: "start" },
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc1",
        delta: "{",
        metadata: { phase: "a" },
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "s",
        metadata: { phase: "replay" },
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc1",
        delta: "}",
        metadata: { phase: "c" },
      } as ToolCallArgsEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent,
    ]);

    const applied = compacted.reduce<Record<string, any>>(
      (acc, e) => ({ ...acc, ...(e.metadata ?? {}) }),
      {},
    );
    expect(applied.phase).toBe("c");
  });
});

describe("a replayed start's non-metadata fields", () => {
  // The reducer deliberately renames an existing tool call when a start is
  // replayed with a corrected name. Compaction must not undo that.
  it("keeps the corrected tool call name when the replay follows args", () => {
    const compacted = compactEvents([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "old_name",
        metadata: { phase: "start" },
      } as ToolCallStartEvent,
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: "{}" } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "corrected_name",
        metadata: { phase: "replay" },
      } as ToolCallStartEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent,
    ]);

    const start = compacted.find((e) => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent;
    expect(start.toolCallName).toBe("corrected_name");
    // The pre-args start's metadata still rides the START...
    expect(start.metadata).toEqual({ phase: "start" });

    // ...while the replay's is staged after the args, so arrival order holds.
    const applied = compacted.reduce<Record<string, any>>(
      (acc, e) => ({ ...acc, ...(e.metadata ?? {}) }),
      {},
    );
    expect(applied.phase).toBe("replay");
  });

  it("keeps the latest text message start fields when the replay follows content", () => {
    const compacted = compactEvents([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        name: "first",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "a",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        name: "corrected",
      } as TextMessageStartEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
    ]);

    const start = compacted.find(
      (e) => e.type === EventType.TEXT_MESSAGE_START,
    ) as TextMessageStartEvent;
    expect(start.name).toBe("corrected");
  });
});

describe("compacted replay agrees with the original stream", () => {
  // The invariant compaction exists to preserve: piecing a stream together
  // yourself and piecing together its compacted form must give the same result.
  // Tool calls used to break it — several can share one parent assistant
  // message, so folding their metadata into that parent made the outcome depend
  // on the order compaction is free to change. They carry their own metadata now.
  const applyToToolCallMetadata = (events: BaseEvent[]) => {
    const toolCalls = new Map<string, Record<string, any>>();
    for (const e of events) {
      const id = (e as any).toolCallId;
      if (id && e.metadata) {
        toolCalls.set(id, { ...(toolCalls.get(id) ?? {}), ...e.metadata });
      }
    }
    return [...toolCalls.entries()].sort();
  };

  it("gives the same tool call metadata for interleaved parallel tool calls", () => {
    const events = [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "a",
        parentMessageId: "m1",
        metadata: { phase: "one" },
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc2",
        toolCallName: "b",
        parentMessageId: "m1",
        metadata: { phase: "two" },
      } as ToolCallStartEvent,
      // ENDs reversed relative to the STARTs — this is what compaction reorders.
      { type: EventType.TOOL_CALL_END, toolCallId: "tc2" } as ToolCallEndEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent,
    ];

    expect(applyToToolCallMetadata(compactEvents(events))).toEqual(applyToToolCallMetadata(events));
  });

  it("gives the same tool call metadata when a start is replayed mid-args", () => {
    const events = [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "a",
        metadata: { phase: "start" },
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc1",
        delta: "{",
        metadata: { phase: "args" },
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "a",
        metadata: { phase: "replay" },
      } as ToolCallStartEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent,
    ];

    expect(applyToToolCallMetadata(compactEvents(events))).toEqual(applyToToolCallMetadata(events));
  });
});
