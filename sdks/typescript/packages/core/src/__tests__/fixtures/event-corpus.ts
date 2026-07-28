// Cross-zod-version conformance corpus.
//
// Deliberately has ZERO imports, so it compiles standalone. The packaged-consumer
// harness in sdks/typescript/consumer-tests copies this file in and runs the same
// corpus against every zod version in the supported range; vitest runs it here
// against the workspace zod. Every entry must produce the SAME verdict on every
// supported zod version — that is the whole point of the file. If a zod release
// changes a verdict here, the matrix job goes red instead of the protocol
// silently changing under consumers.
//
// Supported range: zod ^3.25.18 || ^4.0.0, exercised via the `zod/v4` subpath.

export interface AcceptCase {
  name: string;
  payload: Record<string, unknown>;
  /** Asserted on the PARSED result — pins defaults and transforms per engine. */
  expect?: Record<string, unknown>;
}

export interface RejectCase {
  name: string;
  payload: Record<string, unknown>;
}

/** Payloads that must PARSE on every supported zod version. */
export const ACCEPT: AcceptCase[] = [
  // --- one minimal valid payload per event type ------------------------------
  { name: "TEXT_MESSAGE_START", payload: { type: "TEXT_MESSAGE_START", messageId: "m1" } },
  {
    name: "TEXT_MESSAGE_CONTENT",
    payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hi" },
  },
  { name: "TEXT_MESSAGE_END", payload: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
  { name: "TEXT_MESSAGE_CHUNK", payload: { type: "TEXT_MESSAGE_CHUNK" } },
  { name: "THINKING_START", payload: { type: "THINKING_START" } },
  { name: "THINKING_END", payload: { type: "THINKING_END" } },
  { name: "THINKING_TEXT_MESSAGE_START", payload: { type: "THINKING_TEXT_MESSAGE_START" } },
  {
    name: "THINKING_TEXT_MESSAGE_CONTENT",
    payload: { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "t" },
  },
  { name: "THINKING_TEXT_MESSAGE_END", payload: { type: "THINKING_TEXT_MESSAGE_END" } },
  {
    name: "TOOL_CALL_START",
    payload: { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "search" },
  },
  {
    name: "TOOL_CALL_ARGS",
    payload: { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"q":' },
  },
  { name: "TOOL_CALL_END", payload: { type: "TOOL_CALL_END", toolCallId: "tc1" } },
  { name: "TOOL_CALL_CHUNK", payload: { type: "TOOL_CALL_CHUNK" } },
  {
    name: "TOOL_CALL_RESULT",
    payload: {
      type: "TOOL_CALL_RESULT",
      messageId: "m1",
      toolCallId: "tc1",
      content: "done",
    },
  },
  { name: "STATE_SNAPSHOT", payload: { type: "STATE_SNAPSHOT", snapshot: { a: 1 } } },
  {
    name: "STATE_DELTA",
    payload: { type: "STATE_DELTA", delta: [{ op: "add", path: "/a", value: 1 }] },
  },
  { name: "MESSAGES_SNAPSHOT", payload: { type: "MESSAGES_SNAPSHOT", messages: [] } },
  {
    name: "ACTIVITY_SNAPSHOT",
    payload: {
      type: "ACTIVITY_SNAPSHOT",
      messageId: "m1",
      activityType: "search",
      content: { q: "x" },
    },
  },
  {
    name: "ACTIVITY_DELTA",
    payload: {
      type: "ACTIVITY_DELTA",
      messageId: "m1",
      activityType: "search",
      patch: [{ op: "add", path: "/q", value: "x" }],
    },
  },
  { name: "RAW", payload: { type: "RAW", event: { anything: true } } },
  { name: "CUSTOM", payload: { type: "CUSTOM", name: "ping", value: 1 } },
  { name: "RUN_STARTED", payload: { type: "RUN_STARTED", threadId: "t1", runId: "r1" } },
  { name: "RUN_FINISHED", payload: { type: "RUN_FINISHED", threadId: "t1", runId: "r1" } },
  { name: "RUN_ERROR", payload: { type: "RUN_ERROR", message: "boom" } },
  { name: "STEP_STARTED", payload: { type: "STEP_STARTED", stepName: "s1" } },
  { name: "STEP_FINISHED", payload: { type: "STEP_FINISHED", stepName: "s1" } },
  { name: "REASONING_START", payload: { type: "REASONING_START", messageId: "m1" } },
  {
    name: "REASONING_MESSAGE_START",
    payload: { type: "REASONING_MESSAGE_START", messageId: "m1", role: "reasoning" },
  },
  {
    name: "REASONING_MESSAGE_CONTENT",
    payload: { type: "REASONING_MESSAGE_CONTENT", messageId: "m1", delta: "d" },
  },
  {
    name: "REASONING_MESSAGE_END",
    payload: { type: "REASONING_MESSAGE_END", messageId: "m1" },
  },
  { name: "REASONING_MESSAGE_CHUNK", payload: { type: "REASONING_MESSAGE_CHUNK" } },
  { name: "REASONING_END", payload: { type: "REASONING_END", messageId: "m1" } },
  {
    name: "REASONING_ENCRYPTED_VALUE",
    payload: {
      type: "REASONING_ENCRYPTED_VALUE",
      subtype: "message",
      entityId: "e1",
      encryptedValue: "abc",
    },
  },

  // --- omitted `z.any()` object values --------------------------------------
  // These are the cases that diverged before: bare `z.any()` accepts a missing
  // key on zod engine 4.0.0 but rejects it as `nonoptional` on 4.4.x. All six
  // sites are explicitly `.optional()` now, so every version must ACCEPT.
  {
    name: "STATE_SNAPSHOT without snapshot",
    payload: { type: "STATE_SNAPSHOT" },
  },
  { name: "RAW without event", payload: { type: "RAW" } },
  { name: "CUSTOM without value", payload: { type: "CUSTOM", name: "ping" } },
  {
    name: "RUN_STARTED with input missing state/forwardedProps",
    payload: {
      type: "RUN_STARTED",
      threadId: "t1",
      runId: "r1",
      input: {
        threadId: "t1",
        runId: "r1",
        messages: [],
        tools: [],
        context: [],
      },
    },
  },
  {
    name: "RUN_STARTED with a tool missing parameters",
    payload: {
      type: "RUN_STARTED",
      threadId: "t1",
      runId: "r1",
      input: {
        threadId: "t1",
        runId: "r1",
        messages: [],
        tools: [{ name: "search", description: "searches" }],
        context: [],
      },
    },
  },

  // --- defaults, transforms, passthrough ------------------------------------
  {
    name: "TEXT_MESSAGE_START applies role default",
    payload: { type: "TEXT_MESSAGE_START", messageId: "m1" },
    expect: { role: "assistant" },
  },
  {
    name: "ACTIVITY_SNAPSHOT applies replace default",
    payload: {
      type: "ACTIVITY_SNAPSHOT",
      messageId: "m1",
      activityType: "search",
      content: {},
    },
    expect: { replace: true },
  },
  {
    name: "TOOL_CALL_START normalizes parentMessageId null to undefined",
    payload: {
      type: "TOOL_CALL_START",
      toolCallId: "tc1",
      toolCallName: "search",
      parentMessageId: null,
    },
    expect: { parentMessageId: undefined },
  },
  {
    name: "TOOL_CALL_CHUNK normalizes parentMessageId null to undefined",
    payload: { type: "TOOL_CALL_CHUNK", parentMessageId: null },
    expect: { parentMessageId: undefined },
  },
  {
    name: "RUN_FINISHED normalizes outcome null to undefined",
    payload: { type: "RUN_FINISHED", threadId: "t1", runId: "r1", outcome: null },
    expect: { outcome: undefined },
  },
  {
    name: "RUN_FINISHED accepts a success outcome",
    payload: {
      type: "RUN_FINISHED",
      threadId: "t1",
      runId: "r1",
      outcome: { type: "success" },
    },
  },
  {
    name: "RUN_FINISHED accepts an interrupt outcome",
    payload: {
      type: "RUN_FINISHED",
      threadId: "t1",
      runId: "r1",
      outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "tool_call" }] },
    },
  },
  {
    name: "passthrough preserves unknown wire fields",
    payload: {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "hi",
      futureField: { nested: true },
    },
    expect: { futureField: { nested: true } },
  },
  {
    name: "MESSAGES_SNAPSHOT accepts every message role",
    payload: {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        { id: "1", role: "developer", content: "d" },
        { id: "2", role: "system", content: "s" },
        { id: "3", role: "assistant", content: "a" },
        { id: "4", role: "user", content: "u" },
        { id: "5", role: "tool", content: "t", toolCallId: "tc1" },
        { id: "6", role: "activity", activityType: "x", content: { k: 1 } },
        { id: "7", role: "reasoning", content: "r" },
      ],
    },
  },
  {
    name: "USER message accepts multimodal content parts",
    payload: {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "url", value: "https://x/y.png" } },
            { type: "binary", mimeType: "application/pdf", id: "b1" },
          ],
        },
      ],
    },
  },
];

