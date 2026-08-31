import { z } from "zod";
import type { Interrupt } from "./types";
import {
  ActivityDeltaEvent,
  ActivityDeltaEventProps,
  ActivityDeltaEventSchema,
  ActivitySnapshotEvent,
  ActivitySnapshotEventProps,
  ActivitySnapshotEventSchema,
  CustomEvent,
  CustomEventProps,
  CustomEventSchema,
  EventType,
  MessagesSnapshotEvent,
  MessagesSnapshotEventProps,
  MessagesSnapshotEventSchema,
  RawEvent,
  RawEventProps,
  RawEventSchema,
  RunErrorEvent,
  RunErrorEventProps,
  RunErrorEventSchema,
  RunFinishedEvent,
  RunFinishedEventProps,
  RunFinishedEventSchema,
  RunStartedEvent,
  RunStartedEventProps,
  RunStartedEventSchema,
  StateDeltaEvent,
  StateDeltaEventProps,
  StateDeltaEventSchema,
  StateSnapshotEvent,
  StateSnapshotEventProps,
  StateSnapshotEventSchema,
  StepFinishedEvent,
  StepFinishedEventProps,
  StepFinishedEventSchema,
  StepStartedEvent,
  StepStartedEventProps,
  StepStartedEventSchema,
  TextMessageChunkEvent,
  TextMessageChunkEventProps,
  TextMessageChunkEventSchema,
  TextMessageContentEvent,
  TextMessageContentEventProps,
  TextMessageContentEventSchema,
  TextMessageEndEvent,
  TextMessageEndEventProps,
  TextMessageEndEventSchema,
  TextMessageStartEvent,
  TextMessageStartEventProps,
  TextMessageStartEventSchema,
  ThinkingEndEvent,
  ThinkingEndEventProps,
  ThinkingEndEventSchema,
  ThinkingStartEvent,
  ThinkingStartEventProps,
  ThinkingStartEventSchema,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageContentEventProps,
  ThinkingTextMessageContentEventSchema,
  ThinkingTextMessageEndEvent,
  ThinkingTextMessageEndEventProps,
  ThinkingTextMessageEndEventSchema,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageStartEventProps,
  ThinkingTextMessageStartEventSchema,
  ToolCallArgsEvent,
  ToolCallArgsEventProps,
  ToolCallArgsEventSchema,
  ToolCallChunkEvent,
  ToolCallChunkEventProps,
  ToolCallChunkEventSchema,
  ToolCallEndEvent,
  ToolCallEndEventProps,
  ToolCallEndEventSchema,
  ToolCallResultEvent,
  ToolCallResultEventProps,
  ToolCallResultEventSchema,
  ToolCallStartEvent,
  ToolCallStartEventProps,
  ToolCallStartEventSchema,
  ReasoningStartEvent,
  ReasoningStartEventProps,
  ReasoningStartEventSchema,
  ReasoningMessageStartEvent,
  ReasoningMessageStartEventProps,
  ReasoningMessageStartEventSchema,
  ReasoningMessageContentEvent,
  ReasoningMessageContentEventProps,
  ReasoningMessageContentEventSchema,
  ReasoningMessageEndEvent,
  ReasoningMessageEndEventProps,
  ReasoningMessageEndEventSchema,
  ReasoningMessageChunkEvent,
  ReasoningMessageChunkEventProps,
  ReasoningMessageChunkEventSchema,
  ReasoningEndEvent,
  ReasoningEndEventProps,
  ReasoningEndEventSchema,
  ReasoningEncryptedValueEvent,
  ReasoningEncryptedValueEventProps,
  ReasoningEncryptedValueEventSchema,
  SubagentStartedEvent,
  SubagentStartedEventProps,
  SubagentStartedEventSchema,
  SubagentFinishedEvent,
  SubagentFinishedEventProps,
  SubagentFinishedEventSchema,
  SubagentErrorEvent,
  SubagentErrorEventProps,
  SubagentErrorEventSchema,
} from "./events";

const buildEvent = <Schema extends z.ZodTypeAny>(
  eventType: EventType,
  schema: Schema,
  props: Omit<z.input<Schema>, "type">,
): z.infer<Schema> =>
  schema.parse({
    type: eventType,
    ...props,
  });

/**
 * Creates a TEXT_MESSAGE_START event.
 */
export const createTextMessageStartEvent = (
  props: TextMessageStartEventProps,
): TextMessageStartEvent =>
  buildEvent(EventType.TEXT_MESSAGE_START, TextMessageStartEventSchema, props);

/**
 * Creates a TEXT_MESSAGE_CONTENT event.
 */
export const createTextMessageContentEvent = (
  props: TextMessageContentEventProps,
): TextMessageContentEvent =>
  buildEvent(EventType.TEXT_MESSAGE_CONTENT, TextMessageContentEventSchema, props);

/**
 * Creates a TEXT_MESSAGE_END event.
 */
export const createTextMessageEndEvent = (props: TextMessageEndEventProps): TextMessageEndEvent =>
  buildEvent(EventType.TEXT_MESSAGE_END, TextMessageEndEventSchema, props);

