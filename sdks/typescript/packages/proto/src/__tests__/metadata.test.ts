import { describe, expect, it } from "vitest";
import { EventType, type TextMessageStartEvent, type MessagesSnapshotEvent } from "@ag-ui/core";
import { decode, encode } from "../proto";

// Every JSON shape the protocol promises must survive the binary transport.
const VALUE_SHAPES = {
  nullValue: null,
  string: "finish_reason",
  number: 42,
  float: 1.5,
  boolean: true,
  emptyArray: [],
  array: [1, "two", null, { nested: true }],
  emptyObject: {},
  nested: { usage: { input: 10, output: 20 }, tags: ["a", "b"] },
};

const roundTrip = (event: any) => decode(encode(event)) as any;

describe("metadata over the binary transport", () => {
  it("survives a round trip with every value shape intact", () => {
    const decoded = roundTrip({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
      metadata: VALUE_SHAPES,
    } as TextMessageStartEvent);

    expect(decoded.metadata).toEqual(VALUE_SHAPES);
  });

  it("keeps an absent object absent rather than decoding it as empty", () => {
    const decoded = roundTrip({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
    } as TextMessageStartEvent);

    expect(decoded.metadata).toBeUndefined();
  });

  it("distinguishes an empty object from an absent one", () => {
    const decoded = roundTrip({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
      metadata: {},
    } as TextMessageStartEvent);

    expect(decoded.metadata).toEqual({});
    expect(decoded.metadata).not.toBeUndefined();
  });

  it("preserves a null value under a key", () => {
    const decoded = roundTrip({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
      metadata: { finishReason: null },
    } as TextMessageStartEvent);

    expect(decoded.metadata).toEqual({ finishReason: null });
    expect("finishReason" in decoded.metadata).toBe(true);
  });

  it("carries metadata on a non-message event", () => {
    const decoded = roundTrip({
      type: EventType.RUN_FINISHED,
      threadId: "t1",
      runId: "r1",
      metadata: { usage: { total: 100 } },
    });

    expect(decoded.metadata).toEqual({ usage: { total: 100 } });
  });

  it("carries per-message metadata through a messages snapshot", () => {
    const decoded = roundTrip({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "m1", role: "assistant", content: "a", metadata: VALUE_SHAPES },
        { id: "m2", role: "assistant", content: "b" },
      ],
    } as MessagesSnapshotEvent);

    expect(decoded.messages[0].metadata).toEqual(VALUE_SHAPES);
    // The second message had none and must not gain any.
    expect(decoded.messages[1].metadata).toBeUndefined();
  });
});

describe("tool call metadata over the binary transport", () => {
  it("round-trips per tool call and keeps them independent", () => {
    const decoded = roundTrip({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc1",
              type: "function",
              function: { name: "a", arguments: "{}" },
              metadata: VALUE_SHAPES,
            },
            // Carries none, so a leak between tool calls would surface.
            { id: "tc2", type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
      ],
    });

    expect(decoded.messages[0].toolCalls[0].metadata).toEqual(VALUE_SHAPES);
    expect(decoded.messages[0].toolCalls[1].metadata).toBeUndefined();
  });
});

describe("protobuf event coverage", () => {
  // Every schema event crosses the binary transport since the wire format is
  // generated from the schema. The legacy THINKING_* aliases are the remaining
  // exception: they predate the schema, have no wire message, and ride the
  // JSON path only. Pinned so the documented scope cannot drift from reality.
  const NOT_REPRESENTABLE = [
    EventType.THINKING_START,
    EventType.THINKING_END,
    EventType.THINKING_TEXT_MESSAGE_START,
    EventType.THINKING_TEXT_MESSAGE_CONTENT,
    EventType.THINKING_TEXT_MESSAGE_END,
  ];

  it.each(NOT_REPRESENTABLE)("%s does not cross the binary transport", (type) => {
    // These have no message in the wire format, so the event cannot travel —
    // with or without metadata. Encoding yields an empty payload that decode
    // then rejects.
    const bytes = encode({ type, metadata: { a: 1 } } as any);
    expect(bytes.length).toBe(0);
    expect(() => decode(bytes)).toThrow();
  });

  // Formerly unrepresentable, now generated from the schema: metadata rides
  // the base event for every one of them.
  const NEWLY_REPRESENTABLE: Array<[EventType, Record<string, unknown>]> = [
    [EventType.TOOL_CALL_RESULT, { messageId: "m1", toolCallId: "t1", content: "ok" }],
    [EventType.ACTIVITY_SNAPSHOT, { messageId: "m1", activityType: "a", content: {} }],
    [EventType.ACTIVITY_DELTA, { messageId: "m1", activityType: "a", patch: [] }],
    [EventType.REASONING_START, { messageId: "m1" }],
    [EventType.REASONING_MESSAGE_START, { messageId: "m1", role: "reasoning" }],
    [EventType.REASONING_MESSAGE_CONTENT, { messageId: "m1", delta: "d" }],
    [EventType.REASONING_MESSAGE_END, { messageId: "m1" }],
    [EventType.REASONING_MESSAGE_CHUNK, { messageId: "m1" }],
    [EventType.REASONING_END, { messageId: "m1" }],
    [
      EventType.REASONING_ENCRYPTED_VALUE,
      { subtype: "message", entityId: "m1", encryptedValue: "v" },
    ],
  ];

  it.each(NEWLY_REPRESENTABLE)(
    "%s crosses the binary transport with its metadata",
    (type, fields) => {
      const decoded = roundTrip({
        type,
        ...fields,
        metadata: { usage: { output: 340 } },
      } as any);
      expect(decoded.type).toBe(type);
      expect(decoded.metadata).toEqual({ usage: { output: 340 } });
    },
  );

  it("carries metadata for an event the wire format does represent", () => {
    const decoded = roundTrip({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m1",
      metadata: { usage: { output: 340 } },
    });
    expect(decoded.metadata).toEqual({ usage: { output: 340 } });
  });
});
