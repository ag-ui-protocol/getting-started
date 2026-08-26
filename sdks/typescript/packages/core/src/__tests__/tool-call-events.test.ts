import { describe, expect, it } from "vitest";
import {
  EventSchemas,
  EventType,
  ToolCallChunkEventSchema,
  type ToolCallResultEvent,
  type ToolCallResultEventProps,
  ToolCallResultEventSchema,
  type ToolCallStartEvent,
  type ToolCallStartEventProps,
  ToolCallStartEventSchema,
} from "../events";
import { createToolCallResultEvent } from "../event-factories";

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

    // Construction/props type (`z.input`) only WIDENS — `null` is now accepted
    // ALONGSIDE the previously-valid string and omitted forms. This is additive:
    // every input that compiled before still compiles.
    const propsWithNull: ToolCallStartEventProps = {
      toolCallId: "tc-1",
      toolCallName: "get_weather",
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

describe("ToolCallResultEventSchema — optional `error`", () => {
  const base = {
    type: EventType.TOOL_CALL_RESULT as const,
    messageId: "msg-1",
    toolCallId: "tc-1",
    content: '{"hits":2}',
  };

  it("parses an event with no error, leaving the field undefined", () => {
    const parsed = ToolCallResultEventSchema.parse(base);
    expect(parsed.error).toBeUndefined();
  });

  it("preserves a real error string", () => {
    const parsed = ToolCallResultEventSchema.parse({
      ...base,
      content: "",
      error: "SearchTimeout: upstream did not respond within 30s",
    });
    expect(parsed.error).toBe("SearchTimeout: upstream did not respond within 30s");
  });

  it("preserves an empty-string error rather than collapsing it to undefined", () => {
    // An empty string is a value the producer chose to send. Treating it as
    // absent would turn a (badly reported) failure into a success.
    const parsed = ToolCallResultEventSchema.parse({ ...base, error: "" });
    expect(parsed.error).toBe("");
  });

  it("rejects an explicit null, like every other new optional field", () => {
    // No null tolerance on new fields: since PNI-199 the Python and .NET SDKs
    // omit valueless fields at the source, so no producer legally writes null
    // here. The three legacy tolerances stay a closed set.
    expect(() => ToolCallResultEventSchema.parse({ ...base, error: null })).toThrow();
  });

  it("round-trips through JSON with the error intact", () => {
    const event = ToolCallResultEventSchema.parse({ ...base, error: "boom" });
    const reparsed = ToolCallResultEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(reparsed).toEqual(event);
  });

  it("omits the key entirely on the wire when no error is set", () => {
    // The cross-language contract in sdks/fixtures/null-omission.json: absent
    // means the key is gone, never `"error": null`.
    const event = ToolCallResultEventSchema.parse(base);
    expect(Object.keys(JSON.parse(JSON.stringify(event)))).not.toContain("error");
  });

  it("still resolves TOOL_CALL_RESULT through the EventSchemas union, with and without error", () => {
    // EventSchemas is what the HTTP transport validates each streamed event
    // against, so the discriminated union has to keep resolving the variant.
    const withError = EventSchemas.parse({ ...base, error: "boom" });
    expect(withError.type).toBe(EventType.TOOL_CALL_RESULT);
    if (withError.type === EventType.TOOL_CALL_RESULT) {
      expect(withError.error).toBe("boom");
    }

    const withoutError = EventSchemas.parse(base);
    expect(withoutError.type).toBe(EventType.TOOL_CALL_RESULT);
    if (withoutError.type === EventType.TOOL_CALL_RESULT) {
      expect(withoutError.error).toBeUndefined();
    }
  });

  it("parses a pre-existing stream byte-identically to before the field existed", () => {
    // The additive guarantee: an old producer's event is unchanged by the new
    // field, key-for-key and value-for-value.
    const legacyWire = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "msg-1",
      toolCallId: "tc-1",
      content: '{"hits":2}',
      role: "tool",
    };
    const parsed = ToolCallResultEventSchema.parse(legacyWire);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(legacyWire);
  });

  it("carries the error through createToolCallResultEvent", () => {
    const event = createToolCallResultEvent({
      messageId: "msg-1",
      toolCallId: "tc-1",
      content: "",
      error: "boom",
    });
    expect(event.type).toBe(EventType.TOOL_CALL_RESULT);
    expect(event.error).toBe("boom");
  });

  it("declares `error` on the type, not merely tolerates it on the wire (compile-time)", () => {
    // The runtime asserts above are NOT sufficient on their own. BaseEventSchema
    // passes unknown keys through, so deleting `error` from the schema leaves
    // almost all of them green — the value survives parsing as an unrecognized
    // key. The `const x: Type = {...}` annotations below are the real guard:
    // they are checked by `tsc`, so removing the field fails the build.
    const props: ToolCallResultEventProps = {
      messageId: "msg-1",
      toolCallId: "tc-1",
      content: "",
      error: "boom",
    };
    expect(props.error).toBe("boom");

    // Consumer/output type: an OPTIONAL key whose value is `string | undefined`,
    // never null — matching ToolMessage.error.
    const event: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "msg-1",
      toolCallId: "tc-1",
      content: "",
      error: "boom",
    };
    const read: string | undefined = event.error;
    expect(read).toBe("boom");

    // Omitting it still type-checks: the field is additive, not required.
    const omitted: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "msg-1",
      toolCallId: "tc-1",
      content: "ok",
    };
    expect(omitted.error).toBeUndefined();
  });
});
