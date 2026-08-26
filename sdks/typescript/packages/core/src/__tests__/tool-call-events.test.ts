import { describe, expect, it } from "vitest";
import {
  EventSchemas,
  EventType,
  ToolCallChunkEventSchema,
  type ToolCallResultEvent,
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

  it("declares `error` in the schema's own shape, not as a tolerated unknown key", () => {
    // BaseEventSchema is `.passthrough()`, so an undeclared `error` still comes
    // back out of `.parse()` as an unrecognized key — which means the
    // parse-and-read assertions below mostly cannot fail on their own if the
    // field is deleted from the schema. Deleting `error` fails exactly two
    // tests in this block at runtime: this one, and "rejects an explicit null"
    // further down. This is the direct one — the schema's `shape` is the
    // TypeScript analogue of the Python suite's `model_fields` check, and it is
    // a compile error as well as a failed expectation once `error` is gone. The
    // other is incidental, and says so where it sits.
    expect(Object.keys(ToolCallResultEventSchema.shape)).toContain("error");

    const errorField = ToolCallResultEventSchema.shape.error;
    expect(errorField.safeParse("boom").success).toBe(true);
    expect(errorField.safeParse("").success).toBe(true);
    expect(errorField.safeParse(undefined).success).toBe(true);
    expect(errorField.safeParse(null).success).toBe(false);
    expect(errorField.safeParse(42).success).toBe(false);
  });

  it("parses an event with no error, leaving the field undefined", () => {
    const parsed = ToolCallResultEventSchema.parse(base);
    // Read through an annotated local rather than asserting on `parsed.error`
    // directly: under passthrough an undeclared key types as `unknown`, so this
    // line is the half of the assertion that stops compiling if `error` is
    // deleted from the schema. Same idiom in every case below.
    const error: string | undefined = parsed.error;
    expect(error).toBeUndefined();
  });

  it("preserves a real error string", () => {
    const parsed = ToolCallResultEventSchema.parse({
      ...base,
      content: "",
      error: "SearchTimeout: upstream did not respond within 30s",
    });
    const error: string | undefined = parsed.error;
    expect(error).toBe("SearchTimeout: upstream did not respond within 30s");
  });

  it("preserves an empty-string error rather than collapsing it to undefined", () => {
    // An empty string is a value the producer chose to send. Treating it as
    // absent would turn a (badly reported) failure into a success.
    const parsed = ToolCallResultEventSchema.parse({ ...base, error: "" });
    const error: string | undefined = parsed.error;
    expect(error).toBe("");
  });

  it("rejects an explicit null, like every other new optional field in these schemas", () => {
    // No null tolerance on new fields in the Zod schemas: since PNI-199 the
    // Python and .NET SDKs omit valueless fields at the source, so no producer
    // legally writes null here. The three legacy tolerances stay a closed set.
    //
    // The rejection is TypeScript's alone. The Python model and the .NET class
    // both accept an explicit null and read it back as absent — as they do for
    // every optional field, `subagent_run_id` and `role` included — so the
    // guarantee is that nothing writes null, not that every SDK refuses one.
    //
    // This is the second of the two tests in this block that fail at runtime if
    // the field is deleted — passthrough lets an undeclared `null` through
    // instead of throwing — but it fails incidentally, as a side effect of what
    // it is really about. The declaration itself is pinned deliberately by the
    // `shape` assertion at the top.
    expect(() => ToolCallResultEventSchema.parse({ ...base, error: null })).toThrow();
  });

  it("round-trips through JSON with the error intact", () => {
    const event = ToolCallResultEventSchema.parse({ ...base, error: "boom" });
    const reparsed = ToolCallResultEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(reparsed).toEqual(event);
    const error: string | undefined = reparsed.error;
    expect(error).toBe("boom");
  });

  it("omits the key entirely on the wire when no error is set", () => {
    // The cross-language contract in sdks/fixtures/null-omission.json: absent
    // means the key is gone, never `"error": null`.
    const event = ToolCallResultEventSchema.parse(base);
    const error: string | undefined = event.error;
    expect(error).toBeUndefined();
    expect(Object.keys(JSON.parse(JSON.stringify(event)))).not.toContain("error");
  });

  it("still resolves TOOL_CALL_RESULT through the EventSchemas union, with and without error", () => {
    // EventSchemas is what the HTTP transport validates each streamed event
    // against, so the discriminated union has to keep resolving the variant.
    const withError = EventSchemas.parse({ ...base, error: "boom" });
    expect(withError.type).toBe(EventType.TOOL_CALL_RESULT);
    if (withError.type === EventType.TOOL_CALL_RESULT) {
      const error: string | undefined = withError.error;
      expect(error).toBe("boom");
    }

    const withoutError = EventSchemas.parse(base);
    expect(withoutError.type).toBe(EventType.TOOL_CALL_RESULT);
    if (withoutError.type === EventType.TOOL_CALL_RESULT) {
      const error: string | undefined = withoutError.error;
      expect(error).toBeUndefined();
    }
  });

  it("re-serializes an event that carries no error to the same keys and values", () => {
    // The compat guarantee for a producer that never writes `error`: no key
    // gains or loses a value. Not a byte comparison — `toEqual` ignores key
    // order and undefined-valued keys, which is the right strength here: key
    // order is a serializer detail, not part of the wire contract.
    const legacyWire = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "msg-1",
      toolCallId: "tc-1",
      content: '{"hits":2}',
      role: "tool",
    };
    const parsed = ToolCallResultEventSchema.parse(legacyWire);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(legacyWire);
    // ...and the field it does not carry reads back as absent, not as some
    // other falsy value a consumer would have to special-case.
    const error: string | undefined = parsed.error;
    expect(error).toBeUndefined();
  });

  it("carries the error through createToolCallResultEvent", () => {
    // The factory is the construction path, and its `props` argument is where
    // `error` has to be accepted on the input side. Note that the exported
    // `ToolCallResultEventProps` alias cannot carry that guard: `EventProps` is
    // `Omit<z.input<Schema>, "type">`, and `Omit` over a passthrough input type
    // collapses to a bare index signature, so annotating a literal with it
    // asserts nothing about `error`. The factory's typed return does.
    const event = createToolCallResultEvent({
      messageId: "msg-1",
      toolCallId: "tc-1",
      content: "",
      error: "boom",
    });
    expect(event.type).toBe(EventType.TOOL_CALL_RESULT);
    const error: string | undefined = event.error;
    expect(error).toBe("boom");
  });

  it("declares `error` on the type, not merely tolerates it on the wire (compile-time)", () => {
    // A passthrough schema genuinely cannot reject an unknown key at runtime,
    // so `expect(...)` alone can never distinguish "declared field" from
    // "unrecognized key that survived parsing". What separates them is the
    // *type* of the value read back: a declared `error` reads as
    // `string | undefined`, an unrecognized one reads as `unknown` off the
    // passthrough index signature. So the annotated locals — here and in every
    // case above — are the load-bearing assertions, and they are checked by
    // `tsc` (`nx run @ag-ui/core:typecheck`), not by vitest. Deleting the field
    // from the schema fails the typecheck on each of them.
    const event: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "msg-1",
      toolCallId: "tc-1",
      content: "",
      error: "boom",
    };
    const read: string | undefined = event.error;
    expect(read).toBe("boom");

    // Omitting it still type-checks: the field is optional, not required.
    const omitted: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "msg-1",
      toolCallId: "tc-1",
      content: "ok",
    };
    const omittedRead: string | undefined = omitted.error;
    expect(omittedRead).toBeUndefined();
  });
});
