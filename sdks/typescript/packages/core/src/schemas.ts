// zod schemas for AG-UI types and events. This module is published at the
// `@ag-ui/core/schemas` subpath. zod is an optional peer dependency — install
// it explicitly if you import from this module. The schemas mirror the types
// exported from the main `@ag-ui/core` entry.
//
// Cross-version note: this module imports `zod/v4`, NOT `zod`.
//
// zod 3.25.x shipped the whole zod 4 implementation at the `zod/v4` subpath, and
// zod 4.x keeps `zod/v4` as an alias for its own classic entry. Both majors
// therefore expose an identical `zod/v4` API, which is what lets a single set of
// emitted .d.ts files type-check against either. Importing bare `zod` would bake
// major-specific declaration shapes (`ZodEnum<[...]>`, five-parameter `ZodObject`,
// `ZodEffects`) into the published types and break consumers on the other major.
//
// The supported peer range is `^3.25.18 || ^4.0.0`. zod 3.24.x has no `zod/v4`
// subpath at all, and 3.25.0-3.25.17 ship `zod/v4` declarations that fail TS
// variance checks under `skipLibCheck: false` (3.25.0 has no dist/ whatsoever),
// so 3.25.18 is the lowest release we can honestly claim to support.
//
// Caveat: the zod/v4 *API surface* is stable across the range, but the *engine*
// version is not — zod@3.25.x ships engine 4.0.0 while zod@4.4.x ships 4.4.x, and
// their behavior differs in places. Most importantly, a bare `z.any()` object value
// is accepted when missing on 4.0.0 but rejected as `nonoptional` on 4.4.x. Every
// `z.any()` used as an object value below is therefore explicitly `.optional()` so
// the protocol contract does not depend on which zod the consumer installed. See
// __tests__/zod-version-conformance.test.ts.

import { z } from "zod/v4";
import { EventType } from "./events";

// ---------------------------------------------------------------------------
// EventType enum values as a z.enum tuple. z.nativeEnum() was removed in zod 4,
// so the values are enumerated explicitly.
// ---------------------------------------------------------------------------

export const EventTypeSchema = z.enum([
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TEXT_MESSAGE_CHUNK",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_CHUNK",
  "TOOL_CALL_RESULT",
  "THINKING_START",
  "THINKING_END",
  "THINKING_TEXT_MESSAGE_START",
  "THINKING_TEXT_MESSAGE_CONTENT",
  "THINKING_TEXT_MESSAGE_END",
  "STATE_SNAPSHOT",
  "STATE_DELTA",
  "MESSAGES_SNAPSHOT",
  "ACTIVITY_SNAPSHOT",
  "ACTIVITY_DELTA",
  "RAW",
  "CUSTOM",
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "STEP_STARTED",
  "STEP_FINISHED",
  "REASONING_START",
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
  "REASONING_MESSAGE_CHUNK",
  "REASONING_END",
  "REASONING_ENCRYPTED_VALUE",
] as const);

// ---------------------------------------------------------------------------
// Base types (from types.ts)
// ---------------------------------------------------------------------------

export const FunctionCallSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: FunctionCallSchema,
  encryptedValue: z.string().optional(),
});

export const TextInputContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const InputContentDataSourceSchema = z.object({
  type: z.literal("data"),
  value: z.string(),
  mimeType: z.string(),
});

export const InputContentUrlSourceSchema = z.object({
  type: z.literal("url"),
  value: z.string(),
  mimeType: z.string().optional(),
});

export const InputContentSourceSchema = z.discriminatedUnion("type", [
  InputContentDataSourceSchema,
  InputContentUrlSourceSchema,
]);

export const ImageInputContentSchema = z.object({
  type: z.literal("image"),
  source: InputContentSourceSchema,
  metadata: z.unknown().optional(),
});

export const AudioInputContentSchema = z.object({
  type: z.literal("audio"),
  source: InputContentSourceSchema,
  metadata: z.unknown().optional(),
});

export const VideoInputContentSchema = z.object({
  type: z.literal("video"),
  source: InputContentSourceSchema,
  metadata: z.unknown().optional(),
});

