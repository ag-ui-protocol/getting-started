import { describe, expect, it } from "vitest";
import {
  EventSchemas,
  EventType,
  ToolCallChunkEventSchema,
  type ToolCallStartEvent,
  type ToolCallStartEventProps,
  ToolCallStartEventSchema,
} from "../index";

describe("ToolCallStartEventSchema — parentMessageId is optional and back-compat", () => {
  it("parses an event with no parentMessageId", () => {
    const parsed = ToolCallStartEventSchema.parse({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
    });
    expect(parsed.parentMessageId).toBeUndefined();
  });

  it("rejects an explicit `parentMessageId: null`", () => {
    // The 1.0 schema rejects the null. The .NET Microsoft Agent Framework
    // adapter (System.Text.Json) serializes the optional field as JSON null,
    // so the tolerance still exists — but as a middleware conversion with an
    // expiry (PNI-207), not as schema semantics.
    const result = ToolCallStartEventSchema.safeParse({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      parentMessageId: null,
    });
    expect(result.success).toBe(false);
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

  // Skipped until PNI-205/PNI-207 land: the tolerance moves from the schema
  // into a middleware that runs before enforcement. Re-enable there, asserting
  // the middleware conversion instead of schema normalisation.
  it.skip("normalizes `parentMessageId: null` through the EventSchemas union", () => {
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

describe("ToolCallChunkEventSchema — parentMessageId rejects null", () => {
  it("rejects an explicit `parentMessageId: null`", () => {
    // As on TOOL_CALL_START: the 1.0 schema rejects the null; the middleware
    // conversion for legacy producers lands with PNI-207.
    const result = ToolCallChunkEventSchema.safeParse({
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tc-1",
      parentMessageId: null,
    });
    expect(result.success).toBe(false);
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

    // Construction/props type: parentMessageId is an optional string. The
    // pre-1.0 null-widening is gone — the schema rejects an explicit null at
    // runtime (pinned above), so the type refusing it is the honest contract.
    const propsWithNull: ToolCallStartEventProps = {
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      // @ts-expect-error null no longer compiles as a parentMessageId
      parentMessageId: null,
    };
    const propsWithString: ToolCallStartEventProps = {
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      parentMessageId: "msg-1",
    };
    const propsOmitted: ToolCallStartEventProps = {
      toolCallId: "tc-1",
      toolCallName: "get_weather",
    };
    expect(propsWithNull.parentMessageId).toBeNull();
    expect(propsWithString.parentMessageId).toBe("msg-1");
    expect(propsOmitted.parentMessageId).toBeUndefined();
  });
});
