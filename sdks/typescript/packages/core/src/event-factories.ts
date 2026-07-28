// Validating event factories. This module is part of the `@ag-ui/core/schemas`
// subpath, NOT the main `@ag-ui/core` entry — it needs zod to run each event
// through its schema, and the main entry is deliberately dependency-free.
//
// Every factory validates its input via `schema.parse(...)`, so invalid payloads
// fail at construction time in the producer rather than surfacing later as a
// stream error in the consumer. Parsing also applies the schemas' `.default(...)`
// values (`role` -> "assistant", `replace` -> true) and `.transform(...)`
// normalizations (`parentMessageId` / `outcome` `null` -> omitted).

import { z } from "zod/v4";
import { EventType } from "./events";
import type {
  ActivityDeltaEvent,
  ActivityDeltaEventProps,
  ActivitySnapshotEvent,
  ActivitySnapshotEventProps,
  CustomEvent,
  CustomEventProps,
  MessagesSnapshotEvent,
  MessagesSnapshotEventProps,
  RawEvent,
  RawEventProps,
  ReasoningEncryptedValueEvent,
  ReasoningEncryptedValueEventProps,
  ReasoningEndEvent,
  ReasoningEndEventProps,
  ReasoningMessageChunkEvent,
  ReasoningMessageChunkEventProps,
  ReasoningMessageContentEvent,
  ReasoningMessageContentEventProps,
  ReasoningMessageEndEvent,
  ReasoningMessageEndEventProps,
  ReasoningMessageStartEvent,
  ReasoningMessageStartEventProps,
  ReasoningStartEvent,
  ReasoningStartEventProps,
  RunErrorEvent,
  RunErrorEventProps,
  RunFinishedEvent,
  RunFinishedEventProps,
  RunStartedEvent,
  RunStartedEventProps,
  StateDeltaEvent,
  StateDeltaEventProps,
  StateSnapshotEvent,
  StateSnapshotEventProps,
  StepFinishedEvent,
  StepFinishedEventProps,
  StepStartedEvent,
  StepStartedEventProps,
  TextMessageChunkEvent,
  TextMessageChunkEventProps,
  TextMessageContentEvent,
  TextMessageContentEventProps,
  TextMessageEndEvent,
  TextMessageEndEventProps,
  TextMessageStartEvent,
  TextMessageStartEventProps,
  ThinkingEndEvent,
  ThinkingEndEventProps,
  ThinkingStartEvent,
  ThinkingStartEventProps,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageContentEventProps,
  ThinkingTextMessageEndEvent,
  ThinkingTextMessageEndEventProps,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageStartEventProps,
  ToolCallArgsEvent,
  ToolCallArgsEventProps,
  ToolCallChunkEvent,
  ToolCallChunkEventProps,
  ToolCallEndEvent,
  ToolCallEndEventProps,
  ToolCallResultEvent,
  ToolCallResultEventProps,
  ToolCallStartEvent,
  ToolCallStartEventProps,
} from "./events";
import type { Interrupt } from "./types";
import {
  ActivityDeltaEventSchema,
  ActivitySnapshotEventSchema,
  CustomEventSchema,
  MessagesSnapshotEventSchema,
  RawEventSchema,
  ReasoningEncryptedValueEventSchema,
  ReasoningEndEventSchema,
  ReasoningMessageChunkEventSchema,
  ReasoningMessageContentEventSchema,
  ReasoningMessageEndEventSchema,
  ReasoningMessageStartEventSchema,
  ReasoningStartEventSchema,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
  StateDeltaEventSchema,
  StateSnapshotEventSchema,
  StepFinishedEventSchema,
  StepStartedEventSchema,
  TextMessageChunkEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageStartEventSchema,
  ThinkingEndEventSchema,
  ThinkingStartEventSchema,
  ThinkingTextMessageContentEventSchema,
  ThinkingTextMessageEndEventSchema,
  ThinkingTextMessageStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallChunkEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema,
} from "./schemas";

// `type` is assigned AFTER spreading props, so a caller cannot override the
// discriminant. `BaseEvent`'s `[k: string]: unknown` index signature means
// `Omit<Event, "type">` alone does not reject a `type` key — the `EventProps<E>`
// helper in events.ts adds `type?: never` to catch it at compile time, and this
// ordering makes it safe at runtime too.
const buildEvent = <Schema extends z.ZodTypeAny>(
  eventType: EventType,
  schema: Schema,
  props: Omit<z.input<Schema>, "type">,
): z.infer<Schema> =>
  schema.parse({
    ...props,
    type: eventType,
  });

/** Creates a TEXT_MESSAGE_START event. `role` defaults to `"assistant"` when omitted. */
export const createTextMessageStartEvent = (
  props: TextMessageStartEventProps,
): TextMessageStartEvent =>
  buildEvent(EventType.TEXT_MESSAGE_START, TextMessageStartEventSchema, props);

