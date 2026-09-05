// Maps an AI SDK v7 streamText() fullStream into AG-UI events on an rxjs
// Subscriber. Stateful per-run; create a new instance per run.

import {
  EventType,
  randomUUID,
  type AssistantMessage,
  type BaseEvent,
  type Message,
  type ReasoningMessage,
  type RunAgentInput,
  type ToolCall,
  type ToolMessage,
} from "@ag-ui/client";
import { tokenUsageFromAiSdkUsage, type TokenUsage } from "@ag-ui/core";
import type { Subscriber } from "rxjs";
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";

function getErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value == null) return "unknown error";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeJsonStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

// Tool-call arguments must be a valid JSON document (clients JSON.parse it),
// so strings are quoted here — unlike safeJsonStringify, which passes string
// tool OUTPUTS through as plain text.
function jsonStringifyToolArgs(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

// The five counts AG-UI's TokenUsage can carry, under the flat AI SDK key
// names its usage mapper reads.
interface FlatAiSdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

// TokenUsageSchema types every count as a non-negative integer, so anything
// else has to be dropped here: tokenUsageFromAiSdkUsage only guards against
// non-finite values, and a fractional or negative count surviving into the
// event fails RunFinishedEventSchema — killing the run's final event on a
// validating transport. Declared as `number | undefined` (what the AI SDK
// promises) but guarded at runtime, since the value is really a provider's.
function intOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

// v7 keeps `inputTokens`/`outputTokens`/`totalTokens` flat but moved the
// cached-input and reasoning counts into `inputTokenDetails`/
// `outputTokenDetails`, so lift those two before mapping — otherwise the two
// counts users most want to see (cache savings, reasoning spend) would
// silently read as "not reported".
function flattenAiSdkUsage(usage: LanguageModelUsage | undefined): FlatAiSdkUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: intOrUndefined(usage.inputTokens),
    outputTokens: intOrUndefined(usage.outputTokens),
    totalTokens: intOrUndefined(usage.totalTokens),
    cachedInputTokens: intOrUndefined(usage.inputTokenDetails?.cacheReadTokens),
    reasoningTokens: intOrUndefined(usage.outputTokenDetails?.reasoningTokens),
  };
}

interface ToolCallPart {
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid?: boolean;
  error?: unknown;
  providerExecuted?: boolean;
  dynamic?: boolean;
}

interface ToolResultPart {
  toolCallId: string;
  output: unknown;
  preliminary?: boolean;
}

interface ToolErrorPart {
  toolCallId: string;
  error: unknown;
}

interface ToolOutputDeniedPart {
  toolCallId: string;
}

interface ToolApprovalRequestPart {
  approvalId: string;
  toolCall: unknown;
}

interface ToolApprovalResponsePart {
  approvalId: string;
  toolCall: unknown;
  approved: boolean;
  reason?: string;
}

interface CustomPart {
  kind: string;
  providerMetadata?: unknown;
}

interface ReasoningEndPart {
  id: string;
  providerMetadata?: { anthropic?: { signature?: unknown } } & Record<string, unknown>;
}

export class StreamHandler {
  private currentStepAssistantId = randomUUID();
  private currentAssistantMessage: AssistantMessage = {
    id: this.currentStepAssistantId,
    role: "assistant",
    content: "",
    toolCalls: [],
  };
  private currentMessagePushed = false;
  private finalMessages: Message[];
  private stepIndex = 0;
  private completed = false;

  private openTextIds = new Set<string>();
  // AI SDK part id → AG-UI message id for the current step. Provider part ids
  // are only unique within one response (openai chat uses "0", anthropic the
  // content-block index), so a part id that collides with a message already in
  // finalMessages is remapped to a fresh UUID.
  private textIdMap = new Map<string, string>();
  private openReasonings = new Map<string, ReasoningMessage>();
  private seenToolCalls = new Set<string>();
  private openToolCallIds = new Set<string>();
  private emittedToolResults = new Set<string>();
  // Aggregate usage for the whole run, reported once by the terminal `finish`
  // part. Held until RUN_FINISHED, which is where AG-UI carries it.
  private totalUsage?: LanguageModelUsage;

