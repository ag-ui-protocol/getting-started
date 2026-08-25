import { describe, expect, it } from "vitest";
import { Subject, firstValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  BaseEvent,
  EventType,
  ReasoningMessageChunkEvent,
  ReasoningMessageContentEvent,
  TextMessageChunkEvent,
  TextMessageContentEvent,
  ToolCallArgsEvent,
  ToolCallChunkEvent,
} from "@ag-ui/core";
import { transformChunks } from "../transform";

const runTransform = async (events: BaseEvent[]): Promise<BaseEvent[]> => {
  const events$ = new Subject<BaseEvent>();
  const result = firstValueFrom(events$.pipe(transformChunks(), toArray()));

  for (const event of events) {
    events$.next(event);
  }
  events$.complete();

  return result;
};

describe("chunk metadata propagation", () => {
  it("stamps a text chunk's metadata onto both synthesized events", async () => {
    const out = await runTransform([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: "Hello",
        metadata: { source: "openai" },
      } as TextMessageChunkEvent,
    ]);

    expect(out.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
    expect(out[0].metadata).toEqual({ source: "openai" });
    expect(out[1].metadata).toEqual({ source: "openai" });
  });

  it("leaves metadata absent on synthesized events when the chunk carries none", async () => {
    const out = await runTransform([
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", delta: "Hi" } as TextMessageChunkEvent,
    ]);

    expect(out.every((e) => e.metadata === undefined)).toBe(true);
  });

  it("stamps a tool call chunk's metadata onto the start and args events", async () => {
    const out = await runTransform([
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        toolCallName: "search",
        delta: '{"q":',
        metadata: { provider: "anthropic" },
      } as ToolCallChunkEvent,
    ]);

    expect(out.map((e) => e.type)).toEqual([EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS]);
    expect(out[0].metadata).toEqual({ provider: "anthropic" });
    expect(out[1].metadata).toEqual({ provider: "anthropic" });
  });

  it("stamps a reasoning chunk's metadata onto the start and content events", async () => {
    const out = await runTransform([
      {
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "r1",
        delta: "thinking",
        metadata: { effort: "high" },
      } as ReasoningMessageChunkEvent,
    ]);

    expect(out.map((e) => e.type)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
    ]);
    expect(out[0].metadata).toEqual({ effort: "high" });
    expect(out[1].metadata).toEqual({ effort: "high" });
  });
});

describe("chunk metadata does not leak across a message boundary", () => {
  it("does not put the new chunk's metadata on the END that closes the previous message", async () => {
    const out = await runTransform([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: "first",
        metadata: { belongsTo: "m1" },
      } as TextMessageChunkEvent,
      // A different messageId closes m1 and opens m2 in one step.
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m2",
        delta: "second",
        metadata: { belongsTo: "m2" },
      } as TextMessageChunkEvent,
    ]);

    expect(out.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);

    expect(out[0].metadata).toEqual({ belongsTo: "m1" });
    expect(out[1].metadata).toEqual({ belongsTo: "m1" });
    // The synthetic END belongs to m1, and must not pick up m2's metadata.
    expect(out[2].metadata).toBeUndefined();
    expect(out[3].metadata).toEqual({ belongsTo: "m2" });
    expect(out[4].metadata).toEqual({ belongsTo: "m2" });
  });

  it("does not leak across a switch from a text chunk to a tool call chunk", async () => {
    const out = await runTransform([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: "text",
        metadata: { belongsTo: "m1" },
      } as TextMessageChunkEvent,
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        toolCallName: "search",
        delta: "{}",
        metadata: { belongsTo: "tc1" },
      } as ToolCallChunkEvent,
    ]);

    const end = out.find((e) => e.type === EventType.TEXT_MESSAGE_END)!;
    expect(end.metadata).toBeUndefined();

    const toolStart = out.find((e) => e.type === EventType.TOOL_CALL_START)!;
    expect(toolStart.metadata).toEqual({ belongsTo: "tc1" });
  });

  it("does not mutate the incoming chunk event", async () => {
    const chunk = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      delta: "Hello",
      metadata: { source: "openai" },
    } as TextMessageChunkEvent;

    await runTransform([chunk]);

    expect(chunk).toEqual({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      delta: "Hello",
      metadata: { source: "openai" },
    });
  });
});

