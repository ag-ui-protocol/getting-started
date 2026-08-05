import { z } from "zod";
import { MessageSchema, StateSchema, RunAgentInputSchema, InterruptSchema } from "./types";

// Text messages can have any role except "tool"
const TextMessageRoleSchema = z.union([
  z.literal("developer"),
  z.literal("system"),
  z.literal("assistant"),
  z.literal("user"),
]);

export enum EventType {
  TEXT_MESSAGE_START = "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END = "TEXT_MESSAGE_END",
  TEXT_MESSAGE_CHUNK = "TEXT_MESSAGE_CHUNK",
  TOOL_CALL_START = "TOOL_CALL_START",
  TOOL_CALL_ARGS = "TOOL_CALL_ARGS",
  TOOL_CALL_END = "TOOL_CALL_END",
  TOOL_CALL_CHUNK = "TOOL_CALL_CHUNK",
  TOOL_CALL_RESULT = "TOOL_CALL_RESULT",
  /**
   * @deprecated Use REASONING_START instead. Will be removed in 1.0.0.
   */
  THINKING_START = "THINKING_START",
  /**
   * @deprecated Use REASONING_END instead. Will be removed in 1.0.0.
   */
  THINKING_END = "THINKING_END",
  /**
   * @deprecated Use REASONING_MESSAGE_START instead. Will be removed in 1.0.0.
   */
  THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START",
  /**
   * @deprecated Use REASONING_MESSAGE_CONTENT instead. Will be removed in 1.0.0.
   */
  THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT",
  /**
   * @deprecated Use REASONING_MESSAGE_END instead. Will be removed in 1.0.0.
   */
  THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END",
  STATE_SNAPSHOT = "STATE_SNAPSHOT",
  STATE_DELTA = "STATE_DELTA",
  MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT",
  ACTIVITY_SNAPSHOT = "ACTIVITY_SNAPSHOT",
  ACTIVITY_DELTA = "ACTIVITY_DELTA",
  RAW = "RAW",
  CUSTOM = "CUSTOM",
  RUN_STARTED = "RUN_STARTED",
  RUN_FINISHED = "RUN_FINISHED",
  RUN_ERROR = "RUN_ERROR",
  STEP_STARTED = "STEP_STARTED",
  STEP_FINISHED = "STEP_FINISHED",
  REASONING_START = "REASONING_START",
  REASONING_MESSAGE_START = "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT = "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END = "REASONING_MESSAGE_END",
  REASONING_MESSAGE_CHUNK = "REASONING_MESSAGE_CHUNK",
  REASONING_END = "REASONING_END",
  REASONING_ENCRYPTED_VALUE = "REASONING_ENCRYPTED_VALUE",
}

export const BaseEventSchema = z
  .object({
    type: z.nativeEnum(EventType),
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
 * @deprecated Use ReasoningMessageStartEventSchema instead. Will be removed in 1.0.0.
 */
export const ThinkingTextMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.THINKING_TEXT_MESSAGE_START),
});

/**
 * @deprecated Use ReasoningMessageContentEventSchema instead. Will be removed in 1.0.0.
 */
export const ThinkingTextMessageContentEventSchema = TextMessageContentEventSchema.omit({
  messageId: true,
  type: true,
}).extend({
  type: z.literal(EventType.THINKING_TEXT_MESSAGE_CONTENT),
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
  // fields as JSON `null` (e.g. the .NET Microsoft Agent Framework adapter,
  // whose System.Text.Json emits `"parentMessageId": null`) still validate
  // instead of aborting the run on the first tool call.
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
  snapshot: StateSchema,
});

export const StateDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STATE_DELTA),
  delta: z.array(z.any()), // JSON Patch (RFC 6902)
});

export const MessagesSnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.MESSAGES_SNAPSHOT),
  messages: z.array(MessageSchema),
});

export const ActivitySnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ACTIVITY_SNAPSHOT),
  messageId: z.string(),
  activityType: z.string(),
  content: z.record(z.any()),
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
  event: z.any(),
  source: z.string().optional(),
});

export const CustomEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.CUSTOM),
  name: z.string(),
  value: z.any(),
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
  // Accept `null` and treat it as omitted, so producers like the Pydantic-based
  // Python SDK that serialize via `model_dump()` (without `exclude_none=True`)
  // and emit `"outcome": null` for the legacy no-outcome case still validate.
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

// Schema for the encrypted signature subtype
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