export const DocumentInputContentSchema = z.object({
  type: z.literal("document"),
  source: InputContentSourceSchema,
  metadata: z.unknown().optional(),
});

export const ImageInputPartSchema = ImageInputContentSchema;
export const AudioInputPartSchema = AudioInputContentSchema;
export const VideoInputPartSchema = VideoInputContentSchema;
export const DocumentInputPartSchema = DocumentInputContentSchema;

export const BinaryInputContentSchema = z
  .object({
    type: z.literal("binary"),
    mimeType: z.string(),
    id: z.string().optional(),
    url: z.string().optional(),
    data: z.string().optional(),
    filename: z.string().optional(),
  })
  .refine((value) => Boolean(value.id || value.url || value.data), {
    message: "BinaryInputContent requires at least one of id, url, or data.",
  });

export const InputContentSchema = z
  .discriminatedUnion("type", [
    TextInputContentSchema,
    ImageInputContentSchema,
    AudioInputContentSchema,
    VideoInputContentSchema,
    DocumentInputContentSchema,
    z.object({
      type: z.literal("binary"),
      mimeType: z.string(),
      id: z.string().optional(),
      url: z.string().optional(),
      data: z.string().optional(),
      filename: z.string().optional(),
    }),
  ])
  .refine(
    (value) => {
      if (value.type === "binary") {
        return Boolean(
          (value as { id?: string; url?: string; data?: string }).id ||
            (value as { id?: string; url?: string; data?: string }).url ||
            (value as { id?: string; url?: string; data?: string }).data,
        );
      }
      return true;
    },
    { message: "BinaryInputContent requires at least one of id, url, or data." },
  );

export const InputContentPartSchema = InputContentSchema;

const BaseMessageSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  encryptedValue: z.string().optional(),
});

export const DeveloperMessageSchema = BaseMessageSchema.extend({
  role: z.literal("developer"),
  content: z.string(),
});

export const SystemMessageSchema = BaseMessageSchema.extend({
  role: z.literal("system"),
  content: z.string(),
});

export const AssistantMessageSchema = BaseMessageSchema.extend({
  role: z.literal("assistant"),
  content: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
});

export const UserMessageSchema = BaseMessageSchema.extend({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(InputContentSchema)]),
});

export const ToolMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  role: z.literal("tool"),
  toolCallId: z.string(),
  error: z.string().optional(),
  encryptedValue: z.string().optional(),
});

export const ActivityMessageSchema = z.object({
  id: z.string(),
  role: z.literal("activity"),
  activityType: z.string(),
  content: z.record(z.string(), z.any()),
});

export const ReasoningMessageSchema = z.object({
  id: z.string(),
  role: z.literal("reasoning"),
  content: z.string(),
  encryptedValue: z.string().optional(),
});

export const MessageSchema = z.discriminatedUnion("role", [
  DeveloperMessageSchema,
  SystemMessageSchema,
  AssistantMessageSchema,
  UserMessageSchema,
  ToolMessageSchema,
  ActivityMessageSchema,
  ReasoningMessageSchema,
]);

export const RoleSchema = z.union([
  z.literal("developer"),
  z.literal("system"),
  z.literal("assistant"),
  z.literal("user"),
  z.literal("tool"),
  z.literal("activity"),
  z.literal("reasoning"),
]);

export const ContextSchema = z.object({
  description: z.string(),
  value: z.string(),
});

