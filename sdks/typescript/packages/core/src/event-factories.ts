/**
 * Event factories: constructors that validate what they build.
 *
 * This module has a RUNTIME dependency on zod — it imports the generated
 * validators (`./generated/schemas`, a value import, not a type-only one) to
 * parse each event it constructs. So it MUST NEVER be re-exported from
 * `src/index.ts`, directly or through anything index.ts re-exports. The main
 * entry's contract is that importing `@ag-ui/core` pulls no zod at runtime,
 * which is what lets zod be an OPTIONAL peer dependency; one edge from
 * index.ts to this file breaks that for every type-only consumer, and it
 * breaks it at install time, not at build time.
 *
 * Nothing re-exports this module today — the tests import it by relative
 * path. If it is ever given a public home, that home is the
 * `@ag-ui/core/schemas` subpath, alongside the validators it uses, never the
 * main entry. `src/__tests__/main-entry-zod-free.test.ts` guards the rule
 * structurally: it bundles src/index.ts with zod marked external and fails if
 * a `zod` import survives into the output, so a re-export three files deep is
 * caught even though a grep of index.ts would miss it.
 */
import type { z } from "zod/v4";
import { EventType } from "./generated/types";
import type {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  CustomEvent,
  Interrupt,
  MessagesSnapshotEvent,
  RawEvent,
  ReasoningEncryptedValueEvent,
  ReasoningEndEvent,
  ReasoningMessageChunkEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
  ReasoningStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  SubagentErrorEvent,
  SubagentFinishedEvent,
  SubagentStartedEvent,
  TextMessageChunkEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallChunkEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "./generated/types";
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
  SubagentErrorEventSchema,
  SubagentFinishedEventSchema,
  SubagentStartedEventSchema,
  TextMessageChunkEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallChunkEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema,
} from "./generated/schemas";
import type {
  ActivityDeltaEventProps,
  ActivitySnapshotEventProps,
  CustomEventProps,
  MessagesSnapshotEventProps,
  RawEventProps,
  ReasoningEncryptedValueEventProps,
  ReasoningEndEventProps,
  ReasoningMessageChunkEventProps,
  ReasoningMessageContentEventProps,
  ReasoningMessageEndEventProps,
  ReasoningMessageStartEventProps,
  ReasoningStartEventProps,
  RunErrorEventProps,
  RunFinishedEventProps,
  RunStartedEventProps,
  StateDeltaEventProps,
  StateSnapshotEventProps,
  StepFinishedEventProps,
  StepStartedEventProps,
  SubagentErrorEventProps,
  SubagentFinishedEventProps,
  SubagentStartedEventProps,
  TextMessageChunkEventProps,
  TextMessageContentEventProps,
  TextMessageEndEventProps,
  TextMessageStartEventProps,
  ToolCallArgsEventProps,
  ToolCallChunkEventProps,
  ToolCallEndEventProps,
  ToolCallResultEventProps,
  ToolCallStartEventProps,
} from "./compat";

const buildEvent = <Schema extends z.ZodType>(
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
