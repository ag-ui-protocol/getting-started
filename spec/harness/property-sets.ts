/**
 * The exact property set every event carries, inherited fields included.
 *
 * The wire contract is deliberately open — an unrecognised property is never a
 * validation failure — so nothing in the schema itself would catch a property
 * that was simply never written down. That matters more than it looks: once the
 * SDKs are generated from this file, these lists become what the compatibility
 * boundary strips against, so a field missing here is a field that gets quietly
 * removed from the wire rather than one that fails loudly.
 *
 * Spelled out in full rather than composed from a base list, so a change to
 * BaseEvent or Attributable shows up here as 31 diffs and has to be looked at.
 */
export const EVENT_PROPERTIES: Record<string, string[]> = {
  TextMessageStartEvent: [
    "messageId",
    "metadata",
    "name",
    "rawEvent",
    "role",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  TextMessageContentEvent: [
    "delta",
    "messageId",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  TextMessageEndEvent: [
    "messageId",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  TextMessageChunkEvent: [
    "delta",
    "messageId",
    "metadata",
    "name",
    "rawEvent",
    "role",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  ToolCallStartEvent: [
    "metadata",
    "parentMessageId",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "toolCallId",
    "toolCallName",
    "type",
  ],
  ToolCallArgsEvent: [
    "delta",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "toolCallId",
    "type",
  ],
  ToolCallEndEvent: [
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "toolCallId",
    "type",
  ],
  ToolCallChunkEvent: [
    "delta",
    "metadata",
    "parentMessageId",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "toolCallId",
    "toolCallName",
    "type",
  ],
  ToolCallResultEvent: [
    "content",
    "messageId",
    "metadata",
    "rawEvent",
    "role",
    "subagentRunId",
    "timestamp",
    "toolCallId",
    "type",
  ],
  StateSnapshotEvent: [
    "metadata",
    "rawEvent",
    "snapshot",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  StateDeltaEvent: [
    "delta",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  // No subagentRunId: a snapshot replaces the whole conversation, so it cannot
  // belong to one subagent.
  MessagesSnapshotEvent: [
    "messages",
    "metadata",
    "rawEvent",
    "timestamp",
    "type",
  ],
  ActivitySnapshotEvent: [
    "activityType",
    "content",
    "messageId",
    "metadata",
    "rawEvent",
    "replace",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  ActivityDeltaEvent: [
    "activityType",
    "messageId",
    "metadata",
    "patch",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  RawEvent: [
    "event",
    "metadata",
    "rawEvent",
    "source",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  CustomEvent: [
    "metadata",
    "name",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
    "value",
  ],
  // The three run-scoped events describe the run itself, so none of them carries
  // subagent attribution either.
  RunStartedEvent: [
    "input",
    "metadata",
    "parentRunId",
    "rawEvent",
    "runId",
    "threadId",
    "timestamp",
    "type",
  ],
  RunFinishedEvent: [
    "metadata",
    "outcome",
    "rawEvent",
    "result",
    "runId",
    "threadId",
    "timestamp",
    "type",
    "usage",
  ],
  RunErrorEvent: [
    "code",
    "message",
    "metadata",
    "rawEvent",
    "timestamp",
    "type",
    "usage",
  ],
  StepStartedEvent: [
    "metadata",
    "rawEvent",
    "stepName",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  StepFinishedEvent: [
    "metadata",
    "rawEvent",
    "stepName",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  ReasoningStartEvent: [
    "messageId",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  ReasoningMessageStartEvent: [
    "messageId",
    "metadata",
    "rawEvent",
    "role",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  ReasoningMessageContentEvent: [
    "delta",
    "messageId",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  ReasoningMessageEndEvent: [
    "messageId",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  ReasoningMessageChunkEvent: [
    "delta",
    "messageId",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  ReasoningEndEvent: [
    "messageId",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  ReasoningEncryptedValueEvent: [
    "encryptedValue",
    "entityId",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "subtype",
    "timestamp",
    "type",
  ],
  // subagentRunId here identifies the subagent rather than attributing the event
  // to one, which is why these three compose BaseEvent alone and declare it
  // themselves as a required field.
  SubagentStartedEvent: [
    "description",
    "metadata",
    "name",
    "parentMessageId",
    "parentSubagentRunId",
    "parentToolCallId",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  SubagentFinishedEvent: [
    "metadata",
    "outcome",
    "rawEvent",
    "result",
    "subagentRunId",
    "timestamp",
    "type",
  ],
  SubagentErrorEvent: [
    "code",
    "message",
    "metadata",
    "rawEvent",
    "subagentRunId",
    "timestamp",
    "type",
  ],
};

/**
 * The definitions that are not events but still form part of the wire contract.
 *
 * Includes the composition bases and every branch of every union. An earlier
 * version listed only what came to mind, which made the pin a false green:
 * dropping `required: ["type"]` from RunFinishedSuccessOutcome left all tests
 * passing while making `"outcome": {}` a valid RUN_FINISHED. `pins cover every
 * shaped definition` now fails if anything is left out.
 */
export const TYPE_PROPERTIES: Record<string, string[]> = {
  BaseEvent: ["metadata", "rawEvent", "timestamp", "type"],
  Attributable: ["subagentRunId"],
  BaseMessage: [
    "encryptedValue",
    "id",
    "metadata",
    "name",
    "role",
    "subagentRunId",
  ],
  RunFinishedSuccessOutcome: ["interrupts", "type"],
  RunFinishedInterruptOutcome: ["interrupts", "type"],
  SubagentFinishedSuccessOutcome: ["interruptIds", "type"],
  SubagentFinishedSuspendedOutcome: ["interruptIds", "type"],
  TextInputContent: ["text", "type"],
  ImageInputContent: ["metadata", "source", "type"],
  AudioInputContent: ["metadata", "source", "type"],
  VideoInputContent: ["metadata", "source", "type"],
  DocumentInputContent: ["metadata", "source", "type"],
  InputContentDataSource: ["mimeType", "type", "value"],
  InputContentUrlSource: ["mimeType", "type", "value"],
  RunAgentInput: [
    "context",
    "forwardedProps",
    "messages",
    "parentRunId",
    "resume",
    "runId",
    "state",
    "threadId",
    "tools",
  ],
  Interrupt: [
    "expiresAt",
    "id",
    "message",
    "metadata",
    "reason",
    "responseSchema",
    "subagentRunId",
    "toolCallId",
  ],
  ResumeEntry: ["interruptId", "metadata", "payload", "status"],
  Tool: ["description", "metadata", "name", "parameters"],
  Context: ["description", "value"],
  ToolCall: ["encryptedValue", "function", "id", "metadata", "type"],
  FunctionCall: ["arguments", "name"],
  TokenUsage: [
    "cachedInputTokens",
    "inputTokens",
    "model",
    "outputTokens",
    "provider",
    "reasoningTokens",
    "totalTokens",
  ],
  DeveloperMessage: [
    "content",
    "encryptedValue",
    "id",
    "metadata",
    "name",
    "role",
    "subagentRunId",
  ],
  SystemMessage: [
    "content",
    "encryptedValue",
    "id",
    "metadata",
    "name",
    "role",
    "subagentRunId",
  ],
  AssistantMessage: [
    "content",
    "encryptedValue",
    "id",
    "metadata",
    "name",
    "role",
    "subagentRunId",
    "toolCalls",
  ],
  UserMessage: [
    "content",
    "encryptedValue",
    "id",
    "metadata",
    "name",
    "role",
    "subagentRunId",
  ],
  ToolMessage: [
    "content",
    "encryptedValue",
    "error",
    "id",
    "metadata",
    "role",
    "subagentRunId",
    "toolCallId",
  ],
  ActivityMessage: [
    "activityType",
    "content",
    "id",
    "metadata",
    "role",
    "subagentRunId",
  ],
  ReasoningMessage: [
    "content",
    "encryptedValue",
    "id",
    "metadata",
    "role",
    "subagentRunId",
  ],
};

/**
 * What each event makes mandatory, inherited requirements included.
 *
 * Three of these are judgement calls rather than transcriptions of an SDK, made
 * because the languages disagreed and something had to be chosen:
 *
 *  - `STATE_SNAPSHOT.snapshot` is required. TypeScript's `z.any()` leaves the
 *    key optional, which would make a snapshot event carrying no snapshot valid.
 *    Python requires it, and requiring it is the reading that means anything.
 *  - `Tool.parameters` is optional. An earlier draft required it, until the
 *    reconciliation table showed all three SDKs treat it as optional — so
 *    requiring it would have made existing producers non-conformant for no gain.
 *  - `RunAgentInput` requires only `threadId`, `runId` and `messages` — the three
 *    all three SDKs already agree on. For `tools` and `context` an absent key and
 *    an empty array mean the same thing, so requiring them catches nothing.
 */
export const EVENT_REQUIRED: Record<string, string[]> = {
  TextMessageStartEvent: ["messageId", "type"],
  TextMessageContentEvent: ["delta", "messageId", "type"],
  TextMessageEndEvent: ["messageId", "type"],
  TextMessageChunkEvent: ["type"],
  ToolCallStartEvent: ["toolCallId", "toolCallName", "type"],
  ToolCallArgsEvent: ["delta", "toolCallId", "type"],
  ToolCallEndEvent: ["toolCallId", "type"],
  ToolCallChunkEvent: ["type"],
  ToolCallResultEvent: ["content", "messageId", "toolCallId", "type"],
  StateSnapshotEvent: ["snapshot", "type"],
  StateDeltaEvent: ["delta", "type"],
  MessagesSnapshotEvent: ["messages", "type"],
  ActivitySnapshotEvent: ["activityType", "content", "messageId", "type"],
  ActivityDeltaEvent: ["activityType", "messageId", "patch", "type"],
  RawEvent: ["event", "type"],
  CustomEvent: ["name", "type", "value"],
  RunStartedEvent: ["runId", "threadId", "type"],
  RunFinishedEvent: ["runId", "threadId", "type"],
  RunErrorEvent: ["message", "type"],
  StepStartedEvent: ["stepName", "type"],
  StepFinishedEvent: ["stepName", "type"],
  ReasoningStartEvent: ["messageId", "type"],
  ReasoningMessageStartEvent: ["messageId", "role", "type"],
  ReasoningMessageContentEvent: ["delta", "messageId", "type"],
  ReasoningMessageEndEvent: ["messageId", "type"],
  ReasoningMessageChunkEvent: ["type"],
  ReasoningEndEvent: ["messageId", "type"],
  ReasoningEncryptedValueEvent: [
    "encryptedValue",
    "entityId",
    "subtype",
    "type",
  ],
  SubagentStartedEvent: ["name", "subagentRunId", "type"],
  SubagentFinishedEvent: ["subagentRunId", "type"],
  SubagentErrorEvent: ["message", "subagentRunId", "type"],
};

/** What each non-event definition makes mandatory. */
export const TYPE_REQUIRED: Record<string, string[]> = {
  BaseEvent: ["type"],
  // Attributable adds an optional field and requires nothing; it exists to name
  // the category, not to constrain it.
  Attributable: [],
  BaseMessage: ["id", "role"],
  RunFinishedSuccessOutcome: ["type"],
  RunFinishedInterruptOutcome: ["interrupts", "type"],
  SubagentFinishedSuccessOutcome: ["type"],
  // interruptIds is optional: a subagent suspended because a descendant
  // interrupted owns no interrupt of its own.
  SubagentFinishedSuspendedOutcome: ["type"],
  TextInputContent: ["text", "type"],
  ImageInputContent: ["source", "type"],
  AudioInputContent: ["source", "type"],
  VideoInputContent: ["source", "type"],
  DocumentInputContent: ["source", "type"],
  InputContentDataSource: ["mimeType", "type", "value"],
  // mimeType is optional on a URL source only, because the response can say.
  InputContentUrlSource: ["type", "value"],
  RunAgentInput: ["messages", "runId", "threadId"],
  Interrupt: ["id", "reason"],
  ResumeEntry: ["interruptId", "status"],
  Tool: ["description", "name"],
  Context: ["description", "value"],
  ToolCall: ["function", "id", "type"],
  FunctionCall: ["arguments", "name"],
  // Every count is optional: a provider that reports only totals should not have
  // to invent the breakdown.
  TokenUsage: [],
  DeveloperMessage: ["content", "id", "role"],
  SystemMessage: ["content", "id", "role"],
  AssistantMessage: ["id", "role"],
  UserMessage: ["content", "id", "role"],
  ToolMessage: ["content", "id", "role", "toolCallId"],
  ActivityMessage: ["activityType", "content", "id", "role"],
  ReasoningMessage: ["content", "id", "role"],
};

/** The RFC 6902 operations, pinned for the same reason as everything else. */
export const PATCH_PROPERTIES: Record<string, string[]> = {
  AddOperation: ["op", "path", "value"],
  RemoveOperation: ["op", "path"],
  ReplaceOperation: ["op", "path", "value"],
  MoveOperation: ["from", "op", "path"],
  CopyOperation: ["from", "op", "path"],
  TestOperation: ["op", "path", "value"],
};

export const PATCH_REQUIRED: Record<string, string[]> = {
  AddOperation: ["op", "path", "value"],
  RemoveOperation: ["op", "path"],
  ReplaceOperation: ["op", "path", "value"],
  MoveOperation: ["from", "op", "path"],
  CopyOperation: ["from", "op", "path"],
  TestOperation: ["op", "path", "value"],
};

/**
 * Every union's members, by definition name.
 *
 * The event union was pinned from the start; these were not, so a member could be
 * dropped with the suite green — deleting the audio and video branches of
 * `InputContent` leaves every fixture passing and every structural check happy,
 * while a message carrying an audio part becomes invalid.
 *
 * `Event` is pinned separately, against the EventType enum and the definitions,
 * because it also has to be exactly 31.
 */
export const UNION_MEMBERS: Record<string, string[]> = {
  RunFinishedOutcome: [
    "RunFinishedSuccessOutcome",
    "RunFinishedInterruptOutcome",
  ],
  // The inline one, keyed by where it sits. Looking only at definition-level
  // unions missed it, so a member could be added with the suite green —
  // `{"type": "number"}` here makes `content: 42` a valid user message.
  "UserMessage/properties/content": ["type:string", "type:array"],
  SubagentFinishedOutcome: [
    "SubagentFinishedSuccessOutcome",
    "SubagentFinishedSuspendedOutcome",
  ],
  Message: [
    "DeveloperMessage",
    "SystemMessage",
    "AssistantMessage",
    "UserMessage",
    "ToolMessage",
    "ActivityMessage",
    "ReasoningMessage",
  ],
  InputContent: [
    "TextInputContent",
    "ImageInputContent",
    "AudioInputContent",
    "VideoInputContent",
    "DocumentInputContent",
  ],
  InputContentSource: ["InputContentDataSource", "InputContentUrlSource"],
};

/** The RFC 6902 operation union. */
export const PATCH_UNION_MEMBERS: Record<string, string[]> = {
  JsonPatchOperation: [
    "AddOperation",
    "RemoveOperation",
    "ReplaceOperation",
    "MoveOperation",
    "CopyOperation",
    "TestOperation",
  ],
};

/**
 * Every enum's members, by location. `EventType` is excluded: it is checked
 * against the definitions and the union instead, which is stronger.
 */
export const ENUM_MEMBERS: Record<string, string[]> = {
  TextMessageRole: ["developer", "system", "assistant", "user"],
  Role: [
    "developer",
    "system",
    "assistant",
    "user",
    "tool",
    "activity",
    "reasoning",
  ],
  ReasoningEncryptedValueSubtype: ["tool-call", "message"],
  "ResumeEntry/properties/status": ["resolved", "cancelled"],
};

/**
 * Every fixed value, by location.
 *
 * A `const` is what makes a discriminated union discriminate, and two of these
 * were verifiably decorative: replacing `RunFinishedSuccessOutcome`'s or
 * `ToolCall`'s with `type: "string"` left the whole suite green while admitting
 * `{"type": "completed"}` as an outcome and a tool call of an unknown kind. Pinned
 * by location, with a coverage check, so a fixed value cannot stop being fixed
 * quietly.
 */
export const CONST_VALUES: Record<string, string> = {
  "TextMessageStartEvent/properties/type": "TEXT_MESSAGE_START",
  "TextMessageContentEvent/properties/type": "TEXT_MESSAGE_CONTENT",
  "TextMessageEndEvent/properties/type": "TEXT_MESSAGE_END",
  "TextMessageChunkEvent/properties/type": "TEXT_MESSAGE_CHUNK",
  "ToolCallStartEvent/properties/type": "TOOL_CALL_START",
  "ToolCallArgsEvent/properties/type": "TOOL_CALL_ARGS",
  "ToolCallEndEvent/properties/type": "TOOL_CALL_END",
  "ToolCallChunkEvent/properties/type": "TOOL_CALL_CHUNK",
  "ToolCallResultEvent/properties/type": "TOOL_CALL_RESULT",
  "ToolCallResultEvent/properties/role": "tool",
  "StateSnapshotEvent/properties/type": "STATE_SNAPSHOT",
  "StateDeltaEvent/properties/type": "STATE_DELTA",
  "MessagesSnapshotEvent/properties/type": "MESSAGES_SNAPSHOT",
  "ActivitySnapshotEvent/properties/type": "ACTIVITY_SNAPSHOT",
  "ActivityDeltaEvent/properties/type": "ACTIVITY_DELTA",
  "RawEvent/properties/type": "RAW",
  "CustomEvent/properties/type": "CUSTOM",
  "RunStartedEvent/properties/type": "RUN_STARTED",
  "RunFinishedEvent/properties/type": "RUN_FINISHED",
  "RunErrorEvent/properties/type": "RUN_ERROR",
  "StepStartedEvent/properties/type": "STEP_STARTED",
  "StepFinishedEvent/properties/type": "STEP_FINISHED",
  "ReasoningStartEvent/properties/type": "REASONING_START",
  "ReasoningMessageStartEvent/properties/type": "REASONING_MESSAGE_START",
  "ReasoningMessageStartEvent/properties/role": "reasoning",
  "ReasoningMessageContentEvent/properties/type": "REASONING_MESSAGE_CONTENT",
  "ReasoningMessageEndEvent/properties/type": "REASONING_MESSAGE_END",
  "ReasoningMessageChunkEvent/properties/type": "REASONING_MESSAGE_CHUNK",
  "ReasoningEndEvent/properties/type": "REASONING_END",
  "ReasoningEncryptedValueEvent/properties/type": "REASONING_ENCRYPTED_VALUE",
  "SubagentStartedEvent/properties/type": "SUBAGENT_STARTED",
  "SubagentFinishedEvent/properties/type": "SUBAGENT_FINISHED",
  "SubagentErrorEvent/properties/type": "SUBAGENT_ERROR",
  "RunFinishedSuccessOutcome/properties/type": "success",
  "RunFinishedInterruptOutcome/properties/type": "interrupt",
  "SubagentFinishedSuccessOutcome/properties/type": "success",
  "SubagentFinishedSuspendedOutcome/properties/type": "suspended",
  "DeveloperMessage/properties/role": "developer",
  "SystemMessage/properties/role": "system",
  "AssistantMessage/properties/role": "assistant",
  "UserMessage/properties/role": "user",
  "ToolMessage/properties/role": "tool",
  "ActivityMessage/properties/role": "activity",
  "ReasoningMessage/properties/role": "reasoning",
  "ToolCall/properties/type": "function",
  "TextInputContent/properties/type": "text",
  "ImageInputContent/properties/type": "image",
  "AudioInputContent/properties/type": "audio",
  "VideoInputContent/properties/type": "video",
  "DocumentInputContent/properties/type": "document",
  "InputContentDataSource/properties/type": "data",
  "InputContentUrlSource/properties/type": "url",
};

/** The RFC 6902 operation discriminators. */
export const PATCH_CONST_VALUES: Record<string, string> = {
  "AddOperation/properties/op": "add",
  "RemoveOperation/properties/op": "remove",
  "ReplaceOperation/properties/op": "replace",
  "MoveOperation/properties/op": "move",
  "CopyOperation/properties/op": "copy",
  "TestOperation/properties/op": "test",
};