export const ToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  // `.optional()` is load-bearing across the zod range — see the engine caveat above.
  parameters: z.any().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const InterruptSchema = z.object({
  id: z.string(),
  reason: z.string(),
  message: z.string().optional(),
  toolCallId: z.string().optional(),
  responseSchema: z.record(z.string(), z.any()).optional(),
  expiresAt: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const ResumeEntrySchema = z.object({
  interruptId: z.string(),
  status: z.enum(["resolved", "cancelled"]),
  payload: z.any().optional(),
});

export const RunAgentInputSchema = z.object({
  threadId: z.string(),
  runId: z.string(),
  parentRunId: z.string().optional(),
  state: z.any().optional(),
  messages: z.array(MessageSchema),
  tools: z.array(ToolSchema),
  context: z.array(ContextSchema),
  forwardedProps: z.any().optional(),
  resume: z.array(ResumeEntrySchema).optional(),
});

// `State` is unconstrained, so this carries no validation. It stays `z.any()` (not
// `.optional()`) because it is also used standalone; object-value uses below add
// `.optional()` at the use site.
export const StateSchema = z.any();

// ---------------------------------------------------------------------------
// Event schemas (from events.ts)
// ---------------------------------------------------------------------------

const TextMessageRoleSchema = z.union([
  z.literal("developer"),
  z.literal("system"),
  z.literal("assistant"),
  z.literal("user"),
]);

export const BaseEventSchema = z
  .object({
    type: EventTypeSchema,
    timestamp: z.number().optional(),
    rawEvent: z.any().optional(),
  })
  .passthrough();

export const TextMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_START),
  messageId: z.string(),
  role: TextMessageRoleSchema.default("assistant"),
  name: z.string().optional(),
});

export const TextMessageContentEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_CONTENT),
  messageId: z.string(),
  delta: z.string(),
});

export const TextMessageEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_END),
  messageId: z.string(),
});

export const TextMessageChunkEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_CHUNK),
  messageId: z.string().optional(),
  role: TextMessageRoleSchema.optional(),
  delta: z.string().optional(),
  name: z.string().optional(),
});

/**
 * @deprecated Use ReasoningTextMessageStartEventSchema instead. Will be removed in 1.0.0.
 */
export const ThinkingTextMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.THINKING_TEXT_MESSAGE_START),
});

/**
 * @deprecated Use ReasoningMessageContentEventSchema instead. Will be removed in 1.0.0.
 */
export const ThinkingTextMessageContentEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.THINKING_TEXT_MESSAGE_CONTENT),
  delta: z.string(),
});

/**
 * @deprecated Use ReasoningMessageEndEventSchema instead. Will be removed in 1.0.0.
 */
export const ThinkingTextMessageEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.THINKING_TEXT_MESSAGE_END),
});

export const ToolCallStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_START),
  toolCallId: z.string(),
  toolCallName: z.string(),
  // Accept `null` and treat it as omitted, so producers that serialize optional
  // fields as JSON `null` (e.g. the .NET Microsoft Agent Framework adapter, whose
  // System.Text.Json emits `"parentMessageId": null`) still validate instead of
  // aborting the run on the first tool call.
  parentMessageId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
});

export const ToolCallArgsEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_ARGS),
  toolCallId: z.string(),
  delta: z.string(),
});

export const ToolCallEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_END),
  toolCallId: z.string(),
});

export const ToolCallResultEventSchema = BaseEventSchema.extend({
  messageId: z.string(),
  type: z.literal(EventType.TOOL_CALL_RESULT),
  toolCallId: z.string(),
  content: z.string(),
  role: z.literal("tool").optional(),
});

export const ToolCallChunkEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_CHUNK),
  toolCallId: z.string().optional(),
  toolCallName: z.string().optional(),
  // Accept `null` as omitted — same cross-language quirk as TOOL_CALL_START.
  parentMessageId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
  delta: z.string().optional(),
});

/**
 * @deprecated Use ReasoningStartEventSchema instead. Will be removed in 1.0.0.
 */
export const ThinkingStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.THINKING_START),
  title: z.string().optional(),
});

/**
 * @deprecated Use ReasoningEndEventSchema instead. Will be removed in 1.0.0.
 */
export const ThinkingEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.THINKING_END),
});

export const StateSnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STATE_SNAPSHOT),
  snapshot: StateSchema.optional(),
});

export const StateDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STATE_DELTA),
  delta: z.array(z.any()),
});

export const MessagesSnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.MESSAGES_SNAPSHOT),
  messages: z.array(MessageSchema),
});

export const ActivitySnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ACTIVITY_SNAPSHOT),
  messageId: z.string(),
  activityType: z.string(),
  content: z.record(z.string(), z.any()),
  replace: z.boolean().optional().default(true),
});