/** Creates a TEXT_MESSAGE_CONTENT event. */
export const createTextMessageContentEvent = (
  props: TextMessageContentEventProps,
): TextMessageContentEvent =>
  buildEvent(EventType.TEXT_MESSAGE_CONTENT, TextMessageContentEventSchema, props);

/** Creates a TEXT_MESSAGE_END event. */
export const createTextMessageEndEvent = (props: TextMessageEndEventProps): TextMessageEndEvent =>
  buildEvent(EventType.TEXT_MESSAGE_END, TextMessageEndEventSchema, props);

/** Creates a TEXT_MESSAGE_CHUNK event. */
export const createTextMessageChunkEvent = (
  props: TextMessageChunkEventProps,
): TextMessageChunkEvent =>
  buildEvent(EventType.TEXT_MESSAGE_CHUNK, TextMessageChunkEventSchema, props);

/** @deprecated Use `createReasoningMessageStartEvent` instead. Will be removed in 1.0.0. */
export const createThinkingTextMessageStartEvent = (
  props: ThinkingTextMessageStartEventProps,
): ThinkingTextMessageStartEvent =>
  buildEvent(EventType.THINKING_TEXT_MESSAGE_START, ThinkingTextMessageStartEventSchema, props);

/** @deprecated Use `createReasoningMessageContentEvent` instead. Will be removed in 1.0.0. */
export const createThinkingTextMessageContentEvent = (
  props: ThinkingTextMessageContentEventProps,
): ThinkingTextMessageContentEvent =>
  buildEvent(EventType.THINKING_TEXT_MESSAGE_CONTENT, ThinkingTextMessageContentEventSchema, props);

/** @deprecated Use `createReasoningMessageEndEvent` instead. Will be removed in 1.0.0. */
export const createThinkingTextMessageEndEvent = (
  props: ThinkingTextMessageEndEventProps,
): ThinkingTextMessageEndEvent =>
  buildEvent(EventType.THINKING_TEXT_MESSAGE_END, ThinkingTextMessageEndEventSchema, props);

/** Creates a TOOL_CALL_START event. */
export const createToolCallStartEvent = (props: ToolCallStartEventProps): ToolCallStartEvent =>
  buildEvent(EventType.TOOL_CALL_START, ToolCallStartEventSchema, props);

/** Creates a TOOL_CALL_ARGS event. */
export const createToolCallArgsEvent = (props: ToolCallArgsEventProps): ToolCallArgsEvent =>
  buildEvent(EventType.TOOL_CALL_ARGS, ToolCallArgsEventSchema, props);

/** Creates a TOOL_CALL_END event. */
export const createToolCallEndEvent = (props: ToolCallEndEventProps): ToolCallEndEvent =>
  buildEvent(EventType.TOOL_CALL_END, ToolCallEndEventSchema, props);

/** Creates a TOOL_CALL_CHUNK event. */
export const createToolCallChunkEvent = (props: ToolCallChunkEventProps): ToolCallChunkEvent =>
  buildEvent(EventType.TOOL_CALL_CHUNK, ToolCallChunkEventSchema, props);

/** Creates a TOOL_CALL_RESULT event. */
export const createToolCallResultEvent = (props: ToolCallResultEventProps): ToolCallResultEvent =>
  buildEvent(EventType.TOOL_CALL_RESULT, ToolCallResultEventSchema, props);

/** @deprecated Use `createReasoningStartEvent` instead. Will be removed in 1.0.0. */
export const createThinkingStartEvent = (props: ThinkingStartEventProps): ThinkingStartEvent =>
  buildEvent(EventType.THINKING_START, ThinkingStartEventSchema, props);

/** @deprecated Use `createReasoningEndEvent` instead. Will be removed in 1.0.0. */
export const createThinkingEndEvent = (props: ThinkingEndEventProps): ThinkingEndEvent =>
  buildEvent(EventType.THINKING_END, ThinkingEndEventSchema, props);

/** Creates a STATE_SNAPSHOT event. */
export const createStateSnapshotEvent = (props: StateSnapshotEventProps): StateSnapshotEvent =>
  buildEvent(EventType.STATE_SNAPSHOT, StateSnapshotEventSchema, props);

/** Creates a STATE_DELTA event. */
export const createStateDeltaEvent = (props: StateDeltaEventProps): StateDeltaEvent =>
  buildEvent(EventType.STATE_DELTA, StateDeltaEventSchema, props);

/** Creates a MESSAGES_SNAPSHOT event. */
export const createMessagesSnapshotEvent = (
  props: MessagesSnapshotEventProps,
): MessagesSnapshotEvent =>
  buildEvent(EventType.MESSAGES_SNAPSHOT, MessagesSnapshotEventSchema, props);

/** Creates an ACTIVITY_SNAPSHOT event. `replace` defaults to `true` when omitted. */
export const createActivitySnapshotEvent = (
  props: ActivitySnapshotEventProps,
): ActivitySnapshotEvent =>
  buildEvent(EventType.ACTIVITY_SNAPSHOT, ActivitySnapshotEventSchema, props);