/**
 * Creates a TEXT_MESSAGE_CHUNK event.
 */
export const createTextMessageChunkEvent = (
  props: TextMessageChunkEventProps,
): TextMessageChunkEvent =>
  buildEvent(EventType.TEXT_MESSAGE_CHUNK, TextMessageChunkEventSchema, props);

/**
 * Creates a THINKING_TEXT_MESSAGE_START event.
 */
export const createThinkingTextMessageStartEvent = (
  props: ThinkingTextMessageStartEventProps,
): ThinkingTextMessageStartEvent =>
  buildEvent(EventType.THINKING_TEXT_MESSAGE_START, ThinkingTextMessageStartEventSchema, props);

/**
 * Creates a THINKING_TEXT_MESSAGE_CONTENT event.
 */
export const createThinkingTextMessageContentEvent = (
  props: ThinkingTextMessageContentEventProps,
): ThinkingTextMessageContentEvent =>
  buildEvent(EventType.THINKING_TEXT_MESSAGE_CONTENT, ThinkingTextMessageContentEventSchema, props);

/**
 * Creates a THINKING_TEXT_MESSAGE_END event.
 */
export const createThinkingTextMessageEndEvent = (
  props: ThinkingTextMessageEndEventProps,
): ThinkingTextMessageEndEvent =>
  buildEvent(EventType.THINKING_TEXT_MESSAGE_END, ThinkingTextMessageEndEventSchema, props);

/**
 * Creates a TOOL_CALL_START event.
 */
export const createToolCallStartEvent = (props: ToolCallStartEventProps): ToolCallStartEvent =>
  buildEvent(EventType.TOOL_CALL_START, ToolCallStartEventSchema, props);

/**
 * Creates a TOOL_CALL_ARGS event.
 */
export const createToolCallArgsEvent = (props: ToolCallArgsEventProps): ToolCallArgsEvent =>
  buildEvent(EventType.TOOL_CALL_ARGS, ToolCallArgsEventSchema, props);

/**
 * Creates a TOOL_CALL_END event.
 */
export const createToolCallEndEvent = (props: ToolCallEndEventProps): ToolCallEndEvent =>
  buildEvent(EventType.TOOL_CALL_END, ToolCallEndEventSchema, props);

/**
 * Creates a TOOL_CALL_CHUNK event.
 */
export const createToolCallChunkEvent = (props: ToolCallChunkEventProps): ToolCallChunkEvent =>
  buildEvent(EventType.TOOL_CALL_CHUNK, ToolCallChunkEventSchema, props);

/**
 * Creates a TOOL_CALL_RESULT event.
 */
export const createToolCallResultEvent = (props: ToolCallResultEventProps): ToolCallResultEvent =>
  buildEvent(EventType.TOOL_CALL_RESULT, ToolCallResultEventSchema, props);

/**
 * Creates a THINKING_START event.
 */
export const createThinkingStartEvent = (props: ThinkingStartEventProps): ThinkingStartEvent =>
  buildEvent(EventType.THINKING_START, ThinkingStartEventSchema, props);

/**
 * Creates a THINKING_END event.
 */
export const createThinkingEndEvent = (props: ThinkingEndEventProps): ThinkingEndEvent =>
  buildEvent(EventType.THINKING_END, ThinkingEndEventSchema, props);

/**
 * Creates a STATE_SNAPSHOT event.
 */
export const createStateSnapshotEvent = (props: StateSnapshotEventProps): StateSnapshotEvent =>
  buildEvent(EventType.STATE_SNAPSHOT, StateSnapshotEventSchema, props);

/**
 * Creates a STATE_DELTA event.
 */
export const createStateDeltaEvent = (props: StateDeltaEventProps): StateDeltaEvent =>
  buildEvent(EventType.STATE_DELTA, StateDeltaEventSchema, props);

/**
 * Creates a MESSAGES_SNAPSHOT event.
 */
export const createMessagesSnapshotEvent = (
  props: MessagesSnapshotEventProps,
): MessagesSnapshotEvent =>
  buildEvent(EventType.MESSAGES_SNAPSHOT, MessagesSnapshotEventSchema, props);

/**
 * Creates an ACTIVITY_SNAPSHOT event.
 */
export const createActivitySnapshotEvent = (
  props: ActivitySnapshotEventProps,
): ActivitySnapshotEvent =>
  buildEvent(EventType.ACTIVITY_SNAPSHOT, ActivitySnapshotEventSchema, props);

/**
 * Creates an ACTIVITY_DELTA event.
 */
export const createActivityDeltaEvent = (props: ActivityDeltaEventProps): ActivityDeltaEvent =>
  buildEvent(EventType.ACTIVITY_DELTA, ActivityDeltaEventSchema, props);

/**
 * Creates a RAW event.
 */
export const createRawEvent = (props: RawEventProps): RawEvent =>
  buildEvent(EventType.RAW, RawEventSchema, props);

/**
 * Creates a CUSTOM event.
 */
export const createCustomEvent = (props: CustomEventProps): CustomEvent =>
  buildEvent(EventType.CUSTOM, CustomEventSchema, props);