/** Payloads that must FAIL to parse on every supported zod version. */
export const REJECT: RejectCase[] = [
  { name: "unknown event type", payload: { type: "NOPE_NOT_AN_EVENT" } },
  { name: "missing type", payload: { messageId: "m1", delta: "hi" } },
  {
    name: "TEXT_MESSAGE_CONTENT missing delta",
    payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1" },
  },
  {
    name: "TEXT_MESSAGE_CONTENT with numeric delta",
    payload: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: 123 },
  },
  {
    name: "TEXT_MESSAGE_START with an invalid role",
    payload: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "wizard" },
  },
  {
    name: "TOOL_CALL_START missing toolCallName",
    payload: { type: "TOOL_CALL_START", toolCallId: "tc1" },
  },
  { name: "RUN_ERROR missing message", payload: { type: "RUN_ERROR" } },
  { name: "RUN_STARTED missing runId", payload: { type: "RUN_STARTED", threadId: "t1" } },
  {
    name: "RUN_FINISHED interrupt outcome with an empty interrupts array",
    payload: {
      type: "RUN_FINISHED",
      threadId: "t1",
      runId: "r1",
      outcome: { type: "interrupt", interrupts: [] },
    },
  },
  {
    name: "RUN_FINISHED outcome with an unknown discriminant",
    payload: {
      type: "RUN_FINISHED",
      threadId: "t1",
      runId: "r1",
      outcome: { type: "sideways" },
    },
  },
  {
    name: "MESSAGES_SNAPSHOT with an invalid nested role",
    payload: { type: "MESSAGES_SNAPSHOT", messages: [{ id: "1", role: "wizard", content: "x" }] },
  },
  {
    name: "MESSAGES_SNAPSHOT tool message missing toolCallId",
    payload: { type: "MESSAGES_SNAPSHOT", messages: [{ id: "1", role: "tool", content: "x" }] },
  },
  {
    name: "binary input content with none of id/url/data",
    payload: {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        {
          id: "1",
          role: "user",
          content: [{ type: "binary", mimeType: "application/pdf" }],
        },
      ],
    },
  },
  {
    name: "ACTIVITY_SNAPSHOT missing activityType",
    payload: { type: "ACTIVITY_SNAPSHOT", messageId: "m1", content: {} },
  },
  {
    name: "REASONING_ENCRYPTED_VALUE with an invalid subtype",
    payload: {
      type: "REASONING_ENCRYPTED_VALUE",
      subtype: "not-a-subtype",
      entityId: "e1",
      encryptedValue: "abc",
    },
  },
];