  constructor(
    private readonly input: RunAgentInput,
    private readonly subscriber: Subscriber<BaseEvent>,
    // Labels for the usage entry. Deliberately the model the agent was
    // CONFIGURED with, not finish-step.response.modelId: that field is per
    // step, while totalUsage aggregates the whole run, so labelling the
    // aggregate with any single step's responding model could misattribute
    // it when steps use different models. Optional because a caller that
    // doesn't know (or care) still gets the counts.
    private readonly modelIdentity: { provider?: string; model?: string } = {},
  ) {
    this.finalMessages = [...input.messages];
    // Pre-seed: existing tool messages already account for prior tool calls.
    for (const m of input.messages) {
      if (m.role === "tool") this.emittedToolResults.add(m.toolCallId);
    }
  }

  async process(stream: AsyncIterable<TextStreamPart<ToolSet>>): Promise<void> {
    this.emit({
      type: EventType.RUN_STARTED,
      threadId: this.input.threadId,
      runId: this.input.runId,
    });

    try {
      for await (const part of stream) {
        if (this.subscriber.closed) break;
        this.handlePart(part);
      }
    } catch (error) {
      this.emit({
        type: EventType.RUN_ERROR,
        message: getErrorMessage(error),
        code: "stream_error",
      });
      this.complete();
      return;
    }

    this.closeAllOpenReasonings();
    this.closeAllOpenTexts();
    this.closeAllOpenToolCalls();
    this.synthesizeMissingToolResults();

    this.emit({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: this.finalMessages,
    });
    // Omit `usage` when the provider reported no counts — an empty or
    // labels-only entry would claim usage was measured when it wasn't.
    const usageEntry: TokenUsage | undefined = tokenUsageFromAiSdkUsage(
      flattenAiSdkUsage(this.totalUsage),
      this.modelIdentity,
    );
    this.emit({
      type: EventType.RUN_FINISHED,
      threadId: this.input.threadId,
      runId: this.input.runId,
      ...(usageEntry ? { usage: [usageEntry] } : {}),
    });
    this.complete();
  }

  private emit(event: Record<string, unknown> & { type: EventType }): void {
    if (this.subscriber.closed) return;
    this.subscriber.next(event as BaseEvent);
  }

  private complete(): void {
    if (this.completed) return;
    this.completed = true;
    if (!this.subscriber.closed) this.subscriber.complete();
  }

  private ensureAssistantPushed(): void {
    if (this.currentMessagePushed) return;
    this.finalMessages.push(this.currentAssistantMessage);
    this.currentMessagePushed = true;
  }

  // Reuse the AI SDK part id as the AG-UI message id unless it collides with
  // a message already in the conversation (prior run or prior step).
  private uniqueMessageId(partId: string): string {
    return this.finalMessages.some((m) => m.id === partId) ? randomUUID() : partId;
  }

  private handlePart(part: TextStreamPart<ToolSet>): void {
    switch (part.type) {
      case "text-start":
        return this.onTextStart(part);
      case "text-delta":
        return this.onTextDelta(part);
      case "text-end":
        return this.onTextEnd(part);
      case "reasoning-start":
        return this.onReasoningStart(part);
      case "reasoning-delta":
        return this.onReasoningDelta(part);
      case "reasoning-end":
        return this.onReasoningEnd(part as ReasoningEndPart);
      case "tool-input-start":
        return this.onToolInputStart(part);
      case "tool-input-delta":
        return this.onToolInputDelta(part);
      case "tool-input-end":
        return this.onToolInputEnd(part);
      case "tool-call":
        return this.onToolCall(part as ToolCallPart);
      case "tool-result":
        return this.onToolResult(part as ToolResultPart);
      case "tool-error":
        return this.onToolError(part as ToolErrorPart);
      case "tool-output-denied":
        return this.onToolOutputDenied(part as ToolOutputDeniedPart);
      case "tool-approval-request":
        return this.onToolApprovalRequest(part as ToolApprovalRequestPart);
      case "tool-approval-response":
        return this.onToolApprovalResponse(part as ToolApprovalResponsePart);
      case "custom":
        return this.onCustom(part as CustomPart);
      case "start-step":
        return this.onStartStep();
      case "finish-step":
        return this.onFinishStep();
      case "finish":
        this.totalUsage = part.totalUsage;
        return;
      case "abort":
        // RUN_ERROR + complete is terminal; mirrors the thrown-error path
        // and prevents the cleanup phase from emitting a misleading
        // RUN_FINISHED for an aborted run.
        this.emit({
          type: EventType.RUN_ERROR,
          message: "Stream aborted",
          code: "aborted",
        });
        this.complete();
        return;
      case "error":
        this.emit({
          type: EventType.RUN_ERROR,
          message: getErrorMessage((part as { error: unknown }).error),
          code: "stream_error_part",
        });
        this.complete();
        return;
      // Skip: the run-open lifecycle part (RUN_STARTED is emitted by
      // process()), plus structural content parts not mapped to AG-UI events
      // (source citations, generated files, raw provider chunks).
      case "start":
      case "source":
      case "file":
      case "reasoning-file":
      case "raw":
        return;
      default:
        console.warn(
          `[VercelAISDKAgent] Unrecognized stream part type: ${(part as { type?: string }).type}`,
        );
        return;
    }
  }