export type BaseEvent = z.infer<typeof BaseEventSchema>;
export type AGUIEvent = z.infer<typeof EventSchemas>;
export type BaseEventFields = z.infer<typeof BaseEventSchema>;
export type AGUIEventByType = {
  [EventType.TEXT_MESSAGE_START]: TextMessageStartEvent;
  [EventType.TEXT_MESSAGE_CONTENT]: TextMessageContentEvent;
  [EventType.TEXT_MESSAGE_END]: TextMessageEndEvent;
  [EventType.TEXT_MESSAGE_CHUNK]: TextMessageChunkEvent;
  [EventType.THINKING_TEXT_MESSAGE_START]: ThinkingTextMessageStartEvent;
  [EventType.THINKING_TEXT_MESSAGE_CONTENT]: ThinkingTextMessageContentEvent;
  [EventType.THINKING_TEXT_MESSAGE_END]: ThinkingTextMessageEndEvent;
  [EventType.TOOL_CALL_START]: ToolCallStartEvent;
  [EventType.TOOL_CALL_ARGS]: ToolCallArgsEvent;
  [EventType.TOOL_CALL_END]: ToolCallEndEvent;
  [EventType.TOOL_CALL_CHUNK]: ToolCallChunkEvent;
  [EventType.TOOL_CALL_RESULT]: ToolCallResultEvent;
  [EventType.THINKING_START]: ThinkingStartEvent;
  [EventType.THINKING_END]: ThinkingEndEvent;
  [EventType.STATE_SNAPSHOT]: StateSnapshotEvent;
  [EventType.STATE_DELTA]: StateDeltaEvent;
  [EventType.MESSAGES_SNAPSHOT]: MessagesSnapshotEvent;
  [EventType.ACTIVITY_SNAPSHOT]: ActivitySnapshotEvent;
  [EventType.ACTIVITY_DELTA]: ActivityDeltaEvent;
  [EventType.RAW]: RawEvent;
  [EventType.CUSTOM]: CustomEvent;
  [EventType.RUN_STARTED]: RunStartedEvent;
  [EventType.RUN_FINISHED]: RunFinishedEvent;
  [EventType.RUN_ERROR]: RunErrorEvent;
  [EventType.STEP_STARTED]: StepStartedEvent;
  [EventType.STEP_FINISHED]: StepFinishedEvent;
  [EventType.REASONING_START]: ReasoningStartEvent;
  [EventType.REASONING_MESSAGE_START]: ReasoningMessageStartEvent;
  [EventType.REASONING_MESSAGE_CONTENT]: ReasoningMessageContentEvent;
  [EventType.REASONING_MESSAGE_END]: ReasoningMessageEndEvent;
  [EventType.REASONING_MESSAGE_CHUNK]: ReasoningMessageChunkEvent;
  [EventType.REASONING_END]: ReasoningEndEvent;
  [EventType.REASONING_ENCRYPTED_VALUE]: ReasoningEncryptedValueEvent;
};
export type AGUIEventOf<T extends EventType> = AGUIEventByType[T];
export type EventPayloadOf<T extends EventType> = Omit<AGUIEventOf<T>, keyof BaseEventFields>;

type EventProps<Schema extends z.ZodTypeAny> = Omit<z.input<Schema>, "type">;

export type BaseEventProps = EventProps<typeof BaseEventSchema>;

export type TextMessageStartEventProps = EventProps<typeof TextMessageStartEventSchema>;
export type TextMessageContentEventProps = EventProps<typeof TextMessageContentEventSchema>;
export type TextMessageEndEventProps = EventProps<typeof TextMessageEndEventSchema>;
export type TextMessageChunkEventProps = EventProps<typeof TextMessageChunkEventSchema>;
export type ThinkingTextMessageStartEventProps = EventProps<
  typeof ThinkingTextMessageStartEventSchema
>;
export type ThinkingTextMessageContentEventProps = EventProps<
  typeof ThinkingTextMessageContentEventSchema
>;
export type ThinkingTextMessageEndEventProps = EventProps<typeof ThinkingTextMessageEndEventSchema>;
export type ToolCallStartEventProps = EventProps<typeof ToolCallStartEventSchema>;
export type ToolCallArgsEventProps = EventProps<typeof ToolCallArgsEventSchema>;
export type ToolCallEndEventProps = EventProps<typeof ToolCallEndEventSchema>;
export type ToolCallChunkEventProps = EventProps<typeof ToolCallChunkEventSchema>;
export type ToolCallResultEventProps = EventProps<typeof ToolCallResultEventSchema>;
export type ThinkingStartEventProps = EventProps<typeof ThinkingStartEventSchema>;
export type ThinkingEndEventProps = EventProps<typeof ThinkingEndEventSchema>;
export type StateSnapshotEventProps = EventProps<typeof StateSnapshotEventSchema>;
export type StateDeltaEventProps = EventProps<typeof StateDeltaEventSchema>;
export type MessagesSnapshotEventProps = EventProps<typeof MessagesSnapshotEventSchema>;
export type ActivitySnapshotEventProps = EventProps<typeof ActivitySnapshotEventSchema>;
export type ActivityDeltaEventProps = EventProps<typeof ActivityDeltaEventSchema>;
export type RawEventProps = EventProps<typeof RawEventSchema>;
export type CustomEventProps = EventProps<typeof CustomEventSchema>;
export type RunStartedEventProps = EventProps<typeof RunStartedEventSchema>;
export type RunFinishedEventProps = EventProps<typeof RunFinishedEventSchema>;
export type RunErrorEventProps = EventProps<typeof RunErrorEventSchema>;
export type StepStartedEventProps = EventProps<typeof StepStartedEventSchema>;
export type StepFinishedEventProps = EventProps<typeof StepFinishedEventSchema>;
export type ReasoningStartEventProps = EventProps<typeof ReasoningStartEventSchema>;
export type ReasoningMessageStartEventProps = EventProps<typeof ReasoningMessageStartEventSchema>;
export type ReasoningMessageContentEventProps = EventProps<
  typeof ReasoningMessageContentEventSchema
