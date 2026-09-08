import { z } from "zod";
import { MessageSchema, StateSchema, RunAgentInputSchema, InterruptSchema } from "./types";
import { OptionalMetadataSchema } from "./metadata";

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
  SUBAGENT_STARTED = "SUBAGENT_STARTED",
  SUBAGENT_FINISHED = "SUBAGENT_FINISHED",
  SUBAGENT_ERROR = "SUBAGENT_ERROR",
}

export const BaseEventSchema = z
  .object({
    type: z.nativeEnum(EventType),
    timestamp: z.number().optional(),
    rawEvent: z.any().optional(),
    // Declared once here so every event type carries it. See
    // OptionalMetadataSchema for why an explicit null is rejected rather than
    // tolerated the way parentMessageId and outcome are.
    metadata: OptionalMetadataSchema,
  })
  .passthrough();

export const TextMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_START),
  messageId: z.string(),
  role: TextMessageRoleSchema.default("assistant"),
  name: z.string().optional(),
  subagentRunId: z.string().optional(),
});

export const TextMessageContentEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_CONTENT),
  messageId: z.string(),
  delta: z.string(),
  subagentRunId: z.string().optional(),
});

export const TextMessageEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_END),
  messageId: z.string(),
  subagentRunId: z.string().optional(),
});

export const TextMessageChunkEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_CHUNK),
  messageId: z.string().optional(),
  role: TextMessageRoleSchema.optional(),
  delta: z.string().optional(),
  name: z.string().optional(),
  subagentRunId: z.string().optional(),
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
  // Not an attribution carrier: the deprecated THINKING_* family predates
  // subagents and is excluded from the attribution table — Python and .NET
  // declare no such field, and inheriting it here from the text schema made
  // TypeScript silently accept what the other SDKs reject.
  subagentRunId: true,
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
  subagentRunId: z.string().optional(),
});

export const ToolCallArgsEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_ARGS),
  toolCallId: z.string(),
  delta: z.string(),
  subagentRunId: z.string().optional(),
});

export const ToolCallEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_END),
  toolCallId: z.string(),
  subagentRunId: z.string().optional(),
});

export const ToolCallResultEventSchema = BaseEventSchema.extend({
  messageId: z.string(),
  type: z.literal(EventType.TOOL_CALL_RESULT),
  toolCallId: z.string(),
  content: z.string(),
  role: z.literal("tool").optional(),
  // The event-side twin of `ToolMessage.error`: set when the tool call failed,
  // so a consumer can render the failure from the live stream instead of
  // waiting for the MESSAGES_SNAPSHOT that carries the message. A failure is
  // reported when `error` is a string, `""` included — a producer that sends
  // the empty string chose to send it. An absent `error` reports nothing about
  // failure, which is not the same as the call having succeeded.
  //
  // Typing it narrows the wire rather than purely extending it: BaseEventSchema
  // is `.passthrough()`, so an `error` of any other shape — an object, an
  // explicit null — used to survive parsing as an unrecognized key and now
  // fails it. That is the intended no-null-tolerance reading for new fields
  // (see the note above SubagentStartedEventSchema), but it does tighten what
  // an existing stream may carry under this key.
  error: z.string().optional(),
  subagentRunId: z.string().optional(),
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
  subagentRunId: z.string().optional(),
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
  subagentRunId: z.string().optional(),
});

export const StateDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STATE_DELTA),
  delta: z.array(z.any()), // JSON Patch (RFC 6902)
  subagentRunId: z.string().optional(),
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
  subagentRunId: z.string().optional(),
});

export const ActivityDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.ACTIVITY_DELTA),
  messageId: z.string(),
  activityType: z.string(),
  patch: z.array(z.any()),
  subagentRunId: z.string().optional(),
});

export const RawEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RAW),
  event: z.any(),
  source: z.string().optional(),
  subagentRunId: z.string().optional(),
});

export const CustomEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.CUSTOM),
  name: z.string(),
  value: z.any(),
  subagentRunId: z.string().optional(),
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

// Reusable, numeric-only token usage summary. Deliberately carries no
// content-bearing or identifying fields (no prompts, completions, messages,
// thread/run/user IDs) — only provider/model labels and numeric token counts.
// Unknown keys are stripped on parse, so content cannot ride along.
export const TokenUsageSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  // Counts are non-negative integers in every representation: proto `int64`,
  // C# `long?`, Python `int`. Constraining them here keeps TypeScript from
  // admitting values the other bindings cannot encode — `proto.encode` parses
  // against this schema and then writes via an int64 writer that throws on a
  // non-integer, so an unconstrained `z.number()` turns a bad producer value
  // into a mid-stream crash on the protobuf transport instead of a validation
  // error at the source.
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
});

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
  // Optional per-(provider, model) token usage for the completed run. An array
  // so runs that invoke multiple models keep them separate for downstream
  // display; consumers that only need totals can sum across entries. Must be
  // declared here (not relied upon via passthrough) so it survives the
  // `EventSchemas` discriminated-union parse.
  usage: z.array(TokenUsageSchema).optional(),
});

export const RunErrorEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_ERROR),
  message: z.string(),
  code: z.string().optional(),
  // Optional partial usage for a run that failed after one or more model calls
  // completed. Same numeric-only shape as RUN_FINISHED.
  usage: z.array(TokenUsageSchema).optional(),
});

export const StepStartedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STEP_STARTED),
  stepName: z.string(),
  subagentRunId: z.string().optional(),
});

export const StepFinishedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STEP_FINISHED),
  stepName: z.string(),
  subagentRunId: z.string().optional(),
});

// Schema for the encrypted signature subtype
export const ReasoningEncryptedValueSubtypeSchema = z.union([
  z.literal("tool-call"),
  z.literal("message"),
]);

