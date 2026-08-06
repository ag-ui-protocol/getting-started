import {
  BaseEvent,
  Interrupt,
  Message,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  State,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  MessagesSnapshotEvent,
  RawEvent,
  CustomEvent,
  ToolCall,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  ActivityMessage,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
  SubagentStartedEvent,
  SubagentFinishedEvent,
  SubagentErrorEvent,
} from "@ag-ui/core";
import { AbstractAgent } from "./agent";
import { structuredClone_ } from "@/utils";

export interface AgentStateMutation {
  messages?: Message[];
  state?: State;
  stopPropagation?: boolean;
}

export interface AgentSubscriberParams {
  messages: ReadonlyArray<Readonly<Message>>;
  // NOTE: State resolves to `any` at the type level (z.infer<typeof z.any()>), so Readonly<State>
  // provides no compile-time mutation protection. Runtime enforcement via deepFreeze in
  // dev/test mode is the only guard against in-place mutation of state.
  state: Readonly<State>;
  agent: AbstractAgent;
  input: RunAgentInput;
}

// Utility type to allow callbacks to be implemented either synchronously or asynchronously.
export type MaybePromise<T> = T | Promise<T>;

export interface AgentSubscriber {
  // Request lifecycle
  onRunInitialized?(
    params: AgentSubscriberParams,
  ): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;
  onRunFailed?(
    params: { error: Error } & AgentSubscriberParams,
  ): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;
  onRunFinalized?(
    params: AgentSubscriberParams,
  ): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;

