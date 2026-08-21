import {
  EventType,
  type AGUIEvent,
  type AssistantMessage,
  type Message,
  type ReasoningEncryptedValueEvent,
  type ReasoningMessageContentEvent,
  type ReasoningMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";

import { ADK_METADATA_KEY } from "./constants";
import { clone, isRecord } from "./value-utils";

function adkAuthor(event: AGUIEvent): string | undefined {
  const metadata = event.metadata?.[ADK_METADATA_KEY];
  return isRecord(metadata) && typeof metadata.author === "string"
    ? metadata.author
    : undefined;
}

/** Builds the protocol checkpoint required at an interrupt boundary. */
export class MessageSnapshot {
  private messages: Message[];

  constructor(initial: readonly Message[]) {
    this.messages = clone([...initial]);
  }

  apply(event: AGUIEvent): void {
    switch (event.type) {
      case EventType.MESSAGES_SNAPSHOT:
        this.messages = clone(event.messages);
        return;
      case EventType.TEXT_MESSAGE_START:
        this.startText(event);
        return;
      case EventType.TEXT_MESSAGE_CONTENT:
        this.appendText(event);
        return;
      case EventType.TOOL_CALL_START:
        this.startToolCall(event);
        return;
      case EventType.TOOL_CALL_ARGS:
        this.appendToolArgs(event);
        return;
      case EventType.TOOL_CALL_RESULT:
        this.addToolResult(event);
        return;
      case EventType.REASONING_MESSAGE_START:
        this.startReasoning(event);
        return;
      case EventType.REASONING_MESSAGE_CONTENT:
        this.appendReasoning(event);
        return;
      case EventType.REASONING_ENCRYPTED_VALUE:
        this.setReasoningSignature(event);
        return;
      default:
        return;
    }
  }

  getMessages(): Message[] {
    return clone(this.messages);
  }

  private startText(event: TextMessageStartEvent): void {
    if (this.messages.some((message) => message.id === event.messageId)) {
      return;
    }
    this.messages.push({
      id: event.messageId,
      role: event.role,
      content: "",
      ...(event.name ? { name: event.name } : {}),
      ...(event.metadata ? { metadata: clone(event.metadata) } : {}),
    });
  }

  private appendText(event: TextMessageContentEvent): void {
    const message = this.messages.find(
      (candidate) => candidate.id === event.messageId,
    );
    if (!message) {
      return;
    }
    message.content = `${typeof message.content === "string" ? message.content : ""}${event.delta}`;
  }

  private startToolCall(event: ToolCallStartEvent): void {
    const parentId = event.parentMessageId ?? `${event.toolCallId}:assistant`;
    const existing = this.messages.find((message) => message.id === parentId);
    let parent: AssistantMessage | undefined =
      existing?.role === "assistant" ? existing : undefined;
    if (!parent) {
      parent = {
        id: parentId,
        role: "assistant",
        content: "",
        ...(adkAuthor(event) ? { name: adkAuthor(event) } : {}),
        toolCalls: [],
        ...(event.metadata ? { metadata: clone(event.metadata) } : {}),
      };
      this.messages.push(parent);
    }
    parent.toolCalls ??= [];
    if (!parent.toolCalls.some((call) => call.id === event.toolCallId)) {
      parent.toolCalls.push({
        id: event.toolCallId,
        type: "function",
        function: { name: event.toolCallName, arguments: "" },
        ...(event.metadata ? { metadata: clone(event.metadata) } : {}),
      });
    }
  }

  private appendToolArgs(event: ToolCallArgsEvent): void {
    for (const message of this.messages) {
      if (message.role !== "assistant") {
        continue;
      }
      const call = message.toolCalls?.find(
        (candidate) => candidate.id === event.toolCallId,
      );
      if (call) {
        call.function.arguments += event.delta;
        return;
      }
    }
  }

  private addToolResult(event: ToolCallResultEvent): void {
    const existing = this.messages.find(
      (message) => message.id === event.messageId,
    );
    if (existing) {
      existing.content = event.content;
      return;
    }
    this.messages.push({
      id: event.messageId,
      role: "tool",
      toolCallId: event.toolCallId,
      content: event.content,
      ...(typeof event.error === "string" ? { error: event.error } : {}),
      ...(event.metadata ? { metadata: clone(event.metadata) } : {}),
    });
  }

  private startReasoning(event: ReasoningMessageStartEvent): void {
    if (this.messages.some((message) => message.id === event.messageId)) {
      return;
    }
    this.messages.push({
      id: event.messageId,
      role: "reasoning",
      content: "",
      ...(event.metadata ? { metadata: clone(event.metadata) } : {}),
    });
  }

  private appendReasoning(event: ReasoningMessageContentEvent): void {
    const message = this.messages.find(
      (candidate) => candidate.id === event.messageId,
    );
    if (message?.role === "reasoning") {
      message.content += event.delta;
    }
  }

  private setReasoningSignature(event: ReasoningEncryptedValueEvent): void {
    if (event.subtype === "tool-call") {
      for (const message of this.messages) {
        if (message.role !== "assistant") {
          continue;
        }
        const call = message.toolCalls?.find(
          (candidate) => candidate.id === event.entityId,
        );
        if (call) {
          call.encryptedValue = event.encryptedValue;
          return;
        }
      }
      return;
    }
    const message = this.messages.find(
      (candidate) => candidate.id === event.entityId,
    );
    if (message?.role === "reasoning") {
      message.encryptedValue = event.encryptedValue;
    }
  }
}
