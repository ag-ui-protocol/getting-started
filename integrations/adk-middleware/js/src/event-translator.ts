import {
  EventType,
  type AGUIEvent,
  type StateDeltaEvent,
  type TokenUsage,
} from "@ag-ui/core";
import { type Event as AdkEvent } from "@google/adk";

import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  getAdkWorkflowEventFields,
} from "./adk-compat";
import {
  ADK_METADATA_KEY,
  ADK_RAW_EVENT_SOURCE,
  AG_UI_INTERNAL_STATE_KEYS,
  isAdkSpecialStateKey,
} from "./constants";
import type { ADKUsageProviderResolver } from "./config";
import { publicAdkEvent } from "./event-sanitizer";
import { clone, isRecord } from "./value-utils";

const INTERNAL_REQUEST_NAMES = new Set([
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
]);

interface OpenMessage {
  id: string;
}

export class ADKEventError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ADKEventError";
  }
}

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
  const workflow = getAdkWorkflowEventFields(event);
  return {
    [ADK_METADATA_KEY]: {
      eventId: event.id,
      invocationId: event.invocationId,
      author: event.author,
      branch: event.branch,
      nodeInfo: workflow.nodeInfo,
      isolationScope: workflow.isolationScope,
    },
  };
}

/** Stateful, one-run translator from raw ADK events to AG-UI events. */
export class ADKEventTranslator {
  private state: unknown;
  private openText?: OpenMessage;
  private openReasoning?: OpenMessage;
  private lastReasoningId?: string;
  private streamedText = "";
  private streamedReasoning = "";
  private readonly emittedToolCalls = new Set<string>();
  private readonly emittedAssistantMessages = new Set<string>();
  private readonly emittedMessageIds = new Set<string>();
  private readonly emittedReasoningSignatures = new Set<string>();
  private readonly usageEventIds = new Set<string>();
  private lastUsageReport?: { context: string; signature: string };
  private readonly usage = new Map<string, TokenUsage>();

  constructor(
    initialState: unknown,
    private readonly emitRawEvents = false,
    private readonly usageProvider: ADKUsageProviderResolver = "google",
  ) {
    this.state = clone(initialState);
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
      throw new ADKEventError(
        event.errorMessage || event.errorCode,
        event.errorCode,
      );
    }

    const output: AGUIEvent[] = [];
    const transportEvent = publicAdkEvent(event);
    let mapped = false;

    const stateEvent = this.translateState(event, transportEvent);
    if (stateEvent) {
      output.push(stateEvent);
      mapped = true;
    }

    for (const [partIndex, part] of (event.content?.parts ?? []).entries()) {
      if (part.text) {
        output.push(
          ...this.translateText(
            event,
            transportEvent,
            part.text,
            Boolean(part.thought),
          ),
        );
        mapped = true;

        const reasoningId = this.openReasoning?.id ?? this.lastReasoningId;
        if (part.thoughtSignature && reasoningId) {
          const encryptedValue = encodedSignature(part.thoughtSignature);
          const signatureKey = `${reasoningId}:${encryptedValue}`;
          if (this.emittedReasoningSignatures.has(signatureKey)) {
            continue;
          }
          this.emittedReasoningSignatures.add(signatureKey);
          output.push({
            type: EventType.REASONING_ENCRYPTED_VALUE,
            subtype: "message",
            entityId: reasoningId,
            encryptedValue,
            metadata: eventMetadata(event),
          });
        }
        continue;
      }

      if (part.functionCall?.name) {
        mapped = true;
        output.push(...this.closeMessages());
        // Progressive ADK streaming exposes partial function-call fragments and
        // later emits one complete aggregate call. Emitting the first fragment
        // would lose the completed arguments because call IDs are deduplicated.
        if (event.partial) {
          continue;
        }
        if (INTERNAL_REQUEST_NAMES.has(part.functionCall.name)) {
          continue;
        }

        const toolCallId =
          part.functionCall.id || `${event.id}:tool:${partIndex}`;
        if (this.emittedToolCalls.has(toolCallId)) {
          continue;
        }
        this.emittedToolCalls.add(toolCallId);
        if (!this.emittedAssistantMessages.has(event.id)) {
          this.emittedAssistantMessages.add(event.id);
          this.emittedMessageIds.add(event.id);
          output.push(
            {
              type: EventType.TEXT_MESSAGE_START,
              messageId: event.id,
              role: "assistant",
              ...(event.author ? { name: event.author } : {}),
              rawEvent: transportEvent,
              metadata: eventMetadata(event),
            },
            {
              type: EventType.TEXT_MESSAGE_END,
              messageId: event.id,
            },
          );
        }
        output.push(
          {
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: part.functionCall.name,
            parentMessageId: event.id,
            rawEvent: transportEvent,
            metadata: eventMetadata(event),
          },
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: json(part.functionCall.args ?? {}),
            metadata: eventMetadata(event),
          },
          {
            type: EventType.TOOL_CALL_END,
            toolCallId,
            metadata: eventMetadata(event),
          },
        );
        if (part.thoughtSignature) {
          output.push({
            type: EventType.REASONING_ENCRYPTED_VALUE,
            subtype: "tool-call",
            entityId: toolCallId,
            encryptedValue: encodedSignature(part.thoughtSignature),
            metadata: eventMetadata(event),
          });
        }
        continue;
      }