/**
 * Creates a RUN_STARTED event.
 */
export const createRunStartedEvent = (props: RunStartedEventProps): RunStartedEvent =>
  buildEvent(EventType.RUN_STARTED, RunStartedEventSchema, props);

/**
 * Creates a RUN_FINISHED event.
 *
 * `outcome` is optional. Omit it for legacy/back-compat behavior, or set it
 * explicitly to `{ type: "success" }` or `{ type: "interrupt", interrupts }`
 * — see `createRunFinishedSuccessEvent` and `createRunFinishedInterruptEvent`
 * for convenience helpers.
 */
export const createRunFinishedEvent = (props: RunFinishedEventProps): RunFinishedEvent =>
  buildEvent(EventType.RUN_FINISHED, RunFinishedEventSchema, props);

/**
 * Creates a RUN_FINISHED event with `outcome: { type: "success" }`.
 */
export const createRunFinishedSuccessEvent = (
  props: Omit<RunFinishedEventProps, "outcome">,
): RunFinishedEvent =>
  buildEvent(EventType.RUN_FINISHED, RunFinishedEventSchema, {
    ...props,
    outcome: { type: "success" },
  });

/**
 * Creates a RUN_FINISHED event with `outcome: { type: "interrupt", interrupts }`.
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

/**
 * Creates a RUN_ERROR event.
 */
export const createRunErrorEvent = (props: RunErrorEventProps): RunErrorEvent =>
  buildEvent(EventType.RUN_ERROR, RunErrorEventSchema, props);

/**
 * Creates a STEP_STARTED event.
 */
export const createStepStartedEvent = (props: StepStartedEventProps): StepStartedEvent =>
  buildEvent(EventType.STEP_STARTED, StepStartedEventSchema, props);

/**
 * Creates a STEP_FINISHED event.
 */
export const createStepFinishedEvent = (props: StepFinishedEventProps): StepFinishedEvent =>
  buildEvent(EventType.STEP_FINISHED, StepFinishedEventSchema, props);

/**
 * Creates a REASONING_START event.
 */
export const createReasoningStartEvent = (props: ReasoningStartEventProps): ReasoningStartEvent =>
  buildEvent(EventType.REASONING_START, ReasoningStartEventSchema, props);

/**
 * Creates a REASONING_MESSAGE_START event.
 */
export const createReasoningMessageStartEvent = (
  props: ReasoningMessageStartEventProps,
): ReasoningMessageStartEvent =>
  buildEvent(EventType.REASONING_MESSAGE_START, ReasoningMessageStartEventSchema, props);

/**
 * Creates a REASONING_MESSAGE_CONTENT event.
 */
export const createReasoningMessageContentEvent = (
  props: ReasoningMessageContentEventProps,
): ReasoningMessageContentEvent =>
  buildEvent(EventType.REASONING_MESSAGE_CONTENT, ReasoningMessageContentEventSchema, props);

/**
 * Creates a REASONING_MESSAGE_END event.
 */
export const createReasoningMessageEndEvent = (
  props: ReasoningMessageEndEventProps,
): ReasoningMessageEndEvent =>
  buildEvent(EventType.REASONING_MESSAGE_END, ReasoningMessageEndEventSchema, props);

/**
 * Creates a REASONING_MESSAGE_CHUNK event.
 */
export const createReasoningMessageChunkEvent = (
  props: ReasoningMessageChunkEventProps,
): ReasoningMessageChunkEvent =>
  buildEvent(EventType.REASONING_MESSAGE_CHUNK, ReasoningMessageChunkEventSchema, props);

/**
 * Creates a REASONING_END event.
 */
export const createReasoningEndEvent = (props: ReasoningEndEventProps): ReasoningEndEvent =>
  buildEvent(EventType.REASONING_END, ReasoningEndEventSchema, props);

/**
 * Creates a REASONING_ENCRYPTED_VALUE event.
 */
export const createReasoningEncryptedValueEvent = (
  props: ReasoningEncryptedValueEventProps,
): ReasoningEncryptedValueEvent =>
  buildEvent(EventType.REASONING_ENCRYPTED_VALUE, ReasoningEncryptedValueEventSchema, props);

/**
 * Creates a SUBAGENT_STARTED event.
 */
export const createSubagentStartedEvent = (
  props: SubagentStartedEventProps,
): SubagentStartedEvent =>
  buildEvent(EventType.SUBAGENT_STARTED, SubagentStartedEventSchema, props);

/**
 * Creates a SUBAGENT_FINISHED event.
 */
export const createSubagentFinishedEvent = (
  props: SubagentFinishedEventProps,
): SubagentFinishedEvent =>
  buildEvent(EventType.SUBAGENT_FINISHED, SubagentFinishedEventSchema, props);

/**
 * Creates a SUBAGENT_ERROR event.
 */
export const createSubagentErrorEvent = (props: SubagentErrorEventProps): SubagentErrorEvent =>
  buildEvent(EventType.SUBAGENT_ERROR, SubagentErrorEventSchema, props);
