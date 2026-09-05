import {
  EventType,
  type AGUIEvent,
  type StateDeltaEvent,
  type TokenUsage,
} from "@ag-ui/core";
import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  type Event as AdkEvent,
} from "@google/adk";

import { indexAgentTree } from "./agent-tree";
import type { ADKJSUsageProvider } from "./config";
import {
  ADK_METADATA_KEY,
  ADK_RAW_EVENT_SOURCE,
  AG_UI_INTERNAL_STATE_KEYS,
  isAdkSpecialStateKey,
  reasoningMessageId,
  toolResultIds,
} from "./constants";
import { ADKJSProtocolError } from "./errors";
import { publicAdkEvent } from "./event-sanitizer";
import {
  SubagentTracker,
  invocationKey,
  type SubagentContinuation,
  type SubagentTrackerOptions,
} from "./subagent-tracker";
import { clone, hasOwn, isRecord } from "./value-utils";

const INTERNAL_REQUEST_NAMES = new Set([
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
]);

/** ADK usage report field → AG-UI `TokenUsage` field. */
const USAGE_FIELDS = [
  ["promptTokenCount", "inputTokens"],
  ["candidatesTokenCount", "outputTokens"],
  ["totalTokenCount", "totalTokens"],
  ["thoughtsTokenCount", "reasoningTokens"],
  ["cachedContentTokenCount", "cachedInputTokens"],
] as const;

type AdkPart = NonNullable<NonNullable<AdkEvent["content"]>["parts"]>[number];
type FunctionCallPart = AdkPart & { functionCall: { name: string } };
type FunctionResponsePart = AdkPart & { functionResponse: { name: string } };

function isFunctionCallPart(part: AdkPart): part is FunctionCallPart {
  return Boolean(part.functionCall?.name);
}

function isFunctionResponsePart(part: AdkPart): part is FunctionResponsePart {
  return Boolean(part.functionResponse?.name);
}

/**
 * Per-(branch, author) message lifecycle. Parallel execution (a ParallelAgent or
 * a workflow fan-out) interleaves events from several sub-agents in one run;
 * giving each stream its own open message and delta accumulators keeps
 * interleaved text/reasoning from being appended to another author's message.
 * The AG-UI verifier tracks active messages per message id, so concurrently
 * open messages are protocol-legal.
 */
interface StreamState {
  openTextId?: string;
  openReasoningId?: string;
  lastReasoningId?: string;
  streamedText: string;
  streamedReasoning: string;
  /** Set while the stream belongs to an attributed sub-agent invocation. */
  subagentRunId?: string;
}

/** Everything the part translators need from one ADK event. */
interface EventContext {
  event: AdkEvent;
  /** `{ rawEvent }` (the redacted ADK event) when `emitRawEvents` is on. */
  raw: { rawEvent?: AdkEvent };
  metadata: Record<string, unknown>;
  stream: StreamState;
  /** `{ subagentRunId }` while the stream belongs to an attributed invocation. */
  tag: { subagentRunId?: string };
  /** The tracker's invocation key; null for the parent agent and unknown authors. */
  key: string | null;
}

function tagFields(stream: StreamState): { subagentRunId?: string } {
  return stream.subagentRunId ? { subagentRunId: stream.subagentRunId } : {};
}

/** Forget the accumulators once a model turn (or an invocation) has ended. */
function resetStream(stream: StreamState): void {
  stream.streamedText = "";
  stream.streamedReasoning = "";
  stream.lastReasoningId = undefined;
}

/** Tracker inputs the coordinator derives from the runner and the resume. */
export type TranslatorSubagentOptions = Omit<
  SubagentTrackerOptions,
  "closeStream"
>;

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ error: "ADK value is not JSON serializable" });
  }
}

function encodedSignature(value: string | Uint8Array): string {
  return typeof value === "string"
    ? value
    : Buffer.from(value).toString("base64");
}

function pointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function eventMetadata(event: AdkEvent): Record<string, unknown> {
  return {
    [ADK_METADATA_KEY]: {
      eventId: event.id,
      invocationId: event.invocationId,
      author: event.author,
      branch: event.branch,
      nodeInfo: event.nodeInfo,
      isolationScope: event.isolationScope,
    },
  };
}

/** Stateful, one-run translator from raw ADK events to AG-UI events. */
export class ADKEventTranslator {
  private state: unknown;
  private readonly streams = new Map<string, StreamState>();
  private readonly emittedToolCalls = new Set<string>();
  private readonly emittedAssistantMessages = new Set<string>();
  private readonly emittedMessageIds = new Set<string>();
  private readonly emittedReasoningSignatures = new Set<string>();
  private readonly usageEventIds = new Set<string>();
  private readonly lastUsageReportByTurn = new Map<string, string>();
  private readonly usage = new Map<string, TokenUsage>();
  private readonly tracker: SubagentTracker;
  private result: unknown;

  constructor(
    initialState: unknown,
    private readonly emitRawEvents = false,
    private readonly usageProvider: ADKJSUsageProvider = "google",
    subagents: TranslatorSubagentOptions = {
      tree: indexAgentTree(undefined),
      mode: "off",
    },
  ) {
    this.state = clone(initialState);
    this.tracker = new SubagentTracker({
      ...subagents,
      closeStream: (key) => this.closeStreamByKey(key),
    });
  }

  /** The last workflow `output` seen on the stream. */
  getResult(): unknown {
    return this.result;
  }

  /** Sub-agent terminals queued by a node failure; emit before RUN_ERROR. */
  drainErrorEvents(): AGUIEvent[] {
    return this.tracker.drainErrorEvents();
  }

  getState(): unknown {
    return clone(this.state);
  }

  getUsage(): TokenUsage[] | undefined {
    return this.usage.size > 0
      ? [...this.usage.values()].map((entry) => ({ ...entry }))
      : undefined;
  }

  getEmittedMessageIds(): string[] {
    return [...this.emittedMessageIds];
  }

  translate(event: AdkEvent): AGUIEvent[] {
    this.collectUsage(event);
    if (event.errorCode) {
      this.tracker.onError(event);
      throw new ADKJSProtocolError(
        event.errorMessage || event.errorCode,
        event.errorCode,
      );
    }

    // Lifecycle first: a sub-agent's SUBAGENT_STARTED must precede any event
    // attributed to it, including a STATE_DELTA on its first event.
    const begun = this.tracker.begin(event);
    const output: AGUIEvent[] = [...begun.events];
    const stream = this.streamFor(event);
    stream.subagentRunId = begun.tag;
    let redacted: AdkEvent | undefined;
    const transport = (): AdkEvent => (redacted ??= publicAdkEvent(event));
    const ctx: EventContext = {
      event,
      raw: this.emitRawEvents ? { rawEvent: transport() } : {},
      metadata: eventMetadata(event),
      stream,
      tag: tagFields(stream),
      key: begun.key,
    };
    let mapped = false;

    if (event.output !== undefined) {
      this.tracker.onOutput(begun.key, event.output);
      this.result = event.output;
    }
    const stateEvent = this.translateState(ctx);
    if (stateEvent) {
      output.push({ ...stateEvent, ...ctx.tag });
      mapped = true;
    }

    for (const [partIndex, part] of (event.content?.parts ?? []).entries()) {
      if (part.text) {
        output.push(
          ...this.translateText(ctx, part.text, Boolean(part.thought)),
          ...this.reasoningSignature(ctx, part.thoughtSignature),
        );
        mapped = true;
      } else if (isFunctionCallPart(part)) {
        output.push(...this.translateFunctionCall(ctx, part, partIndex));
        mapped = true;
      } else if (isFunctionResponsePart(part)) {
        output.push(...this.translateFunctionResponse(ctx, part, partIndex));
        mapped = true;
      } else if (
        part.executableCode ||
        part.codeExecutionResult ||
        part.inlineData ||
        part.fileData
      ) {
        output.push({
          type: EventType.RAW,
          event: { event: transport(), partIndex },
          source: ADK_RAW_EVENT_SOURCE,
          ...ctx.tag,
          metadata: ctx.metadata,
        });
        mapped = true;
      }
    }

    if (!event.partial) {
      output.push(...this.closeStream(stream));
      resetStream(stream);
    }

    if (this.emitRawEvents || !mapped) {
      output.push({
        type: EventType.RAW,
        event: transport(),
        source: ADK_RAW_EVENT_SOURCE,
        ...ctx.tag,
        metadata: ctx.metadata,
      });
    }

    return output;
  }

