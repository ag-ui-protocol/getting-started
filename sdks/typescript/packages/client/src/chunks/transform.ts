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
}

interface ToolCallFields {
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

interface ReasoningMessageFields {
  messageId: string;
}

/**
 * Spreads a chunk's metadata onto an event synthesized from that chunk.
 *
 * Applied to every event derived from a chunk, never to the synthetic `*_END`
 * that closes the *previous* message — that is what stops a chunk's metadata
 * leaking onto the message it is closing when one chunk ends one message and
 * begins another.
 *
 * A chunk that expands into both a start and a content event stamps the same
 * metadata twice. That is harmless: the merge is last-write-wins per key, so
 * applying an identical object twice is indistinguishable from applying it once,
 * and stamping both is what keeps the metadata attached when only one of the two
 * is emitted.
 */
const withChunkMetadata = <T extends BaseEvent>(event: T, chunk: BaseEvent): T =>
  chunk.metadata === undefined ? event : { ...event, metadata: chunk.metadata };

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
            return [event];
          case EventType.TEXT_MESSAGE_CHUNK: {
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
              };
              mode = "text";

              const textMessageStartEvent = withChunkMetadata(
                {
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: messageChunkEvent.messageId,
                  role: messageChunkEvent.role || "assistant",
                  ...(messageChunkEvent.name !== undefined && { name: messageChunkEvent.name }),
                } as TextMessageStartEvent,
                messageChunkEvent,
              );

              textMessageResult.push(textMessageStartEvent);

              log?.event("TRANSFORM", "TEXT_MESSAGE_START", textMessageStartEvent, {
                messageId: messageChunkEvent.messageId,
              });
            }

            if (messageChunkEvent.delta !== undefined) {
              const textMessageContentEvent = withChunkMetadata(
                {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: textMessageFields!.messageId,
                  delta: messageChunkEvent.delta,
                } as TextMessageContentEvent,
                messageChunkEvent,
              );

              textMessageResult.push(textMessageContentEvent);

              log?.event("TRANSFORM", "TEXT_MESSAGE_CONTENT", textMessageContentEvent, {
                messageId: textMessageFields!.messageId,
              });
            }

            // A continuation chunk carrying only metadata — a final chunk with
            // usage and a finish reason, the case the merge design exists for —
            // synthesizes nothing above. Emit a zero-delta content event so the
            // metadata still reaches the reducer. It cannot ride the synthetic
            // `*_END` instead: `finalize` discards the events it creates, so the
            // last message of a stream would lose it.
            if (textMessageResult.length === 0 && messageChunkEvent.metadata !== undefined) {
              textMessageResult.push({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: textMessageFields!.messageId,
                delta: "",
                metadata: messageChunkEvent.metadata,
              } as TextMessageContentEvent);
            }
            return textMessageResult;
          }
          case EventType.TOOL_CALL_CHUNK: {
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
              };
              mode = "tool";

              const toolCallStartEvent = withChunkMetadata(
                {
                  type: EventType.TOOL_CALL_START,
                  toolCallId: toolCallChunkEvent.toolCallId,
                  toolCallName: toolCallChunkEvent.toolCallName,
                  parentMessageId: toolCallChunkEvent.parentMessageId,
                } as ToolCallStartEvent,
                toolCallChunkEvent,
              );

              toolMessageResult.push(toolCallStartEvent);

              log?.event("TRANSFORM", "TOOL_CALL_START", toolCallStartEvent, {
                toolCallId: toolCallChunkEvent.toolCallId,
                toolCallName: toolCallChunkEvent.toolCallName,
              });
            }

            if (toolCallChunkEvent.delta !== undefined) {
              const toolCallArgsEvent = withChunkMetadata(
                {
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: toolCallFields!.toolCallId,
                  delta: toolCallChunkEvent.delta,
                } as ToolCallArgsEvent,
                toolCallChunkEvent,
              );

              toolMessageResult.push(toolCallArgsEvent);

              log?.event("TRANSFORM", "TOOL_CALL_ARGS", toolCallArgsEvent, {
                toolCallId: toolCallFields!.toolCallId,
              });
            }

            // Same as the text case above.
            if (toolMessageResult.length === 0 && toolCallChunkEvent.metadata !== undefined) {
              toolMessageResult.push({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: toolCallFields!.toolCallId,
                delta: "",
                metadata: toolCallChunkEvent.metadata,
              } as ToolCallArgsEvent);
            }
            return toolMessageResult;
          }
          case EventType.REASONING_MESSAGE_CHUNK: {
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
              };
              mode = "reasoning";

              const reasoningMessageStartEvent = withChunkMetadata(
                {
                  type: EventType.REASONING_MESSAGE_START,
                  messageId: reasoningChunkEvent.messageId,
                } as ReasoningMessageStartEvent,
                reasoningChunkEvent,
              );
              reasoningMessageResult.push(reasoningMessageStartEvent);

              log?.event("TRANSFORM", "REASONING_MESSAGE_START", reasoningMessageStartEvent, {
                messageId: reasoningChunkEvent.messageId,
              });
            }

            if (reasoningChunkEvent.delta !== undefined) {
              const reasoningMessageContentEvent = withChunkMetadata(
                {
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: reasoningMessageFields!.messageId,
                  delta: reasoningChunkEvent.delta,
                } as ReasoningMessageContentEvent,
                reasoningChunkEvent,
              );

              reasoningMessageResult.push(reasoningMessageContentEvent);

              log?.event("TRANSFORM", "REASONING_MESSAGE_CONTENT", reasoningMessageContentEvent, {
                messageId: reasoningMessageFields!.messageId,
              });
            }

            // Same as the text case above.
            if (reasoningMessageResult.length === 0 && reasoningChunkEvent.metadata !== undefined) {
              reasoningMessageResult.push({
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: reasoningMessageFields!.messageId,
                delta: "",
                metadata: reasoningChunkEvent.metadata,
              } as ReasoningMessageContentEvent);
            }
            return reasoningMessageResult;
          }
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