export const ActivityDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ACTIVITY_DELTA),
  messageId: z.string(),
  activityType: z.string(),
  patch: z.array(z.any()),
});

export const RawEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RAW),
  event: z.any().optional(),
  source: z.string().optional(),
});

export const CustomEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.CUSTOM),
  name: z.string(),
  value: z.any().optional(),
});

export const RunStartedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_STARTED),
  threadId: z.string(),
  runId: z.string(),
  parentRunId: z.string().optional(),
  input: RunAgentInputSchema.optional(),
});

export const RunFinishedSuccessOutcomeSchema = z
  .object({
    type: z.literal("success"),
  })
  .strict();

export const RunFinishedInterruptOutcomeSchema = z
  .object({
    type: z.literal("interrupt"),
    interrupts: z.array(InterruptSchema).min(1),
  })
  .strict();

export const RunFinishedOutcomeSchema = z.discriminatedUnion("type", [
  RunFinishedSuccessOutcomeSchema,
  RunFinishedInterruptOutcomeSchema,
]);

export const RunFinishedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_FINISHED),
  threadId: z.string(),
  runId: z.string(),
  result: z.any().optional(),
  // Accept `null` and treat it as omitted, so producers that emit `"outcome": null`
  // for the legacy no-outcome case still validate.
  outcome: RunFinishedOutcomeSchema.nullable()
    .optional()
    .transform((v) => v ?? undefined),
});

export const RunErrorEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_ERROR),
  message: z.string(),
  code: z.string().optional(),
});

export const StepStartedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STEP_STARTED),
  stepName: z.string(),
});

export const StepFinishedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STEP_FINISHED),
  stepName: z.string(),
});

export const ReasoningEncryptedValueSubtypeSchema = z.union([
  z.literal("tool-call"),
  z.literal("message"),
]);

export const ReasoningStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_START),
  messageId: z.string(),
});

export const ReasoningMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_START),
  messageId: z.string(),
  role: z.literal("reasoning"),
});

export const ReasoningMessageContentEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_CONTENT),
  messageId: z.string(),
  delta: z.string(),
});

export const ReasoningMessageEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_END),
  messageId: z.string(),
});

export const ReasoningMessageChunkEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_CHUNK),
  messageId: z.string().optional(),
  delta: z.string().optional(),
});

export const ReasoningEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_END),
  messageId: z.string(),
});

export const ReasoningEncryptedValueEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_ENCRYPTED_VALUE),
  subtype: ReasoningEncryptedValueSubtypeSchema,
  entityId: z.string(),
  encryptedValue: z.string(),
});

/**
 * Discriminated union of all AG-UI event schemas. Suitable for validating
 * untrusted event payloads from the wire.
 */
export const EventSchemas = z.discriminatedUnion("type", [
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageChunkEventSchema,
  ThinkingStartEventSchema,
  ThinkingEndEventSchema,
  ThinkingTextMessageStartEventSchema,
  ThinkingTextMessageContentEventSchema,
  ThinkingTextMessageEndEventSchema,
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallChunkEventSchema,
  ToolCallResultEventSchema,
  StateSnapshotEventSchema,
  StateDeltaEventSchema,
  MessagesSnapshotEventSchema,
  ActivitySnapshotEventSchema,
  ActivityDeltaEventSchema,
  RawEventSchema,
  CustomEventSchema,
  RunStartedEventSchema,
  RunFinishedEventSchema,
  RunErrorEventSchema,
  StepStartedEventSchema,
  StepFinishedEventSchema,
  ReasoningStartEventSchema,
  ReasoningMessageStartEventSchema,
  ReasoningMessageContentEventSchema,
  ReasoningMessageEndEventSchema,
  ReasoningMessageChunkEventSchema,
  ReasoningEndEventSchema,
  ReasoningEncryptedValueEventSchema,
]);

// ---------------------------------------------------------------------------
// Capability schemas (from capabilities.ts)
// ---------------------------------------------------------------------------

/** Describes a sub-agent that can be invoked by a parent agent. */
export const SubAgentInfoSchema = z.object({
  /** Unique name or identifier of the sub-agent. */
  name: z.string(),
  /** What this sub-agent specializes in. Helps clients build agent selection UIs. */
  description: z.string().optional(),
});

