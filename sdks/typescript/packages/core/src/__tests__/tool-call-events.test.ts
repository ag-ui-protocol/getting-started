import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { EventType, type ToolCallStartEvent } from "../events";
import { EventSchemas, ToolCallChunkEventSchema, ToolCallStartEventSchema } from "../schemas";

describe("ToolCallStartEventSchema — parentMessageId is optional and back-compat", () => {
  it("parses an event with no parentMessageId", () => {
    const parsed = ToolCallStartEventSchema.parse({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
    });
    expect(parsed.parentMessageId).toBeUndefined();
  });

  it("accepts an explicit `parentMessageId: null` and normalizes it to undefined", () => {
    // Cross-language back-compat: the .NET Microsoft Agent Framework adapter
    // (System.Text.Json) serializes the optional `parentMessageId` as JSON
    // `null` rather than omitting it. Treating null as "field omitted" keeps
    // .NET→TS wire interop working instead of aborting the run on the first
    // tool call.
    const parsed = ToolCallStartEventSchema.parse({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      parentMessageId: null,
    });
    expect(parsed.parentMessageId).toBeUndefined();
  });

  it("preserves a real string parentMessageId", () => {
    const parsed = ToolCallStartEventSchema.parse({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      parentMessageId: "msg-1",
    });
    expect(parsed.parentMessageId).toBe("msg-1");
  });

  it("normalizes `parentMessageId: null` through the EventSchemas union", () => {
    // EventSchemas is what the HTTP transport validates each streamed event
    // against — the exact path that surfaced the null in the wild.
    const parsed = EventSchemas.parse({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      parentMessageId: null,
    });
    expect(parsed.type).toBe(EventType.TOOL_CALL_START);
    if (parsed.type === EventType.TOOL_CALL_START) {
      expect(parsed.parentMessageId).toBeUndefined();
    }
  });
});

describe("ToolCallChunkEventSchema — parentMessageId accepts null", () => {
  it("accepts an explicit `parentMessageId: null` and normalizes it to undefined", () => {
    const parsed = ToolCallChunkEventSchema.parse({
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tc-1",
      parentMessageId: null,
    });
    expect(parsed.parentMessageId).toBeUndefined();
  });
});

describe("ToolCallStart — public type contract is not broken (compile-time)", () => {
  it("keeps the consumer (output) type identical and only widens the input", () => {
    // The `const x: Type = {...}` annotations below are the assertion — they are
    // checked by `tsc`, so any breaking change to the inferred type fails the
    // build, not just this runtime assert.

    // Consumer/output type (`z.infer`) is UNCHANGED: `parentMessageId` stays an
    // OPTIONAL key (omittable) whose value is `string | undefined` — never null.
    const consumerOmits: ToolCallStartEvent = {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
    };
    const read: string | undefined = consumerOmits.parentMessageId;
    expect(read).toBeUndefined();

    // Schema INPUT only WIDENS — `null` is now accepted ALONGSIDE the previously
    // valid string and omitted forms. This is additive: every input that parsed
    // before still parses. The schemas are the source of truth for wire
    // validation here; the hand-written `ToolCallStartEventProps` construction
    // type stays `string | undefined`, since accepting `null` is a wire concern.
    type ToolCallStartInput = z.input<typeof ToolCallStartEventSchema>;
    const inputWithNull: ToolCallStartInput = {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      parentMessageId: null,
    };
    const inputWithString: ToolCallStartInput = {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      parentMessageId: "msg-1",
    };
    const inputOmitted: ToolCallStartInput = {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
    };
    expect(inputWithNull.parentMessageId).toBeNull();
    expect(inputWithString.parentMessageId).toBe("msg-1");
    expect(inputOmitted.parentMessageId).toBeUndefined();
  });
});