>;
export type ReasoningMessageEndEventProps = EventProps<typeof ReasoningMessageEndEventSchema>;
export type ReasoningMessageChunkEventProps = EventProps<typeof ReasoningMessageChunkEventSchema>;
export type ReasoningEndEventProps = EventProps<typeof ReasoningEndEventSchema>;
export type ReasoningEncryptedValueEventProps = EventProps<
  typeof ReasoningEncryptedValueEventSchema
>;

export type TextMessageStartEvent = z.infer<typeof TextMessageStartEventSchema>;
export type TextMessageContentEvent = z.infer<typeof TextMessageContentEventSchema>;
export type TextMessageEndEvent = z.infer<typeof TextMessageEndEventSchema>;
export type TextMessageChunkEvent = z.infer<typeof TextMessageChunkEventSchema>;
export type ThinkingTextMessageStartEvent = z.infer<typeof ThinkingTextMessageStartEventSchema>;
export type ThinkingTextMessageContentEvent = z.infer<typeof ThinkingTextMessageContentEventSchema>;
export type ThinkingTextMessageEndEvent = z.infer<typeof ThinkingTextMessageEndEventSchema>;
export type ToolCallStartEvent = z.infer<typeof ToolCallStartEventSchema>;
export type ToolCallArgsEvent = z.infer<typeof ToolCallArgsEventSchema>;
export type ToolCallEndEvent = z.infer<typeof ToolCallEndEventSchema>;
export type ToolCallChunkEvent = z.infer<typeof ToolCallChunkEventSchema>;
export type ToolCallResultEvent = z.infer<typeof ToolCallResultEventSchema>;
export type ThinkingStartEvent = z.infer<typeof ThinkingStartEventSchema>;
export type ThinkingEndEvent = z.infer<typeof ThinkingEndEventSchema>;
export type StateSnapshotEvent = z.infer<typeof StateSnapshotEventSchema>;
export type StateDeltaEvent = z.infer<typeof StateDeltaEventSchema>;
export type MessagesSnapshotEvent = z.infer<typeof MessagesSnapshotEventSchema>;
export type ActivitySnapshotEvent = z.infer<typeof ActivitySnapshotEventSchema>;
export type ActivityDeltaEvent = z.infer<typeof ActivityDeltaEventSchema>;
export type RawEvent = z.infer<typeof RawEventSchema>;
export type CustomEvent = z.infer<typeof CustomEventSchema>;
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type RunFinishedEvent = z.infer<typeof RunFinishedEventSchema>;
export type RunFinishedOutcome = z.infer<typeof RunFinishedOutcomeSchema>;
export type RunFinishedSuccessOutcome = z.infer<typeof RunFinishedSuccessOutcomeSchema>;
export type RunFinishedInterruptOutcome = z.infer<typeof RunFinishedInterruptOutcomeSchema>;
export type RunErrorEvent = z.infer<typeof RunErrorEventSchema>;
export type StepStartedEvent = z.infer<typeof StepStartedEventSchema>;
export type StepFinishedEvent = z.infer<typeof StepFinishedEventSchema>;
export type ReasoningStartEvent = z.infer<typeof ReasoningStartEventSchema>;
export type ReasoningMessageStartEvent = z.infer<typeof ReasoningMessageStartEventSchema>;
export type ReasoningMessageContentEvent = z.infer<typeof ReasoningMessageContentEventSchema>;
export type ReasoningMessageEndEvent = z.infer<typeof ReasoningMessageEndEventSchema>;
export type ReasoningMessageChunkEvent = z.infer<typeof ReasoningMessageChunkEventSchema>;
export type ReasoningEndEvent = z.infer<typeof ReasoningEndEventSchema>;
export type ReasoningEncryptedValueEvent = z.infer<typeof ReasoningEncryptedValueEventSchema>;
export type ReasoningEncryptedValueSubtype = z.infer<typeof ReasoningEncryptedValueSubtypeSchema>;