  // Events
  onEvent?(
    params: { event: BaseEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onRunStartedEvent?(
    params: { event: RunStartedEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onRunFinishedEvent?(
    params: (
      | { event: RunFinishedEvent; outcome: "success"; result?: unknown }
      | { event: RunFinishedEvent; outcome: "interrupt"; interrupts: Interrupt[] }
    ) &
      AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onRunErrorEvent?(
    params: { event: RunErrorEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onStepStartedEvent?(
    params: { event: StepStartedEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onStepFinishedEvent?(
    params: { event: StepFinishedEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onSubagentStartedEvent?(
    params: { event: SubagentStartedEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onSubagentFinishedEvent?(
    params: { event: SubagentFinishedEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onSubagentErrorEvent?(
    params: { event: SubagentErrorEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onTextMessageStartEvent?(
    params: { event: TextMessageStartEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onTextMessageContentEvent?(
    params: {
      event: TextMessageContentEvent;
      textMessageBuffer: string;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onTextMessageEndEvent?(
    params: { event: TextMessageEndEvent; textMessageBuffer: string } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onToolCallStartEvent?(
    params: { event: ToolCallStartEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onToolCallArgsEvent?(
    params: {
      event: ToolCallArgsEvent;
      toolCallBuffer: string;
      toolCallName: string;
      partialToolCallArgs: Record<string, any>;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onToolCallEndEvent?(
    params: {
      event: ToolCallEndEvent;
      toolCallName: string;
      toolCallArgs: Record<string, any>;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onToolCallResultEvent?(
    params: { event: ToolCallResultEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onStateSnapshotEvent?(
    params: { event: StateSnapshotEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onStateDeltaEvent?(
    params: { event: StateDeltaEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onMessagesSnapshotEvent?(
    params: { event: MessagesSnapshotEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onActivitySnapshotEvent?(
    params: {
      event: ActivitySnapshotEvent;
      activityMessage?: ActivityMessage;
      existingMessage?: Message;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onActivityDeltaEvent?(
    params: {
      event: ActivityDeltaEvent;
      activityMessage?: ActivityMessage;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onRawEvent?(
    params: { event: RawEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onCustomEvent?(
    params: { event: CustomEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  // Reasoning events
  onReasoningStartEvent?(
    params: { event: ReasoningStartEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onReasoningMessageStartEvent?(
    params: { event: ReasoningMessageStartEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onReasoningMessageContentEvent?(
    params: {
      event: ReasoningMessageContentEvent;
      reasoningMessageBuffer: string;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onReasoningMessageEndEvent?(
    params: {
      event: ReasoningMessageEndEvent;
      reasoningMessageBuffer: string;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onReasoningEndEvent?(
    params: { event: ReasoningEndEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onReasoningEncryptedValueEvent?(
    params: { event: ReasoningEncryptedValueEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  // State changes
  onMessagesChanged?(
    params: Omit<AgentSubscriberParams, "input"> & { input?: RunAgentInput },
  ): MaybePromise<void>;
  onStateChanged?(
    params: Omit<AgentSubscriberParams, "input"> & { input?: RunAgentInput },
  ): MaybePromise<void>;
  onNewMessage?(
    params: { message: Message } & Omit<AgentSubscriberParams, "input"> & {
        input?: RunAgentInput;
      },
  ): MaybePromise<void>;
  onNewToolCall?(
    params: { toolCall: ToolCall } & Omit<AgentSubscriberParams, "input"> & {
        input?: RunAgentInput;
      },
  ): MaybePromise<void>;
}

function deepFreeze<T>(obj: T): T {
  Object.freeze(obj);
  if (obj !== null && typeof obj === "object") {
    for (const value of Object.values(obj)) {
      if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        deepFreeze(value);
      }
    }
  }
  return obj;
}

// Above this many string characters across messages+state, the dev-only
// clone+deepFreeze guard is skipped. That guard exists to surface accidental
// in-place mutation during development — it is NOT required for correctness.
// Paying a full recursive structuredClone + deepFreeze of the entire messages
// array AND state object on every streamed event is what exhausts the renderer
// heap when tool-call arguments stream large payloads (V8 fatal:
// "JavaScript heap out of memory" from structuredClone).
const DEV_FREEZE_CHAR_LIMIT = 512 * 1024;

// Cheap, bounded size probe: returns true as soon as the combined string length
// of messages+state (counting both string values AND object key names, since
// keys also contribute to clone cost) exceeds `limit`. Does NOT recursively
// structuredClone or materialize copies — only a bounded iterative traversal
// stack plus a visited-set guard, so it is safe for arbitrarily nested or
// cyclic structures. (`State` is typed `any`, so cycles are possible.)
function payloadExceeds(messages: unknown, state: unknown, limit: number): boolean {
  let chars = 0;
  const stack: unknown[] = [messages, state];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      chars += value.length;
      if (chars > limit) return true;
    } else if (value !== null && typeof value === "object") {
      if (seen.has(value as object)) continue;
      seen.add(value as object);
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) stack.push(value[i]);
      } else {
        // Own enumerable keys only — avoids walking the prototype chain and
        // triggering inherited getters (matches deepFreeze's Object.values).
        const keys = Object.keys(value as Record<string, unknown>);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          // Key names contribute to clone cost too; count them as we go.
          chars += key.length;
          if (chars > limit) return true;
          stack.push((value as Record<string, unknown>)[key]);
        }
      }
    }
  }
  return false;
}

export async function runSubscribersWithMutation(
  subscribers: AgentSubscriber[],
  initialMessages: Message[],
  initialState: State,
  executor: (
    subscriber: AgentSubscriber,
    messages: ReadonlyArray<Readonly<Message>>,
    state: Readonly<State>,
  ) => MaybePromise<AgentStateMutation | void>,
): Promise<AgentStateMutation> {
  const hasProcess = typeof process !== "undefined" && typeof process.env !== "undefined";
  const isTestEnvironment =
    hasProcess && (process.env.NODE_ENV === "test" || Boolean(process.env.VITEST_WORKER_ID));
  const isDev =
    hasProcess &&
    (process.env.NODE_ENV === "development" ||
      process.env.NODE_ENV === "test" ||
      Boolean(process.env.VITEST_WORKER_ID));

  // The dev-only clone+deepFreeze guard (which surfaces accidental in-place
  // mutation) is the dominant per-event allocation. Skip it in production, and
  // in dev when the payload is large — otherwise streaming large tool-call
  // arguments deep-clones the whole messages+state on every event and exhausts
  // the heap (V8 fatal: "JavaScript heap out of memory" from structuredClone).
  let freezeInputs = isDev && !payloadExceeds(initialMessages, initialState, DEV_FREEZE_CHAR_LIMIT);

  // Only the freeze path needs an isolated baseline copy. Otherwise pass the
  // inputs through and lazily clone only when a subscriber actually returns a
  // mutation — so the common "no mutation" event costs zero clones.
  let messages: Message[] = freezeInputs ? structuredClone_(initialMessages) : initialMessages;
  let state: State = freezeInputs ? structuredClone_(initialState) : initialState;
  let messagesMutated = false;
  let stateMutated = false;

  let stopPropagation: boolean | undefined = undefined;

  for (const subscriber of subscribers) {
    try {
      // Subscribers receive shared references and must not mutate them in-place.
      // Mutations should only be communicated via the return value.
      // In dev/test mode (small payloads): deep-freeze inputs so accidental
      // in-place mutations surface as TypeErrors immediately.
      if (freezeInputs) {
        deepFreeze(messages);
        deepFreeze(state);
      }
      const mutation = await executor(subscriber, messages, state);

      if (mutation === undefined) {
        // Nothing returned – keep going
        continue;
      }

      // Replace with a defensive copy of the subscriber's mutation,
      // but skip if the subscriber returned the same reference (no-op).
      let payloadChanged = false;
      if (mutation.messages !== undefined && mutation.messages !== messages) {
        messages = structuredClone_(mutation.messages);
        messagesMutated = true;
        payloadChanged = true;
      }

      if (mutation.state !== undefined && mutation.state !== state) {
        state = structuredClone_(mutation.state);
        stateMutated = true;
        payloadChanged = true;
      }

      // If a subscriber's mutation has grown the payload past the limit, drop
      // the freeze guard for the remaining iterations. Otherwise we'd pay a
      // full deepFreeze + final unfreeze-clone of the now-huge structure on
      // every later subscriber — exactly the cost this PR removes.
      if (freezeInputs && payloadChanged) {
        if (payloadExceeds(messages, state, DEV_FREEZE_CHAR_LIMIT)) {
          freezeInputs = false;
        }
      }

      stopPropagation = mutation.stopPropagation;

      if (stopPropagation === true) {
        break;
      }
    } catch (error) {
      if (isDev && error instanceof TypeError) {
        // Likely a freeze violation: subscriber attempted to mutate frozen inputs in-place.
        // In test environments, re-throw so tests fail fast and the violation is visible.
        // In development (non-test), log a specific message to distinguish freeze violations
        // from ordinary subscriber errors.
        if (isTestEnvironment) {
          throw error;
        }
        console.error(
          "AG-UI: Subscriber attempted to mutate frozen inputs in-place. " +
            "Return mutations via AgentStateMutation instead of mutating directly.",
          error,
        );
      } else if (!isTestEnvironment) {
        console.error("Subscriber error:", error);
      }
      // Skip this subscriber's mutation and continue
      continue;
    }
  }

  // A mutated copy may have been frozen in-place on a later subscriber pass;
  // clone it before returning so callers receive a mutable copy.
  return {
    ...(messagesMutated
      ? { messages: Object.isFrozen(messages) ? structuredClone_(messages) : messages }
      : {}),
    ...(stateMutated ? { state: Object.isFrozen(state) ? structuredClone_(state) : state } : {}),
    ...(stopPropagation !== undefined ? { stopPropagation } : {}),
  };
}