/**
 * Basic metadata about the agent. Useful for discovery UIs, agent marketplaces,
 * and debugging.
 */
export const IdentityCapabilitiesSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  provider: z.string().optional(),
  documentationUrl: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Declares which transport mechanisms the agent supports.
 */
export const TransportCapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  websocket: z.boolean().optional(),
  httpBinary: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  resumable: z.boolean().optional(),
});

/**
 * Tool calling capabilities.
 */
export const ToolsCapabilitiesSchema = z.object({
  supported: z.boolean().optional(),
  items: z.array(ToolSchema).optional(),
  parallelCalls: z.boolean().optional(),
  clientProvided: z.boolean().optional(),
});

/**
 * Output format support.
 */
export const OutputCapabilitiesSchema = z.object({
  structuredOutput: z.boolean().optional(),
  supportedMimeTypes: z.array(z.string()).optional(),
});

/**
 * State and memory management capabilities.
 */
export const StateCapabilitiesSchema = z.object({
  snapshots: z.boolean().optional(),
  deltas: z.boolean().optional(),
  memory: z.boolean().optional(),
  persistentState: z.boolean().optional(),
});

/**
 * Multi-agent coordination capabilities.
 */
export const MultiAgentCapabilitiesSchema = z.object({
  supported: z.boolean().optional(),
  delegation: z.boolean().optional(),
  handoffs: z.boolean().optional(),
  subAgents: z.array(SubAgentInfoSchema).optional(),
});

/**
 * Reasoning and thinking capabilities.
 */
export const ReasoningCapabilitiesSchema = z.object({
  supported: z.boolean().optional(),
  streaming: z.boolean().optional(),
  encrypted: z.boolean().optional(),
});

/**
 * Modalities the agent can accept as input.
 */
export const MultimodalInputCapabilitiesSchema = z.object({
  image: z.boolean().optional(),
  audio: z.boolean().optional(),
  video: z.boolean().optional(),
  pdf: z.boolean().optional(),
  file: z.boolean().optional(),
});

/**
 * Modalities the agent can produce as output.
 */
export const MultimodalOutputCapabilitiesSchema = z.object({
  image: z.boolean().optional(),
  audio: z.boolean().optional(),
});

/**
 * Multimodal input and output support.
 */
export const MultimodalCapabilitiesSchema = z.object({
  input: MultimodalInputCapabilitiesSchema.optional(),
  output: MultimodalOutputCapabilitiesSchema.optional(),
});

/**
 * Execution control and limits.
 */
export const ExecutionCapabilitiesSchema = z.object({
  codeExecution: z.boolean().optional(),
  sandboxed: z.boolean().optional(),
  maxIterations: z.number().optional(),
  maxExecutionTime: z.number().optional(),
});

/**
 * Human-in-the-loop interaction support.
 */
export const HumanInTheLoopCapabilitiesSchema = z.object({
  supported: z.boolean().optional(),
  approvals: z.boolean().optional(),
  interventions: z.boolean().optional(),
  feedback: z.boolean().optional(),
  interrupts: z.boolean().optional(),
  approveWithEdits: z.boolean().optional(),
});

/**
 * A typed, categorized snapshot of an agent's current capabilities.
 * Returned by `getCapabilities()` on `AbstractAgent`.
 */
export const AgentCapabilitiesSchema = z.object({
  identity: IdentityCapabilitiesSchema.optional(),
  transport: TransportCapabilitiesSchema.optional(),
  tools: ToolsCapabilitiesSchema.optional(),
  output: OutputCapabilitiesSchema.optional(),
  state: StateCapabilitiesSchema.optional(),
  multiAgent: MultiAgentCapabilitiesSchema.optional(),
  reasoning: ReasoningCapabilitiesSchema.optional(),
  multimodal: MultimodalCapabilitiesSchema.optional(),
  execution: ExecutionCapabilitiesSchema.optional(),
  humanInTheLoop: HumanInTheLoopCapabilitiesSchema.optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
