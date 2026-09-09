import type {
  Event,
  BaseEvent as ProtocolBaseEvent,
  InputContent,
  ResumeEntry,
} from "./generated/types";
import { EventType } from "./generated/types";

/**
 * Compatibility layer: the names this package has always exported, pointed at
 * the generated protocol source. Everything protocol-shaped lives in
 * src/generated (regenerate with `pnpm --filter @ag-ui/spec generate`); this
 * file only aliases, derives, and carries the package's own error types.
 */

/** Every protocol event, under its historic name (the generated name is Event). */
export type AGUIEvent = Event;

/**
 * The historic BaseEvent shape: the protocol's base fields plus an open index
 * signature. The hand-written type inherited the index signature from zod's
 * passthrough inference, and client code reads event-specific fields straight
 * off a BaseEvent, so the compat surface keeps it. The exact protocol shape
 * is the generated BaseEvent; the closed union of real events is `Event`.
 */
export type BaseEvent = ProtocolBaseEvent & { [key: string]: unknown };

/** The fields every event carries, under their historic name. */
export type BaseEventFields = BaseEvent;

/** Event type discriminator -> concrete event, derived from the union. */
export type AGUIEventByType = {
  [K in EventType]: Extract<Event, { type: K }>;
};

export type AGUIEventOf<T extends EventType> = AGUIEventByType[T];

// Distributive on purpose: for a union of event types, plain Omit over the
// union of events would keep only their COMMON keys (the base fields — which
// are exactly what gets omitted), collapsing every payload to {}. The
// conditional distributes so each member keeps its own fields.
export type EventPayloadOf<T extends EventType> = T extends EventType
  ? Omit<
      AGUIEventOf<T>,
      // The exact protocol shape's keys: the open compat BaseEvent has a
      // string index signature, and omitting `keyof` THAT would erase every
      // field.
      keyof ProtocolBaseEvent
    >
  : never;

/**
 * What a factory takes: the event's fields, minus the discriminator the
 * factory sets. Derived from the generated event types rather than from
 * z.input of the loose validators — a looseObject's input type carries a
 * string index signature, and Omit over that erases every named field, which
 * would let `{}` or a wrong-typed field compile. The trailing open signature
 * keeps the historic tolerance for extra keys.
 */
type EventProps<E extends { type: EventType }> = Omit<E, "type"> & {
  [key: string]: unknown;
};

export type BaseEventProps = EventProps<ProtocolBaseEvent>;
export type TextMessageStartEventProps = EventProps<
  import("./generated/types").TextMessageStartEvent
>;
export type TextMessageContentEventProps = EventProps<
  import("./generated/types").TextMessageContentEvent
>;
export type TextMessageEndEventProps = EventProps<import("./generated/types").TextMessageEndEvent>;
export type TextMessageChunkEventProps = EventProps<
  import("./generated/types").TextMessageChunkEvent
>;
export type ToolCallStartEventProps = EventProps<import("./generated/types").ToolCallStartEvent>;
export type ToolCallArgsEventProps = EventProps<import("./generated/types").ToolCallArgsEvent>;
export type ToolCallEndEventProps = EventProps<import("./generated/types").ToolCallEndEvent>;
export type ToolCallChunkEventProps = EventProps<import("./generated/types").ToolCallChunkEvent>;
export type ToolCallResultEventProps = EventProps<import("./generated/types").ToolCallResultEvent>;
export type StateSnapshotEventProps = EventProps<import("./generated/types").StateSnapshotEvent>;
export type StateDeltaEventProps = EventProps<import("./generated/types").StateDeltaEvent>;
export type MessagesSnapshotEventProps = EventProps<
  import("./generated/types").MessagesSnapshotEvent
>;
export type ActivitySnapshotEventProps = EventProps<
  import("./generated/types").ActivitySnapshotEvent
>;
export type ActivityDeltaEventProps = EventProps<import("./generated/types").ActivityDeltaEvent>;
export type RawEventProps = EventProps<import("./generated/types").RawEvent>;
export type CustomEventProps = EventProps<import("./generated/types").CustomEvent>;
export type RunStartedEventProps = EventProps<import("./generated/types").RunStartedEvent>;
export type RunFinishedEventProps = EventProps<import("./generated/types").RunFinishedEvent>;
export type RunErrorEventProps = EventProps<import("./generated/types").RunErrorEvent>;
export type StepStartedEventProps = EventProps<import("./generated/types").StepStartedEvent>;
export type StepFinishedEventProps = EventProps<import("./generated/types").StepFinishedEvent>;
export type ReasoningStartEventProps = EventProps<import("./generated/types").ReasoningStartEvent>;
export type ReasoningMessageStartEventProps = EventProps<
  import("./generated/types").ReasoningMessageStartEvent
>;
export type ReasoningMessageContentEventProps = EventProps<
  import("./generated/types").ReasoningMessageContentEvent
>;
export type ReasoningMessageEndEventProps = EventProps<
  import("./generated/types").ReasoningMessageEndEvent
>;
export type ReasoningMessageChunkEventProps = EventProps<
  import("./generated/types").ReasoningMessageChunkEvent
>;
export type ReasoningEndEventProps = EventProps<import("./generated/types").ReasoningEndEvent>;
export type ReasoningEncryptedValueEventProps = EventProps<
  import("./generated/types").ReasoningEncryptedValueEvent
>;
export type SubagentStartedEventProps = EventProps<
  import("./generated/types").SubagentStartedEvent
>;
export type SubagentFinishedEventProps = EventProps<
  import("./generated/types").SubagentFinishedEvent
>;
export type SubagentErrorEventProps = EventProps<import("./generated/types").SubagentErrorEvent>;

/**
 * Historic aliases for the media input parts: the schema names them
 * ...InputContent, and this package has always also exported them as
 * ...InputPart. The matching validator aliases live in src/schemas.ts, which
 * is where every runtime validator this package ships lives.
 */
export type {
  ImageInputContent as ImageInputPart,
  AudioInputContent as AudioInputPart,
  VideoInputContent as VideoInputPart,
  DocumentInputContent as DocumentInputPart,
} from "./generated/types";

/** Historic alias: a content part of a user message. */
export type InputContentPart = InputContent;

/** Whether an interrupt was answered or abandoned. */
export type ResumeStatus = ResumeEntry["status"];

export class AGUIError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class AGUIConnectNotImplementedError extends AGUIError {
  constructor() {
    super("Connect not implemented. This method is not supported by the current agent.");
  }
}
