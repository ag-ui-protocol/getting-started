// @generated from https://ag-ui.com/spec/draft/schema.json. DO NOT EDIT.
// Regenerate with pnpm --filter @ag-ui/spec generate.

type Shape =
  | string
  | { array: Shape }
  | {
      optional: string[];
      fields: Record<string, Shape>;
    }
  | { discriminator: string; variants: Record<string, string> };

const shapes: Record<string, Shape> = {
  TextMessageStartEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId", "role", "name"],
    fields: {},
  },
  TextMessageContentEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  TextMessageEndEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  TextMessageChunkEvent: {
    optional: [
      "timestamp",
      "rawEvent",
      "metadata",
      "subagentRunId",
      "messageId",
      "role",
      "delta",
      "name",
    ],
    fields: {},
  },
  ToolCallStartEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId", "parentMessageId"],
    fields: {},
  },
  ToolCallArgsEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  ToolCallEndEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  ToolCallChunkEvent: {
    optional: [
      "timestamp",
      "rawEvent",
      "metadata",
      "subagentRunId",
      "toolCallId",
      "toolCallName",
      "parentMessageId",
      "delta",
    ],
    fields: {},
  },
  ToolCallResultEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId", "role"],
    fields: {},
  },
  StateSnapshotEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  AddOperation: { optional: [], fields: {} },
  RemoveOperation: { optional: [], fields: {} },
  ReplaceOperation: { optional: [], fields: {} },
  MoveOperation: { optional: [], fields: {} },
  CopyOperation: { optional: [], fields: {} },
  TestOperation: { optional: [], fields: {} },
  JsonPatchOperation: {
    discriminator: "op",
    variants: {
      add: "AddOperation",
      remove: "RemoveOperation",
      replace: "ReplaceOperation",
      move: "MoveOperation",
      copy: "CopyOperation",
      test: "TestOperation",
    },
  },
  StateDeltaEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: { delta: { array: "JsonPatchOperation" } },
  },
  DeveloperMessage: {
    optional: ["subagentRunId", "name", "encryptedValue", "metadata"],
    fields: {},
  },
  SystemMessage: { optional: ["subagentRunId", "name", "encryptedValue", "metadata"], fields: {} },
  FunctionCall: { optional: [], fields: {} },
  ToolCall: { optional: ["encryptedValue", "metadata"], fields: { function: "FunctionCall" } },
  AssistantMessage: {
    optional: ["subagentRunId", "name", "encryptedValue", "metadata", "content", "toolCalls"],
    fields: { toolCalls: { array: "ToolCall" } },
  },
  TextInputContent: { optional: [], fields: {} },
  InputContentDataSource: { optional: [], fields: {} },
  InputContentUrlSource: { optional: ["mimeType"], fields: {} },
  InputContentSource: {
    discriminator: "type",
    variants: { data: "InputContentDataSource", url: "InputContentUrlSource" },
  },
  ImageInputContent: { optional: ["metadata"], fields: { source: "InputContentSource" } },
  AudioInputContent: { optional: ["metadata"], fields: { source: "InputContentSource" } },
  VideoInputContent: { optional: ["metadata"], fields: { source: "InputContentSource" } },
  DocumentInputContent: { optional: ["metadata"], fields: { source: "InputContentSource" } },
  InputContent: {
    discriminator: "type",
    variants: {
      text: "TextInputContent",
      image: "ImageInputContent",
      audio: "AudioInputContent",
      video: "VideoInputContent",
      document: "DocumentInputContent",
    },
  },
  UserMessage: {
    optional: ["subagentRunId", "name", "encryptedValue", "metadata"],
    fields: { content: { array: "InputContent" } },
  },
  ToolMessage: { optional: ["subagentRunId", "error", "encryptedValue", "metadata"], fields: {} },
  ActivityMessage: { optional: ["subagentRunId", "metadata"], fields: {} },
  ReasoningMessage: { optional: ["subagentRunId", "encryptedValue", "metadata"], fields: {} },
  Message: {
    discriminator: "role",
    variants: {
      developer: "DeveloperMessage",
      system: "SystemMessage",
      assistant: "AssistantMessage",
      user: "UserMessage",
      tool: "ToolMessage",
      activity: "ActivityMessage",
      reasoning: "ReasoningMessage",
    },
  },
  MessagesSnapshotEvent: {
    optional: ["timestamp", "rawEvent", "metadata"],
    fields: { messages: { array: "Message" } },
  },
  ActivitySnapshotEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId", "replace"],
    fields: {},
  },
  ActivityDeltaEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: { patch: { array: "JsonPatchOperation" } },
  },
  RawEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId", "source"],
    fields: {},
  },
  CustomEvent: { optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"], fields: {} },
  Tool: { optional: ["parameters", "metadata"], fields: {} },
  Context: { optional: [], fields: {} },
  ResumeEntry: { optional: ["payload", "metadata"], fields: {} },
  RunAgentInput: {
    optional: [
      "protocolVersion",
      "parentRunId",
      "state",
      "tools",
      "context",
      "forwardedProps",
      "resume",
    ],
    fields: {
      messages: { array: "Message" },
      tools: { array: "Tool" },
      context: { array: "Context" },
      resume: { array: "ResumeEntry" },
    },
  },
  RunStartedEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "protocolVersion", "parentRunId", "input"],
    fields: { input: "RunAgentInput" },
  },
  RunFinishedSuccessOutcome: { optional: [], fields: {} },
  Interrupt: {
    optional: ["subagentRunId", "message", "toolCallId", "responseSchema", "expiresAt", "metadata"],
    fields: {},
  },
  RunFinishedInterruptOutcome: { optional: [], fields: { interrupts: { array: "Interrupt" } } },
  RunFinishedOutcome: {
    discriminator: "type",
    variants: { success: "RunFinishedSuccessOutcome", interrupt: "RunFinishedInterruptOutcome" },
  },
  TokenUsage: {
    optional: [
      "provider",
      "model",
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "reasoningTokens",
      "cachedInputTokens",
    ],
    fields: {},
  },
  RunFinishedEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "result", "outcome", "usage"],
    fields: { outcome: "RunFinishedOutcome", usage: { array: "TokenUsage" } },
  },
  RunErrorEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "code", "usage"],
    fields: { usage: { array: "TokenUsage" } },
  },
  StepStartedEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  StepFinishedEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  ReasoningStartEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  ReasoningMessageStartEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  ReasoningMessageContentEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  ReasoningMessageEndEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  ReasoningMessageChunkEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId", "messageId", "delta"],
    fields: {},
  },
  ReasoningEndEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  ReasoningEncryptedValueEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "subagentRunId"],
    fields: {},
  },
  SubagentStartedEvent: {
    optional: [
      "timestamp",
      "rawEvent",
      "metadata",
      "description",
      "parentSubagentRunId",
      "parentToolCallId",
      "parentMessageId",
    ],
    fields: {},
  },
  SubagentFinishedSuccessOutcome: { optional: [], fields: {} },
  SubagentFinishedSuspendedOutcome: { optional: ["interruptIds"], fields: {} },
  SubagentFinishedOutcome: {
    discriminator: "type",
    variants: {
      success: "SubagentFinishedSuccessOutcome",
      suspended: "SubagentFinishedSuspendedOutcome",
    },
  },
  SubagentFinishedEvent: {
    optional: ["timestamp", "rawEvent", "metadata", "result", "outcome"],
    fields: { outcome: "SubagentFinishedOutcome" },
  },
  SubagentErrorEvent: { optional: ["timestamp", "rawEvent", "metadata", "code"], fields: {} },
  Event: {
    discriminator: "type",
    variants: {
      TEXT_MESSAGE_START: "TextMessageStartEvent",
      TEXT_MESSAGE_CONTENT: "TextMessageContentEvent",
      TEXT_MESSAGE_END: "TextMessageEndEvent",
      TEXT_MESSAGE_CHUNK: "TextMessageChunkEvent",
      TOOL_CALL_START: "ToolCallStartEvent",
      TOOL_CALL_ARGS: "ToolCallArgsEvent",
      TOOL_CALL_END: "ToolCallEndEvent",
      TOOL_CALL_CHUNK: "ToolCallChunkEvent",
      TOOL_CALL_RESULT: "ToolCallResultEvent",
      STATE_SNAPSHOT: "StateSnapshotEvent",
      STATE_DELTA: "StateDeltaEvent",
      MESSAGES_SNAPSHOT: "MessagesSnapshotEvent",
      ACTIVITY_SNAPSHOT: "ActivitySnapshotEvent",
      ACTIVITY_DELTA: "ActivityDeltaEvent",
      RAW: "RawEvent",
      CUSTOM: "CustomEvent",
      RUN_STARTED: "RunStartedEvent",
      RUN_FINISHED: "RunFinishedEvent",
      RUN_ERROR: "RunErrorEvent",
      STEP_STARTED: "StepStartedEvent",
      STEP_FINISHED: "StepFinishedEvent",
      REASONING_START: "ReasoningStartEvent",
      REASONING_MESSAGE_START: "ReasoningMessageStartEvent",
      REASONING_MESSAGE_CONTENT: "ReasoningMessageContentEvent",
      REASONING_MESSAGE_END: "ReasoningMessageEndEvent",
      REASONING_MESSAGE_CHUNK: "ReasoningMessageChunkEvent",
      REASONING_END: "ReasoningEndEvent",
      REASONING_ENCRYPTED_VALUE: "ReasoningEncryptedValueEvent",
      SUBAGENT_STARTED: "SubagentStartedEvent",
      SUBAGENT_FINISHED: "SubagentFinishedEvent",
      SUBAGENT_ERROR: "SubagentErrorEvent",
    },
  },
  SubagentInfo: { optional: ["description"], fields: {} },
  IdentityCapabilities: {
    optional: [
      "name",
      "type",
      "description",
      "version",
      "provider",
      "documentationUrl",
      "metadata",
    ],
    fields: {},
  },
  TransportCapabilities: {
    optional: ["streaming", "websocket", "httpBinary", "pushNotifications", "resumable"],
    fields: {},
  },
  ToolsCapabilities: {
    optional: ["supported", "items", "parallelCalls", "clientProvided"],
    fields: { items: { array: "Tool" } },
  },
  OutputCapabilities: { optional: ["structuredOutput", "supportedMimeTypes"], fields: {} },
  StateCapabilities: { optional: ["snapshots", "deltas", "memory", "persistentState"], fields: {} },
  MultiAgentCapabilities: {
    optional: ["supported", "delegation", "handoffs", "subagents"],
    fields: { subagents: { array: "SubagentInfo" } },
  },
  ReasoningCapabilities: { optional: ["supported", "streaming", "encrypted"], fields: {} },
  MultimodalInputCapabilities: { optional: ["image", "audio", "video", "pdf", "file"], fields: {} },
  MultimodalOutputCapabilities: { optional: ["image", "audio"], fields: {} },
  MultimodalCapabilities: {
    optional: ["input", "output"],
    fields: { input: "MultimodalInputCapabilities", output: "MultimodalOutputCapabilities" },
  },
  ExecutionCapabilities: {
    optional: ["codeExecution", "sandboxed", "maxIterations", "maxExecutionTime"],
    fields: {},
  },
  HumanInTheLoopCapabilities: {
    optional: [
      "supported",
      "approvals",
      "interventions",
      "feedback",
      "interrupts",
      "approveWithEdits",
    ],
    fields: {},
  },
  AgentCapabilities: {
    optional: [
      "identity",
      "transport",
      "tools",
      "output",
      "state",
      "multiAgent",
      "reasoning",
      "multimodal",
      "execution",
      "humanInTheLoop",
      "custom",
    ],
    fields: {
      identity: "IdentityCapabilities",
      transport: "TransportCapabilities",
      tools: "ToolsCapabilities",
      output: "OutputCapabilities",
      state: "StateCapabilities",
      multiAgent: "MultiAgentCapabilities",
      reasoning: "ReasoningCapabilities",
      multimodal: "MultimodalCapabilities",
      execution: "ExecutionCapabilities",
      humanInTheLoop: "HumanInTheLoopCapabilities",
    },
  },
};