/** Creates an ACTIVITY_DELTA event. */
export const createActivityDeltaEvent = (props: ActivityDeltaEventProps): ActivityDeltaEvent =>
  buildEvent(EventType.ACTIVITY_DELTA, ActivityDeltaEventSchema, props);

/** Creates a RAW event. */
export const createRawEvent = (props: RawEventProps): RawEvent =>
  buildEvent(EventType.RAW, RawEventSchema, props);

/** Creates a CUSTOM event. */
export const createCustomEvent = (props: CustomEventProps): CustomEvent =>
  buildEvent(EventType.CUSTOM, CustomEventSchema, props);

/** Creates a RUN_STARTED event. */
export const createRunStartedEvent = (props: RunStartedEventProps): RunStartedEvent =>
  buildEvent(EventType.RUN_STARTED, RunStartedEventSchema, props);

/**
 * Creates a RUN_FINISHED event.
 *
 * `outcome` is optional. Omit it for legacy/back-compat behavior, or set it
 * explicitly to `{ type: "success" }` or `{ type: "interrupt", interrupts }` —
 * see `createRunFinishedSuccessEvent` and `createRunFinishedInterruptEvent` for
 * convenience helpers. `outcome: null` is normalized to `outcome` being omitted.
 */
export const createRunFinishedEvent = (props: RunFinishedEventProps): RunFinishedEvent =>
  buildEvent(EventType.RUN_FINISHED, RunFinishedEventSchema, props);

/** Creates a RUN_FINISHED event with `outcome: { type: "success" }`. */
export const createRunFinishedSuccessEvent = (
  props: Omit<RunFinishedEventProps, "outcome">,
): RunFinishedEvent =>
  buildEvent(EventType.RUN_FINISHED, RunFinishedEventSchema, {
    ...props,
    outcome: { type: "success" },
  });

/**
 * Creates a RUN_FINISHED event with `outcome: { type: "interrupt", interrupts }`.
 * Throws if `interrupts` is empty (the schema requires at least one entry).
 */
export const createRunFinishedInterruptEvent = (
  props: Omit<RunFinishedEventProps, "outcome"> & { interrupts: Interrupt[] },
): RunFinishedEvent => {
  const { interrupts, ...rest } = props;
  return buildEvent(EventType.RUN_FINISHED, RunFinishedEventSchema, {
    ...rest,
    outcome: { type: "interrupt", interrupts },
  });
};

/** Creates a RUN_ERROR event. */
export const createRunErrorEvent = (props: RunErrorEventProps): RunErrorEvent =>
  buildEvent(EventType.RUN_ERROR, RunErrorEventSchema, props);

/** Creates a STEP_STARTED event. */
export const createStepStartedEvent = (props: StepStartedEventProps): StepStartedEvent =>
  buildEvent(EventType.STEP_STARTED, StepStartedEventSchema, props);

/** Creates a STEP_FINISHED event. */
export const createStepFinishedEvent = (props: StepFinishedEventProps): StepFinishedEvent =>
  buildEvent(EventType.STEP_FINISHED, StepFinishedEventSchema, props);

/** Creates a REASONING_START event. */
export const createReasoningStartEvent = (props: ReasoningStartEventProps): ReasoningStartEvent =>
  buildEvent(EventType.REASONING_START, ReasoningStartEventSchema, props);

/** Creates a REASONING_MESSAGE_START event. */
export const createReasoningMessageStartEvent = (
  props: ReasoningMessageStartEventProps,
): ReasoningMessageStartEvent =>
  buildEvent(EventType.REASONING_MESSAGE_START, ReasoningMessageStartEventSchema, props);

/** Creates a REASONING_MESSAGE_CONTENT event. */
export const createReasoningMessageContentEvent = (
  props: ReasoningMessageContentEventProps,
): ReasoningMessageContentEvent =>
  buildEvent(EventType.REASONING_MESSAGE_CONTENT, ReasoningMessageContentEventSchema, props);

/** Creates a REASONING_MESSAGE_END event. */
export const createReasoningMessageEndEvent = (
  props: ReasoningMessageEndEventProps,
): ReasoningMessageEndEvent =>
  buildEvent(EventType.REASONING_MESSAGE_END, ReasoningMessageEndEventSchema, props);

/** Creates a REASONING_MESSAGE_CHUNK event. */
export const createReasoningMessageChunkEvent = (
  props: ReasoningMessageChunkEventProps,
): ReasoningMessageChunkEvent =>
  buildEvent(EventType.REASONING_MESSAGE_CHUNK, ReasoningMessageChunkEventSchema, props);

/** Creates a REASONING_END event. */
export const createReasoningEndEvent = (props: ReasoningEndEventProps): ReasoningEndEvent =>
  buildEvent(EventType.REASONING_END, ReasoningEndEventSchema, props);

/** Creates a REASONING_ENCRYPTED_VALUE event. */
export const createReasoningEncryptedValueEvent = (
  props: ReasoningEncryptedValueEventProps,
): ReasoningEncryptedValueEvent =>
  buildEvent(EventType.REASONING_ENCRYPTED_VALUE, ReasoningEncryptedValueEventSchema, props);
