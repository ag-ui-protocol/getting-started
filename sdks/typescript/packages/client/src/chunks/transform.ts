import { mergeMap, Observable, finalize } from "rxjs";
import {
  BaseEvent,
  TextMessageChunkEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallChunkEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ReasoningMessageChunkEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
} from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

interface TextMessageFields {
  messageId: string;
  name?: string;
  subagentId?: string;
}

interface ToolCallFields {
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
  subagentId?: string;
}

interface ReasoningMessageFields {
  messageId: string;
  subagentId?: string;
}

export const transformChunks =
  (debugLogger?: DebugLoggerInput) =>
  (events$: Observable<BaseEvent>): Observable<BaseEvent> => {
    const log = resolveDebugLogger(debugLogger);
    let textMessageFields: TextMessageFields | undefined;
    let toolCallFields: ToolCallFields | undefined;
    let reasoningMessageFields: ReasoningMessageFields | undefined;
    let mode: "text" | "tool" | "reasoning" | undefined;

    const closeTextMessage = () => {
      if (!textMessageFields || mode !== "text") {
        throw new Error("No text message to close");
      }
      const event = {
        type: EventType.TEXT_MESSAGE_END,
        messageId: textMessageFields.messageId,
      } as TextMessageEndEvent;
      mode = undefined;
      textMessageFields = undefined;

      log?.event("TRANSFORM", "TEXT_MESSAGE_END", event, {
        messageId: event.messageId,
      });

      return event;
    };

    const closeToolCall = () => {
      if (!toolCallFields || mode !== "tool") {
        throw new Error("No tool call to close");
      }
      const event = {
        type: EventType.TOOL_CALL_END,
        toolCallId: toolCallFields.toolCallId,
      } as ToolCallEndEvent;
      mode = undefined;
      toolCallFields = undefined;

      log?.event("TRANSFORM", "TOOL_CALL_END", event, {
        toolCallId: event.toolCallId,
      });

      return event;
    };

    const closeReasoningMessage = () => {
      if (!reasoningMessageFields || mode !== "reasoning") {
        throw new Error("No reasoning message to close");
      }
      const event = {
        type: EventType.REASONING_MESSAGE_END,
        messageId: reasoningMessageFields.messageId,
      } as ReasoningMessageEndEvent;
      mode = undefined;
      reasoningMessageFields = undefined;

      log?.event("TRANSFORM", "REASONING_MESSAGE_END", event, {
        messageId: event.messageId,
      });

      return event;
    };

    const closePendingEvent = () => {
      if (mode === "text") {
        return [closeTextMessage()];
      }
      if (mode === "tool") {
        return [closeToolCall()];
      }
      if (mode === "reasoning") {
        return [closeReasoningMessage()];
      }
      return [];
    };

    return events$.pipe(
      mergeMap((event) => {
        switch (event.type) {
          case EventType.TEXT_MESSAGE_START:
          case EventType.TEXT_MESSAGE_CONTENT:
          case EventType.TEXT_MESSAGE_END:
          case EventType.TOOL_CALL_START:
          case EventType.TOOL_CALL_ARGS:
          case EventType.TOOL_CALL_END:
          case EventType.TOOL_CALL_RESULT:
          case EventType.STATE_SNAPSHOT:
          case EventType.STATE_DELTA:
          case EventType.MESSAGES_SNAPSHOT:
          case EventType.CUSTOM:
          case EventType.RUN_STARTED:
          case EventType.RUN_FINISHED:
          case EventType.RUN_ERROR:
          case EventType.STEP_STARTED:
          case EventType.STEP_FINISHED:
          case EventType.THINKING_START:
          case EventType.THINKING_END:
          case EventType.THINKING_TEXT_MESSAGE_START:
          case EventType.THINKING_TEXT_MESSAGE_CONTENT:
          case EventType.THINKING_TEXT_MESSAGE_END:
          case EventType.REASONING_START:
          case EventType.REASONING_MESSAGE_START:
          case EventType.REASONING_MESSAGE_CONTENT:
          case EventType.REASONING_MESSAGE_END:
          case EventType.REASONING_END:
            return [...closePendingEvent(), event];
          case EventType.RAW:
          case EventType.ACTIVITY_SNAPSHOT:
          case EventType.ACTIVITY_DELTA:
          case EventType.REASONING_ENCRYPTED_VALUE:
          case EventType.SUBAGENT_STARTED:
          case EventType.SUBAGENT_FINISHED:
          case EventType.SUBAGENT_ERROR:
            return [event];
          case EventType.TEXT_MESSAGE_CHUNK:
            const messageChunkEvent = event as TextMessageChunkEvent;
            const textMessageResult = [];
            if (
              // we are not in a text message
              mode !== "text" ||
              // or the message id is different
              (messageChunkEvent.messageId !== undefined &&
                messageChunkEvent.messageId !== textMessageFields?.messageId)
            ) {
              // close the current message if any
              textMessageResult.push(...closePendingEvent());
            }

            // we are not in a text message, start a new one
            if (mode !== "text") {
              if (messageChunkEvent.messageId === undefined) {
                throw new Error("First TEXT_MESSAGE_CHUNK must have a messageId");
              }

              textMessageFields = {
                messageId: messageChunkEvent.messageId,
                name: messageChunkEvent.name,
                subagentId: messageChunkEvent.subagentId,
              };
              mode = "text";

              const textMessageStartEvent = {
                type: EventType.TEXT_MESSAGE_START,
                messageId: messageChunkEvent.messageId,
                role: messageChunkEvent.role || "assistant",
                ...(messageChunkEvent.name !== undefined && { name: messageChunkEvent.name }),
                ...(messageChunkEvent.subagentId !== undefined && {
                  subagentId: messageChunkEvent.subagentId,
                }),
              } as TextMessageStartEvent;

              textMessageResult.push(textMessageStartEvent);

              log?.event("TRANSFORM", "TEXT_MESSAGE_START", textMessageStartEvent, {
                messageId: messageChunkEvent.messageId,
              });
            }

            if (messageChunkEvent.delta !== undefined) {
              const textMessageContentEvent = {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: textMessageFields!.messageId,
                delta: messageChunkEvent.delta,
              } as TextMessageContentEvent;

              textMessageResult.push(textMessageContentEvent);

              log?.event("TRANSFORM", "TEXT_MESSAGE_CONTENT", textMessageContentEvent, {
                messageId: textMessageFields!.messageId,
              });
            }

            return textMessageResult;
          case EventType.TOOL_CALL_CHUNK:
            const toolCallChunkEvent = event as ToolCallChunkEvent;
            const toolMessageResult = [];
            if (
              // we are not in a text message
              mode !== "tool" ||
              // or the tool call id is different
              (toolCallChunkEvent.toolCallId !== undefined &&
                toolCallChunkEvent.toolCallId !== toolCallFields?.toolCallId)
            ) {
              // close the current message if any
              toolMessageResult.push(...closePendingEvent());
            }

            if (mode !== "tool") {
              if (toolCallChunkEvent.toolCallId === undefined) {
                throw new Error("First TOOL_CALL_CHUNK must have a toolCallId");
              }
              if (toolCallChunkEvent.toolCallName === undefined) {
                throw new Error("First TOOL_CALL_CHUNK must have a toolCallName");
              }
              toolCallFields = {
                toolCallId: toolCallChunkEvent.toolCallId,
                toolCallName: toolCallChunkEvent.toolCallName,
                parentMessageId: toolCallChunkEvent.parentMessageId,
                subagentId: toolCallChunkEvent.subagentId,
              };
              mode = "tool";

              const toolCallStartEvent = {
                type: EventType.TOOL_CALL_START,
                toolCallId: toolCallChunkEvent.toolCallId,
                toolCallName: toolCallChunkEvent.toolCallName,
                parentMessageId: toolCallChunkEvent.parentMessageId,
                ...(toolCallChunkEvent.subagentId !== undefined && {
                  subagentId: toolCallChunkEvent.subagentId,
                }),
              } as ToolCallStartEvent;

              toolMessageResult.push(toolCallStartEvent);

              log?.event("TRANSFORM", "TOOL_CALL_START", toolCallStartEvent, {
                toolCallId: toolCallChunkEvent.toolCallId,
                toolCallName: toolCallChunkEvent.toolCallName,
              });
            }

            if (toolCallChunkEvent.delta !== undefined) {
              const toolCallArgsEvent = {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: toolCallFields!.toolCallId,
                delta: toolCallChunkEvent.delta,
              } as ToolCallArgsEvent;

              toolMessageResult.push(toolCallArgsEvent);

              log?.event("TRANSFORM", "TOOL_CALL_ARGS", toolCallArgsEvent, {
                toolCallId: toolCallFields!.toolCallId,
              });
            }

            return toolMessageResult;
          case EventType.REASONING_MESSAGE_CHUNK:
            const reasoningChunkEvent = event as ReasoningMessageChunkEvent;
            const reasoningMessageResult = [];
            if (
              // we are not in a reasoning message
              mode !== "reasoning" ||
              // or the message id is different
              (reasoningChunkEvent.messageId &&
                reasoningChunkEvent.messageId !== reasoningMessageFields?.messageId)
            ) {
              // close the current message if any
              reasoningMessageResult.push(...closePendingEvent());
            }

            // we are not in a reasoning message, start a new one
            if (mode !== "reasoning") {
              if (reasoningChunkEvent.messageId === undefined) {
                throw new Error("First REASONING_MESSAGE_CHUNK must have a messageId");
              }

              reasoningMessageFields = {
                messageId: reasoningChunkEvent.messageId,
                subagentId: reasoningChunkEvent.subagentId,
              };
              mode = "reasoning";

              const reasoningMessageStartEvent = {
                type: EventType.REASONING_MESSAGE_START,
                messageId: reasoningChunkEvent.messageId,
                role: "reasoning",
                ...(reasoningChunkEvent.subagentId !== undefined && {
                  subagentId: reasoningChunkEvent.subagentId,
                }),
              } as ReasoningMessageStartEvent;
              reasoningMessageResult.push(reasoningMessageStartEvent);

              log?.event("TRANSFORM", "REASONING_MESSAGE_START", reasoningMessageStartEvent, {
                messageId: reasoningChunkEvent.messageId,
              });
            }

            if (reasoningChunkEvent.delta !== undefined) {
              const reasoningMessageContentEvent = {
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: reasoningMessageFields!.messageId,
                delta: reasoningChunkEvent.delta,
              } as ReasoningMessageContentEvent;

              reasoningMessageResult.push(reasoningMessageContentEvent);

              log?.event("TRANSFORM", "REASONING_MESSAGE_CONTENT", reasoningMessageContentEvent, {
                messageId: reasoningMessageFields!.messageId,
              });
            }

            return reasoningMessageResult;
        }
        const _exhaustiveCheck: never = event.type;
        return [];
      }),
      finalize(() => {
        // This ensures that we close any pending events when the source observable completes
        closePendingEvent();
      }),
    );
  };