  // text -----------------------------------------------------------------
  private onTextStart(part: { id: string }): void {
    this.closeAllOpenReasonings();
    // Adopt the first text part's id as this step's assistant message id, so
    // the streamed TEXT_MESSAGE_* events and the assistant message that lands
    // in MESSAGES_SNAPSHOT share one id. Without this, the canonical client
    // drops the streamed message on snapshot (its id is absent from the
    // snapshot) and re-appends a fresh-UUID copy — a needless id churn. This
    // matches the langgraph/mastra convention of reusing the streamed id.
    //
    // `currentMessagePushed` doubles as the step-identity lock: a tool-first
    // step has already pushed the assistant message and emitted
    // TOOL_CALL_START.parentMessageId pointing at the current id, so we must
    // NOT re-key it here. Likewise, when a single step streams multiple text
    // segments, only the FIRST segment's id is adopted; later segments keep
    // their own TEXT_MESSAGE_* ids but collapse into this one assistant
    // message in the snapshot (their accumulated content already lands in
    // currentAssistantMessage.content). That collapse is intentional — one
    // assistant turn is one snapshot message.
    const messageId = this.textIdMap.get(part.id) ?? this.uniqueMessageId(part.id);
    this.textIdMap.set(part.id, messageId);
    if (!this.currentMessagePushed) {
      this.currentStepAssistantId = messageId;
      this.currentAssistantMessage.id = messageId;
    }
    this.ensureAssistantPushed();
    this.openTextIds.add(messageId);
    this.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
    });
  }

  private onTextDelta(part: { id: string; text: string }): void {
    this.currentAssistantMessage.content =
      `${this.currentAssistantMessage.content ?? ""}${part.text}`;
    this.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: this.textIdMap.get(part.id) ?? part.id,
      delta: part.text,
    });
  }

  private onTextEnd(part: { id: string }): void {
    const messageId = this.textIdMap.get(part.id) ?? part.id;
    this.openTextIds.delete(messageId);
    this.emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId,
    });
  }

  private closeAllOpenTexts(): void {
    for (const id of this.openTextIds) {
      this.emit({ type: EventType.TEXT_MESSAGE_END, messageId: id });
    }
    this.openTextIds.clear();
  }

  // reasoning ------------------------------------------------------------
  private onReasoningStart(part: { id: string }): void {
    if (this.openReasonings.has(part.id)) return;
    const messageId = this.uniqueMessageId(part.id);
    const msg: ReasoningMessage = { id: messageId, role: "reasoning", content: "" };
    this.openReasonings.set(part.id, msg);
    this.emit({ type: EventType.REASONING_START, messageId });
    this.emit({
      type: EventType.REASONING_MESSAGE_START,
      messageId,
      role: "reasoning",
    });
  }

  private onReasoningDelta(part: { id: string; text: string }): void {
    const msg = this.openReasonings.get(part.id);
    if (msg) msg.content = `${msg.content ?? ""}${part.text}`;
    this.emit({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: msg?.id ?? part.id,
      delta: part.text,
    });
  }

  private onReasoningEnd(part: ReasoningEndPart): void {
    const msg = this.openReasonings.get(part.id);
    const messageId = msg?.id ?? part.id;
    this.emit({ type: EventType.REASONING_MESSAGE_END, messageId });
    this.emit({ type: EventType.REASONING_END, messageId });

    const sig = part.providerMetadata?.anthropic?.signature;
    if (typeof sig === "string" && sig.length > 0) {
      if (msg) msg.encryptedValue = sig;
      this.emit({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId: messageId,
        encryptedValue: sig,
      });
    }
    if (msg) this.finalMessages.push(msg);
    this.openReasonings.delete(part.id);
  }

  private closeAllOpenReasonings(): void {
    if (this.openReasonings.size === 0) return;
    for (const msg of this.openReasonings.values()) {
      this.emit({ type: EventType.REASONING_MESSAGE_END, messageId: msg.id });
      this.emit({ type: EventType.REASONING_END, messageId: msg.id });
      this.finalMessages.push(msg);
    }
    this.openReasonings.clear();
  }

  // tool input streaming --------------------------------------------------
  private onToolInputStart(part: { id: string; toolName: string }): void {
    this.closeAllOpenReasonings();
    this.ensureAssistantPushed();
    this.seenToolCalls.add(part.id);
    this.openToolCallIds.add(part.id);
    this.emit({
      type: EventType.TOOL_CALL_START,
      toolCallId: part.id,
      toolCallName: part.toolName,
      parentMessageId: this.currentStepAssistantId,
    });
  }

  private onToolInputDelta(part: { id: string; delta: string }): void {
    this.emit({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: part.id,
      delta: part.delta,
    });
  }

  private onToolInputEnd(part: { id: string }): void {
    this.openToolCallIds.delete(part.id);
    this.emit({ type: EventType.TOOL_CALL_END, toolCallId: part.id });
  }

  // Providers can leave a streamed tool input unterminated (e.g. openai
  // chat-completions never emits tool-input-end when generation is truncated
  // mid-arguments); close them so RUN_FINISHED passes client verification.
  private closeAllOpenToolCalls(): void {
    for (const id of this.openToolCallIds) {
      this.emit({ type: EventType.TOOL_CALL_END, toolCallId: id });
    }
    this.openToolCallIds.clear();
  }

  // tool call/result/error ------------------------------------------------
  private onToolCall(part: ToolCallPart): void {
    this.closeAllOpenReasonings();
    this.ensureAssistantPushed();

    const argsString = jsonStringifyToolArgs(part.input);

    // The final tool-call implies the input phase is over; close a streamed
    // input whose tool-input-end never arrived.
    if (this.openToolCallIds.has(part.toolCallId)) {
      this.openToolCallIds.delete(part.toolCallId);
      this.emit({ type: EventType.TOOL_CALL_END, toolCallId: part.toolCallId });
    }

    // Defensive synthesis: provider didn't stream tool input parts, only
    // emitted the final tool-call. Fabricate START/ARGS/END so the client
    // still gets the full tool-call lifecycle.
    if (!this.seenToolCalls.has(part.toolCallId)) {
      this.seenToolCalls.add(part.toolCallId);
      this.emit({
        type: EventType.TOOL_CALL_START,
        toolCallId: part.toolCallId,
        toolCallName: part.toolName,
        parentMessageId: this.currentStepAssistantId,
      });
      this.emit({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: part.toolCallId,
        delta: argsString,
      });
      this.emit({
        type: EventType.TOOL_CALL_END,
        toolCallId: part.toolCallId,
      });
    }

    const toolCall: ToolCall = {
      id: part.toolCallId,
      type: "function",
      function: { name: part.toolName, arguments: argsString },
    };
    // Defensive dedup: a misbehaving provider could emit the same tool-call
    // twice; without this, the assistant message would carry duplicate entries
    // with the same id and break the MESSAGES_SNAPSHOT for downstream clients.
    const existingToolCalls = this.currentAssistantMessage.toolCalls ?? [];
    if (!existingToolCalls.some((tc) => tc.id === part.toolCallId)) {
      this.currentAssistantMessage.toolCalls = [...existingToolCalls, toolCall];
    }

    // Note: invalid tool-calls are followed by a `tool-error` part in v7 —
    // letting that path emit TOOL_CALL_RESULT avoids duplicates. The
    // cleanup-phase synthesizer covers any provider that breaks this.
  }

  private onToolResult(part: ToolResultPart): void {
    const content = safeJsonStringify(part.output);
    if (part.preliminary) {
      // Preliminary results are delivery-only; don't persist to history.
      const msgId = randomUUID();
      this.emit({
        type: EventType.TOOL_CALL_RESULT,
        messageId: msgId,
        toolCallId: part.toolCallId,
        content,
        role: "tool",
      });
      return;
    }
    this.emitToolResult(part.toolCallId, content);
  }

  private onToolError(part: ToolErrorPart): void {
    const errMsg = getErrorMessage(part.error);
    this.emitToolResult(part.toolCallId, errMsg, errMsg);
  }

  private onToolOutputDenied(part: ToolOutputDeniedPart): void {
    // Pass an `error` so a client can distinguish an actual denial from a
    // tool that legitimately returned the string "denied" — mirrors how
    // onToolError surfaces the failure on the ToolMessage.
    this.emitToolResult(part.toolCallId, "denied", "tool output denied");
  }

  private emitToolResult(toolCallId: string, content: string, error?: string): void {
    const msgId = randomUUID();
    const toolMsg: ToolMessage = {
      id: msgId,
      role: "tool",
      toolCallId,
      content,
      ...(error !== undefined ? { error } : {}),
    };
    this.finalMessages.push(toolMsg);
    this.emittedToolResults.add(toolCallId);
    this.emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: msgId,
      toolCallId,
      content,
      role: "tool",
    });
  }

  private onToolApprovalRequest(part: ToolApprovalRequestPart): void {
    this.emit({
      type: EventType.CUSTOM,
      name: "tool_approval_request",
      value: { approvalId: part.approvalId, toolCall: part.toolCall },
    });
  }

  // Mirrors onToolApprovalRequest so the approval lifecycle is fully
  // observable on the AG-UI side; carries the granted/denied outcome.
  private onToolApprovalResponse(part: ToolApprovalResponsePart): void {
    this.emit({
      type: EventType.CUSTOM,
      name: "tool_approval_response",
      value: {
        approvalId: part.approvalId,
        toolCall: part.toolCall,
        approved: part.approved,
        ...(part.reason !== undefined ? { reason: part.reason } : {}),
      },
    });
  }

  // AI SDK provider `custom` parts are passed through as AG-UI CUSTOM
  // events. The part's namespaced `kind` becomes the event name so clients
  // can route by it; the provider metadata is the event value.
  private onCustom(part: CustomPart): void {
    this.emit({
      type: EventType.CUSTOM,
      name: part.kind,
      value: part.providerMetadata ?? {},
    });
  }

  // step lifecycle --------------------------------------------------------
  private onStartStep(): void {
    this.stepIndex += 1;
    this.emit({
      type: EventType.STEP_STARTED,
      stepName: `step-${this.stepIndex}`,
    });
  }

  private onFinishStep(): void {
    // Close anything a misbehaving provider left open before sealing the
    // step — otherwise the ids are lost to rotation and the end-of-run
    // cleanup can no longer close them. Reasonings matter here too: their
    // part ids restart per step on index-keyed providers, so an unclosed one
    // would swallow the next step's reasoning under the stale id.
    this.closeAllOpenReasonings();
    this.closeAllOpenTexts();
    this.closeAllOpenToolCalls();
    this.emit({
      type: EventType.STEP_FINISHED,
      stepName: `step-${this.stepIndex}`,
    });
    this.rotateAssistantMessage();
  }

  private rotateAssistantMessage(): void {
    this.currentStepAssistantId = randomUUID();
    this.currentAssistantMessage = {
      id: this.currentStepAssistantId,
      role: "assistant",
      content: "",
      toolCalls: [],
    };
    this.currentMessagePushed = false;
    this.textIdMap.clear();
    this.seenToolCalls.clear();
  }

  // cleanup ---------------------------------------------------------------
  private synthesizeMissingToolResults(): void {
    // Client-side tools (everything in input.tools) are converted without an
    // execute function, so their calls legitimately end the stream without a
    // result: the AG-UI client executes them and supplies the result on the
    // next run. Only server-executed tools that dropped their result get a
    // synthesized placeholder.
    const clientToolNames = new Set((this.input.tools ?? []).map((t) => t.name));
    for (const message of this.finalMessages) {
      if (message.role !== "assistant" || !message.toolCalls?.length) continue;
      for (const tc of message.toolCalls) {
        if (this.emittedToolResults.has(tc.id)) continue;
        if (clientToolNames.has(tc.function.name)) continue;
        this.emitToolResult(tc.id, "Tool call missing result", "Tool call missing result");
      }
    }
  }
}