export const ReasoningStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_START),
  messageId: z.string(),
  subagentRunId: z.string().optional(),
});

export const ReasoningMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_START),
  messageId: z.string(),
  role: z.literal("reasoning"),
  subagentRunId: z.string().optional(),
});

export const ReasoningMessageContentEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_CONTENT),
  messageId: z.string(),
  delta: z.string(),
  subagentRunId: z.string().optional(),
});

export const ReasoningMessageEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_END),
  messageId: z.string(),
  subagentRunId: z.string().optional(),
});

export const ReasoningMessageChunkEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_MESSAGE_CHUNK),
  messageId: z.string().optional(),
  delta: z.string().optional(),
  subagentRunId: z.string().optional(),
});

export const ReasoningEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_END),
  messageId: z.string(),
  subagentRunId: z.string().optional(),
});

export const ReasoningEncryptedValueEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.REASONING_ENCRYPTED_VALUE),
  subtype: ReasoningEncryptedValueSubtypeSchema,
  entityId: z.string(),
  encryptedValue: z.string(),
  subagentRunId: z.string().optional(),
});

// No null tolerance anywhere on the subagent surface: these fields are new with
// this PR, so no producer has ever legally written `null` for them — since
// PNI-199 the Python and .NET SDKs omit valueless fields at the source, and the
// three legacy tolerances (TOOL_CALL_START/CHUNK.parentMessageId,
// RUN_FINISHED.outcome) stay a closed set awaiting their middleware shim
// (PNI-207). Absent is the only spelling; an explicit null fails the parse,
// exactly like `metadata`.

export const SubagentStartedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.SUBAGENT_STARTED),
  subagentRunId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  parentSubagentRunId: z.string().optional(),
  // Link back to the tool call (and the message that held it) that spawned this
  // subagent, for the agents-as-tools pattern (e.g. deepagents `task`). Lets a
  // consumer correlate the subagent to its spawning call without inspecting
  // rawEvent.metadata.
  parentToolCallId: z.string().optional(),
  parentMessageId: z.string().optional(),
});

export const SubagentFinishedSuccessOutcomeSchema = z
  .object({
    type: z.literal("success"),
  })
  .strict();

export const SubagentFinishedSuspendedOutcomeSchema = z
  .object({
    type: z.literal("suspended"),
    // The ids of the run-level interrupts this subagent directly owns (see
    // Interrupt.subagentRunId). MAY be empty or omitted: an ancestor subagent
    // suspended because a DESCENDANT interrupted owns no interrupt itself.
    interruptIds: z.array(z.string()).optional(),
  })
  .strict();

// Mirrors RunFinishedOutcome one level down: a subagent's terminal closes its
// stream segment for THIS run either because the work completed ("success")
// or because the workflow is paused awaiting outside input ("suspended" — the
// run ends with an interrupt outcome, and on resume the same subagentRunId is
// re-announced as a continuation of the suspended invocation). An omitted
// outcome means legacy success. Without this, a paused subagent was
// indistinguishable from a completed one and every UI had to reverse-engineer
// "waiting" from a later interrupt event.
export const SubagentFinishedOutcomeSchema = z.discriminatedUnion("type", [
  SubagentFinishedSuccessOutcomeSchema,
  SubagentFinishedSuspendedOutcomeSchema,
]);

export const SubagentFinishedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.SUBAGENT_FINISHED),
  subagentRunId: z.string(),
  // The subagent's completion payload, mirroring RUN_FINISHED.result.
  result: z.any().optional(),
  // Strictly optional: absent means success (the legacy reading); an explicit
  // null is rejected. RUN_FINISHED.outcome's null tolerance is legacy debt from
  // producers that shipped before PNI-199 — this field is newer than the fix,
  // so it never inherits the debt.
  outcome: SubagentFinishedOutcomeSchema.optional(),
});

export const SubagentErrorEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.SUBAGENT_ERROR),
  subagentRunId: z.string(),
  message: z.string(),
  code: z.string().optional(),
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
  SubagentStartedEventSchema,
  SubagentFinishedEventSchema,
  SubagentErrorEventSchema,
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
  [EventType.SUBAGENT_STARTED]: SubagentStartedEvent;
  [EventType.SUBAGENT_FINISHED]: SubagentFinishedEvent;
  [EventType.SUBAGENT_ERROR]: SubagentErrorEvent;
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
export type SubagentStartedEventProps = EventProps<typeof SubagentStartedEventSchema>;
export type SubagentFinishedEventProps = EventProps<typeof SubagentFinishedEventSchema>;
export type SubagentErrorEventProps = EventProps<typeof SubagentErrorEventSchema>;

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
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type RunFinishedOutcome = z.infer<typeof RunFinishedOutcomeSchema>;
export type RunFinishedSuccessOutcome = z.infer<typeof RunFinishedSuccessOutcomeSchema>;
export type RunFinishedInterruptOutcome = z.infer<typeof RunFinishedInterruptOutcomeSchema>;
export type SubagentFinishedOutcome = z.infer<typeof SubagentFinishedOutcomeSchema>;
export type SubagentFinishedSuccessOutcome = z.infer<typeof SubagentFinishedSuccessOutcomeSchema>;
export type SubagentFinishedSuspendedOutcome = z.infer<typeof SubagentFinishedSuspendedOutcomeSchema>;
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
export type SubagentStartedEvent = z.infer<typeof SubagentStartedEventSchema>;
export type SubagentFinishedEvent = z.infer<typeof SubagentFinishedEventSchema>;
export type SubagentErrorEvent = z.infer<typeof SubagentErrorEventSchema>;
