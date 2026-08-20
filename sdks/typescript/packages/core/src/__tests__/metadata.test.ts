import { describe, expect, it } from "vitest";
import {
  AGUI_METADATA_KEY,
  ActivityMessageSchema,
  AssistantMessageSchema,
  BaseEventSchema,
  DeveloperMessageSchema,
  EventType,
  MetadataSchema,
  OptionalMetadataSchema,
  ReasoningMessageSchema,
  RunFinishedEventSchema,
  SystemMessageSchema,
  TextMessageStartEventSchema,
  ToolCallResultEventSchema,
  ToolMessageSchema,
  UserMessageSchema,
  mergeMetadata,
} from "../index";

// Every JSON shape the protocol promises survives a round trip.
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

describe("MetadataSchema", () => {
  it("accepts every JSON value shape, including null, under a key", () => {
    expect(MetadataSchema.parse(VALUE_SHAPES)).toEqual(VALUE_SHAPES);
  });

  it("accepts an empty object", () => {
    expect(MetadataSchema.parse({})).toEqual({});
  });

  it("reads an explicit null as absent, and preserves null values under keys", () => {
    // Producers must not emit a null object, but Pydantic models serialized
    // without exclude_none=True do, so parsing tolerates it. A null *value*
    // under a key is data and survives.
    expect(OptionalMetadataSchema.parse(undefined)).toBeUndefined();
    expect(OptionalMetadataSchema.parse(null)).toBeUndefined();
    expect(OptionalMetadataSchema.parse({ a: null })).toEqual({ a: null });
  });
});

describe("metadata on events", () => {
  it("is carried by the base event, so every event type has it", () => {
    const parsed = BaseEventSchema.parse({
      type: EventType.CUSTOM,
      metadata: VALUE_SHAPES,
    });
    expect(parsed.metadata).toEqual(VALUE_SHAPES);
  });

  it("is optional on every event", () => {
    const parsed = TextMessageStartEventSchema.parse({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
    });
    expect(parsed.metadata).toBeUndefined();
  });

  it("reads an explicit null on an event as absent", () => {
    const parsed = TextMessageStartEventSchema.parse({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      metadata: null,
    });
    expect(parsed.metadata).toBeUndefined();
  });

  it("round-trips through JSON on a concrete event", () => {
    const event = ToolCallResultEventSchema.parse({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m1",
      toolCallId: "tc1",
      content: "done",
      metadata: VALUE_SHAPES,
    });
    const roundTripped = ToolCallResultEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(roundTripped.metadata).toEqual(VALUE_SHAPES);
  });

  it("is accepted on a non-message event such as RUN_FINISHED", () => {
    const parsed = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t1",
      runId: "r1",
      metadata: { usage: { total: 100 } },
    });
    expect(parsed.metadata).toEqual({ usage: { total: 100 } });
  });
});

describe("metadata on messages", () => {
  // Developer, system, assistant and user derive from BaseMessageSchema; tool,
  // activity and reasoning are standalone schemas that declare it themselves.
  const cases: Array<[string, { parse: (v: unknown) => { metadata?: unknown } }, object]> = [
    ["developer", DeveloperMessageSchema, { id: "1", role: "developer", content: "c" }],
    ["system", SystemMessageSchema, { id: "1", role: "system", content: "c" }],
    ["assistant", AssistantMessageSchema, { id: "1", role: "assistant", content: "c" }],
    ["user", UserMessageSchema, { id: "1", role: "user", content: "c" }],
    ["tool", ToolMessageSchema, { id: "1", role: "tool", content: "c", toolCallId: "tc1" }],
    [
      "activity",
      ActivityMessageSchema,
      { id: "1", role: "activity", activityType: "PLAN", content: {} },
    ],
    ["reasoning", ReasoningMessageSchema, { id: "1", role: "reasoning", content: "c" }],
  ];

  it.each(cases)("%s messages carry metadata", (_role, schema, base) => {
    expect(schema.parse({ ...base, metadata: VALUE_SHAPES }).metadata).toEqual(VALUE_SHAPES);
  });

  it.each(cases)("%s messages accept absent metadata", (_role, schema, base) => {
    expect(schema.parse(base).metadata).toBeUndefined();
  });

  it.each(cases)("%s messages read a null metadata object as absent", (_role, schema, base) => {
    expect(schema.parse({ ...base, metadata: null }).metadata).toBeUndefined();
  });
});

describe("mergeMetadata", () => {
  it("returns the existing object untouched when incoming is absent", () => {
    const existing = { a: 1 };
    expect(mergeMetadata(existing, undefined)).toBe(existing);
  });

  it("changes nothing when incoming is empty", () => {
    expect(mergeMetadata({ a: 1 }, {})).toEqual({ a: 1 });
  });

  it("returns undefined when there is nothing on either side", () => {
    expect(mergeMetadata(undefined, undefined)).toBeUndefined();
  });

  it("copies incoming when there is no existing object", () => {
    const incoming = { a: 1 };
    const merged = mergeMetadata(undefined, incoming);
    expect(merged).toEqual({ a: 1 });
    // A copy, not the same reference — the caller's object must not be aliased.
    expect(merged).not.toBe(incoming);
  });

  it("lets later keys replace earlier ones and keeps untouched keys", () => {
    expect(mergeMetadata({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("preserves a null value rather than treating it as absent", () => {
    expect(mergeMetadata({ a: 1 }, { a: null })).toEqual({ a: null });
  });

  it("does not mutate either argument", () => {
    const existing = { a: 1 };
    const incoming = { b: 2 };
    mergeMetadata(existing, incoming);
    expect(existing).toEqual({ a: 1 });
    expect(incoming).toEqual({ b: 2 });
  });

  // The two tests below are written so that a deep merge would fail them.
  it("replaces an array wholesale instead of concatenating or merging by index", () => {
    const merged = mergeMetadata({ tags: ["a", "b", "c"] }, { tags: ["z"] });
    expect(merged).toEqual({ tags: ["z"] });
  });

  it("replaces a nested object wholesale, including under the reserved key", () => {
    const merged = mergeMetadata(
      { [AGUI_METADATA_KEY]: { usage: { input: 10 }, keep: "gone" } },
      { [AGUI_METADATA_KEY]: { usage: { output: 20 } } },
    );
    expect(merged).toEqual({ [AGUI_METADATA_KEY]: { usage: { output: 20 } } });
    // Explicitly: the old sub-keys are gone, not blended in.
    expect(merged![AGUI_METADATA_KEY]).not.toHaveProperty("keep");
    expect(merged![AGUI_METADATA_KEY].usage).not.toHaveProperty("input");
  });
});