function omit(value: unknown, shape: Shape): unknown {
  if (typeof shape === "string") return omit(value, shapes[shape]);
  if ("array" in shape) {
    if (!Array.isArray(value)) return value;
    const result = value.map((item) => omit(item, shape.array));
    return result.every((item, index) => item === value[index]) ? value : result;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  if ("discriminator" in shape) {
    const tag = object[shape.discriminator];
    return typeof tag === "string" && Object.prototype.hasOwnProperty.call(shape.variants, tag)
      ? omit(value, shape.variants[tag])
      : value;
  }
  let result = object;
  for (const key of shape.optional) {
    if (Object.prototype.hasOwnProperty.call(object, key) && object[key] === null) {
      if (result === object) result = { ...object };
      delete result[key];
    }
  }
  for (const [key, child] of Object.entries(shape.fields)) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    const next = omit(result[key], child);
    if (next !== result[key]) {
      if (result === object) result = { ...object };
      result[key] = next;
    }
  }
  return result;
}

/**
 * Omits whole optional null fields before transmission. Does not validate,
 * mutate the input, or traverse arbitrary application JSON or unknown fields.
 * Required null payloads and null values inside opaque data remain intact.
 */
export function omitOptionalNulls<T>(value: T, root: "Event" | "RunAgentInput"): T {
  return omit(value, root) as T;
}