      if (part.functionResponse?.name) {
        mapped = true;
        output.push(...this.closeMessages());
        if (INTERNAL_REQUEST_NAMES.has(part.functionResponse.name)) {
          continue;
        }
        const toolCallId =
          part.functionResponse.id || `${event.id}:result:${partIndex}`;
        const messageId = `${event.id}:${toolCallId}`;
        this.emittedMessageIds.add(messageId);
        output.push({
          type: EventType.TOOL_CALL_RESULT,
          messageId,
          toolCallId,
          content: json(part.functionResponse.response ?? {}),
          role: "tool",
          rawEvent: transportEvent,
          metadata: eventMetadata(event),
        });
        continue;
      }

      if (
        part.executableCode ||
        part.codeExecutionResult ||
        part.inlineData ||
        part.fileData
      ) {
        output.push({
          type: EventType.RAW,
          event: { event: transportEvent, partIndex },
          source: ADK_RAW_EVENT_SOURCE,
          metadata: eventMetadata(event),
        });
        mapped = true;
      }
    }

    if (!event.partial) {
      output.push(...this.closeMessages());
      this.streamedText = "";
      this.streamedReasoning = "";
      this.lastReasoningId = undefined;
    }

    if (this.emitRawEvents || !mapped) {
      output.push({
        type: EventType.RAW,
        event: transportEvent,
        source: ADK_RAW_EVENT_SOURCE,
        metadata: eventMetadata(event),
      });
    }

    return output;
  }

  finish(): AGUIEvent[] {
    return this.closeMessages();
  }

  private translateText(
    event: AdkEvent,
    transportEvent: AdkEvent,
    text: string,
    thought: boolean,
  ): AGUIEvent[] {
    const output: AGUIEvent[] = [];
    if (thought) {
      output.push(...this.closeText());
    } else {
      output.push(...this.closeReasoning());
    }

    const previouslyEmitted = thought
      ? this.streamedReasoning
      : this.streamedText;
    const delta =
      !event.partial && text.startsWith(previouslyEmitted)
        ? text.slice(previouslyEmitted.length)
        : text;
    const nextAccumulated =
      !event.partial && text.startsWith(previouslyEmitted)
        ? text
        : previouslyEmitted + text;
    if (thought) {
      this.streamedReasoning = nextAccumulated;
    } else {
      this.streamedText = nextAccumulated;
    }

    if (!delta) {
      return output;
    }

    if (thought) {
      const messageId = `${event.id}:reasoning`;
      if (!this.openReasoning) {
        this.openReasoning = { id: messageId };
        this.lastReasoningId = messageId;
        this.emittedMessageIds.add(messageId);
        output.push(
          {
            type: EventType.REASONING_START,
            messageId,
            rawEvent: transportEvent,
            metadata: eventMetadata(event),
          },
          {
            type: EventType.REASONING_MESSAGE_START,
            messageId,
            role: "reasoning",
            metadata: eventMetadata(event),
          },
        );
      }
      output.push({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: this.openReasoning.id,
        delta,
        metadata: eventMetadata(event),
      });
      return output;
    }

    if (!this.openText) {
      this.openText = { id: event.id };
      this.emittedAssistantMessages.add(event.id);
      this.emittedMessageIds.add(event.id);
      output.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: event.id,
        role: "assistant",
        ...(event.author ? { name: event.author } : {}),
        rawEvent: transportEvent,
        metadata: eventMetadata(event),
      });
    }
    output.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: this.openText.id,
      delta,
      metadata: eventMetadata(event),
    });
    return output;
  }

  private translateState(
    event: AdkEvent,
    transportEvent: AdkEvent,
  ): StateDeltaEvent | undefined {
    const delta = event.actions?.stateDelta;
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
        op: Object.prototype.hasOwnProperty.call(state, key)
          ? "replace"
          : "add",
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
      rawEvent: transportEvent,
      metadata: eventMetadata(event),
    };
  }

  private closeText(): AGUIEvent[] {
    if (!this.openText) {
      return [];
    }
    const { id } = this.openText;
    this.openText = undefined;
    return [{ type: EventType.TEXT_MESSAGE_END, messageId: id }];
  }

  private closeReasoning(): AGUIEvent[] {
    if (!this.openReasoning) {
      return [];
    }
    const { id } = this.openReasoning;
    this.openReasoning = undefined;
    return [
      { type: EventType.REASONING_MESSAGE_END, messageId: id },
      { type: EventType.REASONING_END, messageId: id },
    ];
  }

  private closeMessages(): AGUIEvent[] {
    return [...this.closeText(), ...this.closeReasoning()];
  }

  private collectUsage(event: AdkEvent): void {
    if (
      event.content?.parts?.some((part) => part.functionResponse !== undefined)
    ) {
      // A tool result separates two model turns that may legitimately have the
      // same token counts.
      this.lastUsageReport = undefined;
    }
    const usage = event.usageMetadata;
    // Progressive chunks are followed by a terminal aggregate carrying their
    // usage. Event ids also protect callers that replay a raw event; the report
    // signature below handles non-progressive ADK aggregates that use distinct
    // ids for repeated copies of the same model-turn usage.
    if (!usage || event.partial || this.usageEventIds.has(event.id)) {
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
    const context = JSON.stringify([
      event.invocationId,
      event.author,
      event.branch,
      provider,
      model,
    ]);
    const signature = JSON.stringify([
      usage.promptTokenCount,
      usage.candidatesTokenCount,
      usage.totalTokenCount,
      usage.thoughtsTokenCount,
      usage.cachedContentTokenCount,
    ]);
    if (
      this.lastUsageReport?.context === context &&
      this.lastUsageReport.signature === signature
    ) {
      return;
    }
    this.lastUsageReport = { context, signature };
    const usageKey = JSON.stringify([provider, model]);
    let aggregate = this.usage.get(usageKey);
    if (!aggregate) {
      aggregate = {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      };
      this.usage.set(usageKey, aggregate);
    }
    if (typeof usage.promptTokenCount === "number") {
      aggregate.inputTokens =
        (aggregate.inputTokens ?? 0) + usage.promptTokenCount;
    }
    if (typeof usage.candidatesTokenCount === "number") {
      aggregate.outputTokens =
        (aggregate.outputTokens ?? 0) + usage.candidatesTokenCount;
    }
    if (typeof usage.totalTokenCount === "number") {
      aggregate.totalTokens =
        (aggregate.totalTokens ?? 0) + usage.totalTokenCount;
    }
    if (typeof usage.thoughtsTokenCount === "number") {
      aggregate.reasoningTokens =
        (aggregate.reasoningTokens ?? 0) + usage.thoughtsTokenCount;
    }
    if (typeof usage.cachedContentTokenCount === "number") {
      aggregate.cachedInputTokens =
        (aggregate.cachedInputTokens ?? 0) + usage.cachedContentTokenCount;
    }
  }
}
