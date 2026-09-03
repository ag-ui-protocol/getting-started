import { describe, expect, it } from "vitest";
import { EventType } from "../index";
import type { ToolCallStartEvent, ToolCallStartEventProps } from "../index";
import {
  EventSchemas,
  ToolCallChunkEventSchema,
  ToolCallStartEventSchema,
} from "../schemas";

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

  // The end-to-end tolerance for this null lives in the client's inbound
  // compatibility boundary since PNI-205/207 (see the client's
  // compatibility-boundary tests); at the schema layer the union rejects it,
  // like the per-event schema above.
  it("rejects `parentMessageId: null` through the EventSchemas union", () => {
    const result = EventSchemas.safeParse({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      parentMessageId: null,
    });
    expect(result.success).toBe(false);
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