describe("metadata-only continuation chunks", () => {
  // A provider's final chunk often carries usage and a finish reason but no
  // delta. That is the case the whole merge design exists for, so its metadata
  // must survive even though the chunk adds no text.
  //
  // It is emitted as a zero-delta continuation event rather than deferred to the
  // synthetic `*_END`, because `finalize` discards the events it creates — the
  // last message of a stream never receives an END at all.
  it("preserves metadata from a text chunk that carries no delta", async () => {
    const out = await runTransform([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: "Hello",
      } as TextMessageChunkEvent,
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        metadata: { usage: { output: 340 }, finishReason: "stop" },
      } as TextMessageChunkEvent,
    ]);

    const last = out[out.length - 1];
    expect(last.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect((last as TextMessageContentEvent).delta).toBe("");
    expect((last as TextMessageContentEvent).messageId).toBe("m1");
    expect(last.metadata).toEqual({ usage: { output: 340 }, finishReason: "stop" });
  });

  it("preserves metadata from a tool call chunk that carries no delta", async () => {
    const out = await runTransform([
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        toolCallName: "search",
        delta: "{}",
      } as ToolCallChunkEvent,
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        metadata: { latencyMs: 12 },
      } as ToolCallChunkEvent,
    ]);

    const last = out[out.length - 1];
    expect(last.type).toBe(EventType.TOOL_CALL_ARGS);
    expect((last as ToolCallArgsEvent).delta).toBe("");
    expect(last.metadata).toEqual({ latencyMs: 12 });
  });

  it("preserves metadata from a reasoning chunk that carries no delta", async () => {
    const out = await runTransform([
      {
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "r1",
        delta: "thinking",
      } as ReasoningMessageChunkEvent,
      {
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "r1",
        metadata: { tokens: 7 },
      } as ReasoningMessageChunkEvent,
    ]);

    const last = out[out.length - 1];
    expect(last.type).toBe(EventType.REASONING_MESSAGE_CONTENT);
    expect((last as ReasoningMessageContentEvent).delta).toBe("");
    expect(last.metadata).toEqual({ tokens: 7 });
  });

  // Attribution on the synthesized zero-delta event follows the same rule as
  // the delta path: the incoming chunk's tag first, the opener's owner as
  // fallback. Without it, a subagent lane's usage/finish-reason event reaches
  // subscribers and telemetry unattributed even though the stream is valid.
  it("keeps the opener's subagent attribution on a metadata-only text chunk", async () => {
    const out = await runTransform([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: "Hello",
        subagentRunId: "s1",
      } as TextMessageChunkEvent,
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        metadata: { usage: { output: 340 } },
      } as TextMessageChunkEvent,
    ]);

    const last = out[out.length - 1] as TextMessageContentEvent;
    expect(last.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(last.delta).toBe("");
    expect(last.subagentRunId).toBe("s1");
    expect(last.metadata).toEqual({ usage: { output: 340 } });
  });

  it("prefers the metadata-only chunk's own tag over the opener's", async () => {
    const out = await runTransform([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: "Hello",
        subagentRunId: "s1",
      } as TextMessageChunkEvent,
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        metadata: { finishReason: "stop" },
        subagentRunId: "s1",
      } as TextMessageChunkEvent,
    ]);

    const last = out[out.length - 1] as TextMessageContentEvent;
    expect(last.subagentRunId).toBe("s1");
  });

  it("keeps subagent attribution on a metadata-only tool call chunk", async () => {
    const out = await runTransform([
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        toolCallName: "search",
        delta: "{}",
        subagentRunId: "s1",
      } as ToolCallChunkEvent,
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        metadata: { latencyMs: 12 },
      } as ToolCallChunkEvent,
    ]);

    const last = out[out.length - 1] as ToolCallArgsEvent;
    expect(last.type).toBe(EventType.TOOL_CALL_ARGS);
    expect(last.subagentRunId).toBe("s1");
  });

  it("keeps subagent attribution on a metadata-only reasoning chunk", async () => {
    const out = await runTransform([
      {
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "r1",
        delta: "thinking",
        subagentRunId: "s1",
      } as ReasoningMessageChunkEvent,
      {
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "r1",
        metadata: { tokens: 7 },
      } as ReasoningMessageChunkEvent,
    ]);

    const last = out[out.length - 1] as ReasoningMessageContentEvent;
    expect(last.type).toBe(EventType.REASONING_MESSAGE_CONTENT);
    expect(last.subagentRunId).toBe("s1");
  });

  it("leaves a parent lane's metadata-only event untagged", async () => {
    const out = await runTransform([
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", delta: "x" } as TextMessageChunkEvent,
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        metadata: { finishReason: "stop" },
      } as TextMessageChunkEvent,
    ]);

    const last = out[out.length - 1] as TextMessageContentEvent;
    expect(last.subagentRunId).toBeUndefined();
  });

  it("emits nothing extra for a continuation chunk with neither delta nor metadata", async () => {
    const out = await runTransform([
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", delta: "x" } as TextMessageChunkEvent,
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1" } as TextMessageChunkEvent,
    ]);

    expect(out.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
  });

  it("does not carry a metadata-only chunk's metadata onto the next message", async () => {
    const out = await runTransform([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: "one",
      } as TextMessageChunkEvent,
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        metadata: { belongsTo: "m1" },
      } as TextMessageChunkEvent,
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m2",
        delta: "two",
      } as TextMessageChunkEvent,
    ]);

    const m2Events = out.filter(
      (e) =>
        (e.type === EventType.TEXT_MESSAGE_START || e.type === EventType.TEXT_MESSAGE_CONTENT) &&
        (e as TextMessageContentEvent).messageId === "m2",
    );
    expect(m2Events.length).toBeGreaterThan(0);
    expect(m2Events.every((e) => e.metadata === undefined)).toBe(true);

    const end = out.find((e) => e.type === EventType.TEXT_MESSAGE_END)!;
    expect(end.metadata).toBeUndefined();
  });
});