  /**
   * Close every open stream and sub-agent invocation. Returns the interrupts
   * owned by sub-agents that ended suspended, keyed by interrupt id.
   */
  finish(): {
    events: AGUIEvent[];
    interruptOwners: ReadonlyMap<string, SubagentContinuation>;
  } {
    const events: AGUIEvent[] = [];
    for (const stream of this.streams.values()) {
      events.push(...this.closeStream(stream));
    }
    const finished = this.tracker.finish();
    events.push(...finished.events);
    return { events, interruptOwners: finished.interruptOwners };
  }

  private streamFor(event: AdkEvent): StreamState {
    const key = invocationKey(event);
    let stream = this.streams.get(key);
    if (!stream) {
      stream = { streamedText: "", streamedReasoning: "" };
      this.streams.set(key, stream);
    }
    return stream;
  }

  /** Close an invocation's stream and forget its accumulators. */
  private closeStreamByKey(key: string): AGUIEvent[] {
    const stream = this.streams.get(key);
    if (!stream) {
      return [];
    }
    const output = this.closeStream(stream);
    resetStream(stream);
    return output;
  }

  private translateText(
    ctx: EventContext,
    text: string,
    thought: boolean,
  ): AGUIEvent[] {
    const { event, raw, metadata, stream, tag } = ctx;
    const output = thought
      ? this.closeText(stream)
      : this.closeReasoning(stream);

    const previouslyEmitted = thought
      ? stream.streamedReasoning
      : stream.streamedText;
    const continues = !event.partial && text.startsWith(previouslyEmitted);
    const delta = continues ? text.slice(previouslyEmitted.length) : text;
    const accumulated = continues ? text : previouslyEmitted + text;
    if (thought) {
      stream.streamedReasoning = accumulated;
    } else {
      stream.streamedText = accumulated;
    }
    if (!delta) {
      return output;
    }

    if (thought) {
      if (!stream.openReasoningId) {
        const messageId = reasoningMessageId(event.id);
        stream.openReasoningId = messageId;
        stream.lastReasoningId = messageId;
        this.emittedMessageIds.add(messageId);
        output.push(
          {
            type: EventType.REASONING_START,
            messageId,
            ...tag,
            ...raw,
            metadata,
          },
          {
            type: EventType.REASONING_MESSAGE_START,
            messageId,
            role: "reasoning",
            ...tag,
            metadata,
          },
        );
      }
      output.push({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: stream.openReasoningId,
        delta,
        ...tag,
        metadata,
      });
      return output;
    }

    if (!stream.openTextId) {
      stream.openTextId = event.id;
      this.emittedAssistantMessages.add(event.id);
      this.emittedMessageIds.add(event.id);
      output.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: event.id,
        role: "assistant",
        ...(event.author ? { name: event.author } : {}),
        ...tag,
        ...raw,
        metadata,
      });
    }
    output.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: stream.openTextId,
      delta,
      ...tag,
      metadata,
    });
    return output;
  }

  /** A thought signature attaches to the reasoning message open on the stream. */
  private reasoningSignature(
    ctx: EventContext,
    signature: AdkPart["thoughtSignature"],
  ): AGUIEvent[] {
    const reasoningId =
      ctx.stream.openReasoningId ?? ctx.stream.lastReasoningId;
    if (!signature || !reasoningId) {
      return [];
    }
    const encryptedValue = encodedSignature(signature);
    const signatureKey = `${reasoningId}:${encryptedValue}`;
    if (this.emittedReasoningSignatures.has(signatureKey)) {
      return [];
    }
    this.emittedReasoningSignatures.add(signatureKey);
    return [
      {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId: reasoningId,
        encryptedValue,
        ...ctx.tag,
        metadata: ctx.metadata,
      },
    ];
  }

  private translateFunctionCall(
    ctx: EventContext,
    part: FunctionCallPart,
    partIndex: number,
  ): AGUIEvent[] {
    const { event, raw, metadata, tag } = ctx;
    const call = part.functionCall;
    // A streamed sentence and the call that follows it are one model turn:
    // the aggregate event carries a new id, but the call belongs to the
    // assistant message already open on this stream.
    const parentMessageId = ctx.stream.openTextId ?? event.id;
    const output = this.closeStream(ctx.stream);
    // Progressive ADK streaming exposes partial function-call fragments and
    // later emits one complete aggregate call. Emitting the first fragment
    // would lose the completed arguments because call IDs are deduplicated.
    if (event.partial) {
      return output;
    }
    if (INTERNAL_REQUEST_NAMES.has(call.name)) {
      this.tracker.onInternalRequest(call, ctx.key);
      return output;
    }
    const toolCallId = call.id || `${event.id}:tool:${partIndex}`;
    if (this.emittedToolCalls.has(toolCallId)) {
      return output;
    }
    this.emittedToolCalls.add(toolCallId);
    if (
      parentMessageId === event.id &&
      !this.emittedAssistantMessages.has(event.id)
    ) {
      this.emittedAssistantMessages.add(event.id);
      this.emittedMessageIds.add(event.id);
      output.push(
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: event.id,
          role: "assistant",
          ...(event.author ? { name: event.author } : {}),
          ...tag,
          ...raw,
          metadata,
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: event.id, ...tag },
      );
    }
    output.push(
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: call.name,
        parentMessageId,
        ...tag,
        ...raw,
        metadata,
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: json(call.args ?? {}),
        ...tag,
        metadata,
      },
      { type: EventType.TOOL_CALL_END, toolCallId, ...tag, metadata },
    );
    if (part.thoughtSignature) {
      output.push({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "tool-call",
        entityId: toolCallId,
        encryptedValue: encodedSignature(part.thoughtSignature),
        ...tag,
        metadata,
      });
    }
    output.push(
      ...this.tracker.onToolCall(
        call.name,
        toolCallId,
        parentMessageId,
        ctx.key,
      ),
    );
    return output;
  }

  private translateFunctionResponse(
    ctx: EventContext,
    part: FunctionResponsePart,
    partIndex: number,
  ): AGUIEvent[] {
    const { event } = ctx;
    const response = part.functionResponse;
    const output = this.closeStream(ctx.stream);
    const { toolCallId, messageId } = toolResultIds(
      event.id,
      response.id,
      partIndex,
    );
    const lifecycle = this.tracker.onFunctionResponse(
      response.id,
      event,
      toolCallId,
      messageId,
    );
    if (INTERNAL_REQUEST_NAMES.has(response.name)) {
      return output;
    }
    this.emittedMessageIds.add(messageId);
    output.push(
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId,
        toolCallId,
        content: json(response.response ?? {}),
        role: "tool",
        ...ctx.tag,
        ...ctx.raw,
        metadata: ctx.metadata,
      },
      ...lifecycle,
    );
    return output;
  }

  private translateState(ctx: EventContext): StateDeltaEvent | undefined {
    const delta = ctx.event.actions?.stateDelta;
    if (!delta) {
      return undefined;
    }

    const patch: Array<Record<string, unknown>> = [];
    if (!isRecord(this.state)) {
      this.state = {};
      patch.push({ op: "replace", path: "", value: {} });
    }
    const state = this.state as Record<string, unknown>;

    for (const [key, value] of Object.entries(delta)) {
      if (AG_UI_INTERNAL_STATE_KEYS.has(key) || isAdkSpecialStateKey(key)) {
        continue;
      }
      patch.push({
        op: hasOwn(state, key) ? "replace" : "add",
        path: `/${pointerSegment(key)}`,
        value: clone(value),
      });
      state[key] = clone(value);
    }

    if (patch.length === 0) {
      return undefined;
    }
    return {
      type: EventType.STATE_DELTA,
      delta: patch,
      ...ctx.raw,
      metadata: ctx.metadata,
    };
  }

  private closeText(stream: StreamState): AGUIEvent[] {
    if (!stream.openTextId) {
      return [];
    }
    const messageId = stream.openTextId;
    stream.openTextId = undefined;
    return [
      { type: EventType.TEXT_MESSAGE_END, messageId, ...tagFields(stream) },
    ];
  }

  private closeReasoning(stream: StreamState): AGUIEvent[] {
    if (!stream.openReasoningId) {
      return [];
    }
    const messageId = stream.openReasoningId;
    stream.openReasoningId = undefined;
    return [
      {
        type: EventType.REASONING_MESSAGE_END,
        messageId,
        ...tagFields(stream),
      },
      { type: EventType.REASONING_END, messageId, ...tagFields(stream) },
    ];
  }

  private closeStream(stream: StreamState): AGUIEvent[] {
    return [...this.closeText(stream), ...this.closeReasoning(stream)];
  }

  private collectUsage(event: AdkEvent): void {
    // Dedup is scoped per (invocation, author, branch) so interleaved
    // parallel branches cannot suppress each other's reports.
    const turnKey = JSON.stringify([
      event.invocationId,
      event.author,
      event.branch,
    ]);
    if (
      event.content?.parts?.some((part) => part.functionResponse !== undefined)
    ) {
      // A tool result separates two model turns that may legitimately have the
      // same token counts.
      this.lastUsageReportByTurn.delete(turnKey);
    }
    if (event.partial) {
      // A progressive chunk means a fresh model turn is streaming on this
      // branch; any recorded signature belongs to the previous turn.
      this.lastUsageReportByTurn.delete(turnKey);
      return;
    }
    const usage = event.usageMetadata;
    // Event ids protect callers that replay a raw event; the report signature
    // below handles ADK aggregates that use distinct ids for repeated copies
    // of the same model-turn usage (e.g. the text and function-call halves of
    // one response).
    if (!usage || this.usageEventIds.has(event.id)) {
      return;
    }
    this.usageEventIds.add(event.id);
    const provider =
      typeof this.usageProvider === "function"
        ? this.usageProvider(event)
        : this.usageProvider;
    const model =
      typeof event.modelVersion === "string" && event.modelVersion.length > 0
        ? event.modelVersion
        : undefined;
    const signature = JSON.stringify([
      provider,
      model,
      ...USAGE_FIELDS.map(([from]) => usage[from]),
    ]);
    const isTurnTerminal =
      event.finishReason !== undefined || event.turnComplete === true;
    if (this.lastUsageReportByTurn.get(turnKey) === signature) {
      if (isTurnTerminal) {
        this.lastUsageReportByTurn.delete(turnKey);
      }
      return;
    }
    if (isTurnTerminal) {
      // A terminal report ends this model turn: a later turn on the same
      // branch (e.g. a loop iteration) may legitimately repeat the exact
      // token counts and must still be counted.
      this.lastUsageReportByTurn.delete(turnKey);
    } else {
      this.lastUsageReportByTurn.set(turnKey, signature);
    }
    const usageKey = JSON.stringify([provider, model]);
    let aggregate = this.usage.get(usageKey);
    if (!aggregate) {
      aggregate = {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      };
      this.usage.set(usageKey, aggregate);
    }
    for (const [from, to] of USAGE_FIELDS) {
      const count = usage[from];
      if (typeof count === "number") {
        aggregate[to] = (aggregate[to] ?? 0) + count;
      }
    }
  }
}
