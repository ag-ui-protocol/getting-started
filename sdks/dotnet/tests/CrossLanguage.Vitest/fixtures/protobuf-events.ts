import { EventType, type BaseEvent } from "@ag-ui/core";

/**
 * Representative instances of each of the 16 protobuf-supported AG-UI events,
 * used to prove .NET <-> TypeScript protobuf wire compatibility.
 *
 * `byteParity` declares whether strict byte-for-byte equality between the TS
 * `@ag-ui/proto` encoder and the .NET `AGUIProtobuf.Encode` output is expected:
 *
 *  - "strict": the event carries only scalar (string/number) fields, which both
 *    encoders serialise in field-number order with identical wire bytes.
 *  - "roundtrip": the event carries a dynamic payload that maps to
 *    `google.protobuf.Struct` (a `map<string, Value>`). Protobuf map-entry
 *    ordering is NOT canonical across encoders, so the bytes may differ even
 *    though both sides decode to the same value. For these we only require
 *    round-trip semantic equivalence and log whether the bytes happened to match.
 */
export type ByteParity = "strict" | "roundtrip";

export interface ProtobufFixture {
  name: string;
  event: BaseEvent;
  byteParity: ByteParity;
}

export const protobufFixtures: ProtobufFixture[] = [
  {
    name: "RUN_STARTED",
    byteParity: "strict",
    event: {
      type: EventType.RUN_STARTED,
      timestamp: 1_700_000_000_000,
      threadId: "thread-1",
      runId: "run-1",
    } as BaseEvent,
  },
  {
    name: "RUN_FINISHED (with result + success outcome)",
    byteParity: "roundtrip",
    event: {
      type: EventType.RUN_FINISHED,
      threadId: "thread-1",
      runId: "run-1",
      result: { answer: 42, label: "done", nested: { ok: true } },
      outcome: { type: "success" },
    } as unknown as BaseEvent,
  },
  {
    // Token usage is scalar-only (labels + int64 counts) with no Struct payload,
    // so both encoders must agree byte-for-byte. Two entries prove per-(provider,
    // model) grouping survives, and the second omits most counts to prove
    // "not reported" stays absent rather than becoming 0.
    name: "RUN_FINISHED (with usage)",
    byteParity: "strict",
    event: {
      type: EventType.RUN_FINISHED,
      threadId: "thread-1",
      runId: "run-1",
      outcome: { type: "success" },
      usage: [
        {
          provider: "openai",
          model: "gpt-4o",
          inputTokens: 11,
          outputTokens: 22,
          totalTokens: 33,
          reasoningTokens: 44,
          cachedInputTokens: 55,
        },
        // Explicit zeros (providers really do report `cachedInputTokens: 0`) alongside
        // omitted counts, so this also pins that both encoders keep "reported zero"
        // distinguishable from "not reported" on the wire.
        { provider: "anthropic", model: "claude-opus-4", inputTokens: 1, cachedInputTokens: 0 },
      ],
    } as unknown as BaseEvent,
  },
  {
    name: "RUN_ERROR",
    byteParity: "strict",
    event: {
      type: EventType.RUN_ERROR,
      message: "boom",
      code: "E42",
    } as BaseEvent,
  },
  {
    name: "RUN_ERROR (with partial usage)",
    byteParity: "strict",
    event: {
      type: EventType.RUN_ERROR,
      message: "boom",
      code: "E42",
      usage: [{ provider: "openai", model: "gpt-4o", inputTokens: 120 }],
    } as unknown as BaseEvent,
  },
  {
    name: "STEP_STARTED",
    byteParity: "strict",
    event: {
      type: EventType.STEP_STARTED,
      stepName: "step-1",
    } as BaseEvent,
  },
  {
    name: "STEP_FINISHED",
    byteParity: "strict",
    event: {
      type: EventType.STEP_FINISHED,
      stepName: "step-1",
    } as BaseEvent,
  },
  {
    name: "TEXT_MESSAGE_START",
    byteParity: "strict",
    event: {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
    } as BaseEvent,
  },
  {
    name: "TEXT_MESSAGE_CONTENT",
    byteParity: "strict",
    event: {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "hello world",
    } as BaseEvent,
  },
  {
    name: "TEXT_MESSAGE_END",
    byteParity: "strict",
    event: {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as BaseEvent,
  },
  {
    name: "TOOL_CALL_START",
    byteParity: "strict",
    event: {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "search",
      parentMessageId: "msg-1",
    } as BaseEvent,
  },
  {
    name: "TOOL_CALL_ARGS",
    byteParity: "strict",
    event: {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-1",
      delta: '{"q":"weather"}',
    } as BaseEvent,
  },
  {
    name: "TOOL_CALL_END",
    byteParity: "strict",
    event: {
      type: EventType.TOOL_CALL_END,
      toolCallId: "tc-1",
    } as BaseEvent,
  },
  {
    name: "STATE_SNAPSHOT (nested object)",
    byteParity: "roundtrip",
    event: {
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        recipe: {
          title: "Pasta al Limone",
          ingredients: ["pasta", "lemon", "butter"],
          servings: 2,
        },
      },
    } as unknown as BaseEvent,
  },
  {
    name: "STATE_DELTA (JSON Patch array)",
    byteParity: "roundtrip",
    event: {
      type: EventType.STATE_DELTA,
      delta: [
        { op: "add", path: "/document", value: "Atlantis" },
        { op: "replace", path: "/counter", value: 5 },
        { op: "remove", path: "/stale" },
      ],
    } as unknown as BaseEvent,
  },
  {
    name: "MESSAGES_SNAPSHOT (multimodal + tool call)",
    byteParity: "roundtrip",
    event: {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "s1", role: "system", content: "be helpful" },
        {
          id: "u1",
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            {
              type: "image",
              source: {
                type: "url",
                value: "https://example.com/a.png",
                mimeType: "image/png",
              },
            },
          ],
        },
        {
          id: "a1",
          role: "assistant",
          content: "calling tool",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: { name: "search", arguments: '{"q":"x"}' },
            },
          ],
        },
        { id: "t1", role: "tool", content: "result", toolCallId: "tc-1" },
      ],
    } as unknown as BaseEvent,
  },
  {
    name: "RAW (event object)",
    byteParity: "roundtrip",
    event: {
      type: EventType.RAW,
      event: { foo: "bar", count: 3 },
      source: "external",
    } as unknown as BaseEvent,
  },
  {
    name: "CUSTOM (value object)",
    byteParity: "roundtrip",
    event: {
      type: EventType.CUSTOM,
      name: "ping",
      value: { items: [1, 2, 3], ok: true },
    } as unknown as BaseEvent,
  },
  // ---------------------------------------------------------------------
  // Metadata (PNI-198).
  //
  // Metadata is declared once on BaseEvent, so it rides on every event type.
  // It maps to `google.protobuf.Struct`, hence "roundtrip" byte parity for
  // every fixture that carries one. Absent metadata is already covered by all
  // the fixtures above, which carry none; the explicit case is kept here so the
  // absent/empty distinction is visible in one place.
  // ---------------------------------------------------------------------
  {
    name: "METADATA absent",
    byteParity: "strict",
    event: {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-metadata-absent",
    } as BaseEvent,
  },
  {
    name: "METADATA empty object",
    byteParity: "roundtrip",
    event: {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-metadata-empty",
      metadata: {},
    } as unknown as BaseEvent,
  },
  {
    name: "METADATA null value under a key",
    byteParity: "roundtrip",
    event: {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-metadata-null",
      metadata: { finishReason: null },
    } as unknown as BaseEvent,
  },
  {
    name: "METADATA primitives",
    byteParity: "roundtrip",
    event: {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-metadata-primitives",
      metadata: { string: "stop", number: 42, float: 1.5, boolean: true },
    } as unknown as BaseEvent,
  },
  {
    name: "METADATA arrays",
    byteParity: "roundtrip",
    event: {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-metadata-arrays",
      metadata: {
        emptyArray: [],
        tags: ["a", "b"],
        mixed: [1, "two", null, { nested: true }],
      },
    } as unknown as BaseEvent,
  },
  {
    name: "METADATA nested objects (including the reserved ag-ui key)",
    byteParity: "roundtrip",
    event: {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-metadata-nested",
      metadata: {
        "ag-ui": { usage: { input: 10, output: 20 } },
        emptyObject: {},
        user: { deeply: { nested: { value: "ok" } } },
      },
    } as unknown as BaseEvent,
  },
  {
    name: "METADATA on a non-message event (RUN_FINISHED)",
    byteParity: "roundtrip",
    event: {
      type: EventType.RUN_FINISHED,
      threadId: "thread-1",
      runId: "run-1",
      metadata: { "ag-ui": { usage: { total: 100 } }, finishReason: "stop" },
    } as unknown as BaseEvent,
  },
  {
    name: "METADATA per-message inside MESSAGES_SNAPSHOT",
    byteParity: "roundtrip",
    event: {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "with metadata",
          metadata: { tokens: 7, tags: ["x"], nested: { a: null } },
        },
        // Deliberately carries none, so a leak between messages would show up.
        { id: "m2", role: "assistant", content: "without metadata" },
      ],
    } as unknown as BaseEvent,
  },
  {
    name: "METADATA per tool call inside MESSAGES_SNAPSHOT",
    byteParity: "roundtrip",
    event: {
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
              metadata: {
                "ag-ui": { usage: { input: 5 } },
                phase: "one",
                tags: ["x"],
              },
            },
            // Carries none, so a leak between tool calls would surface.
            {
              id: "tc2",
              type: "function",
              function: { name: "b", arguments: "{}" },
            },
          ],
        },
      ],
    } as unknown as BaseEvent,
  },
];
