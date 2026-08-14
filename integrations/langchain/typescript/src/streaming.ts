import {
  EventType,
  TextMessageChunkEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  BaseEvent,
} from "@ag-ui/client";
import { TokenUsage, tokenUsageFromLangChainMetadata } from "@ag-ui/core";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessageChunk,
} from "@langchain/core/messages";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import { randomUUID } from "crypto";

/**
 * LangChain response types that can be returned from chainFn
 */
export type LangChainResponse =
  | string
  | AIMessage
  | AIMessageChunk
  | BaseMessageChunk
  | IterableReadableStream<BaseMessageChunk>
  | IterableReadableStream<AIMessageChunk>;

/**
 * Helper type guards
 */
function isAIMessage(obj: any): obj is AIMessage {
  return obj?.constructor?.name === "AIMessage";
}

function isAIMessageChunk(obj: any): obj is AIMessageChunk {
  return obj?.constructor?.name === "AIMessageChunk";
}

function isBaseMessageChunk(obj: any): obj is BaseMessageChunk {
  return obj?.constructor?.name === "BaseMessageChunk";
}

function isStream(obj: any): obj is IterableReadableStream<any> {
  return obj && typeof obj.getReader === "function";
}

/**
 * Converts LangChain response to AG-UI events
 */
export async function* streamLangChainResponse(
  response: LangChainResponse,
  usageSink?: (usage: TokenUsage) => void,
): AsyncGenerator<BaseEvent> {
  // Report provider-reported numeric token usage from a message/chunk to the
  // optional sink. Reads only `usage_metadata` (+ model_name label) — never
  // content. No-op when usage is absent or no sink was provided.
  const reportUsage = (msg: any): void => {
    if (!usageSink) return;
    const usage = tokenUsageFromLangChainMetadata(msg?.usage_metadata, {
      model: msg?.response_metadata?.model_name,
    });
    if (usage) usageSink(usage);
  };

  // 1. Handle string response
  if (typeof response === "string") {
    const messageId = randomUUID();
    yield {
      type: EventType.TEXT_MESSAGE_CHUNK,
      role: "assistant",
      messageId,
      delta: response,
    } as TextMessageChunkEvent;
    return;
  }

  // 2. Handle AIMessage (complete message with content and tool calls)
  if (isAIMessage(response)) {
    reportUsage(response);
    const messageId = randomUUID();

    // Emit text content if present
    if (response.content) {
      yield {
        type: EventType.TEXT_MESSAGE_CHUNK,
        role: "assistant",
        messageId,
        delta: String(response.content),
      } as TextMessageChunkEvent;
    }

    // Emit tool calls if present
    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const toolCall of response.tool_calls) {
        const toolCallId = toolCall.id || randomUUID();

        yield {
          type: EventType.TOOL_CALL_START,
          parentMessageId: messageId,
          toolCallId,
          toolCallName: toolCall.name,
        } as ToolCallStartEvent;

        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: JSON.stringify(toolCall.args),
        } as ToolCallArgsEvent;

        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId,
        } as ToolCallEndEvent;
      }
    }
    return;
  }

  // 3. Handle BaseMessageChunk (single chunk)
  if (isBaseMessageChunk(response)) {
    if (response.content) {
      const messageId = randomUUID();
      yield {
        type: EventType.TEXT_MESSAGE_CHUNK,
        role: "assistant",
        messageId,
        delta: String(response.content),
      } as TextMessageChunkEvent;
    }
    return;
  }

  // 4. Handle streaming responses
  if (isStream(response)) {
    const reader = response.getReader();
    let mode: "text" | "tool" | null = null;
    let currentMessageId = randomUUID();
    let currentToolCallId: string | undefined;
    let currentToolCallName: string | undefined;

    // Tool call tracking
    const toolCallState = {
      id: null as string | null,
      name: null as string | null,
      index: null as number | null,
      prevIndex: null as number | null,
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // LangChain attaches usage_metadata to the final streamed chunk; report
        // it as it arrives (no-op on chunks without it).
        reportUsage(value);

        let hasToolCall = false;
        let toolCallId: string | undefined;
        let toolCallName: string | undefined;
        let toolCallArgs: string | undefined;
        let textContent = "";

        // Extract content from the chunk
        if (value && value.content) {
          textContent = Array.isArray(value.content)
            ? ((value.content[0] as any)?.text ?? "")
            : String(value.content);
        }

        // Check for tool calls in AIMessageChunk
        if (isAIMessageChunk(value)) {
          const chunk = value.tool_call_chunks?.[0];
          if (chunk) {
            hasToolCall = true;
            toolCallArgs = chunk.args;
            if (chunk.name) toolCallState.name = chunk.name;
            if (chunk.index != null) {
              toolCallState.index = chunk.index;
              if (toolCallState.prevIndex == null) {
                toolCallState.prevIndex = chunk.index;
              }
            }
            if (chunk.id) {
              toolCallState.id =
                chunk.index != null ? `${chunk.id}-idx-${chunk.index}` : chunk.id;
            }
            toolCallName = toolCallState.name || undefined;
            toolCallId = toolCallState.id || undefined;
          }
        }
        // Check for tool calls in BaseMessageChunk
        else if (isBaseMessageChunk(value)) {
          const chunk = (value as any).additional_kwargs?.tool_calls?.[0];
          if (chunk?.function) {
            hasToolCall = true;
            toolCallName = chunk.function.name;
            toolCallId = chunk.id;
            toolCallArgs = chunk.function.arguments;
          }
        }

        // Mode transitions
        if (mode === "text" && (hasToolCall || done)) {
          mode = null;
        } else if (mode === "tool" && (!hasToolCall || done)) {
          if (currentToolCallId) {
            yield {
              type: EventType.TOOL_CALL_END,
              toolCallId: currentToolCallId,
            } as ToolCallEndEvent;
          }
          mode = null;
        }

        // Start new mode
        if (mode === null) {
          if (hasToolCall && toolCallId && toolCallName) {
            mode = "tool";
            currentToolCallId = toolCallId;
            currentToolCallName = toolCallName;

            yield {
              type: EventType.TOOL_CALL_START,
              parentMessageId: currentMessageId,
              toolCallId,
              toolCallName,
            } as ToolCallStartEvent;
          } else if (textContent) {
            mode = "text";
            // Text chunks don't need explicit start event in AG-UI
          }
        }

        // Emit content
        if (mode === "text" && textContent) {
          yield {
            type: EventType.TEXT_MESSAGE_CHUNK,
            role: "assistant",
            messageId: currentMessageId,
            delta: textContent,
          } as TextMessageChunkEvent;
        } else if (mode === "tool" && toolCallArgs) {
          // Handle multiple tool calls with different indices
          if (
            toolCallState.index !== toolCallState.prevIndex &&
            currentToolCallId
          ) {
            yield {
              type: EventType.TOOL_CALL_END,
              toolCallId: currentToolCallId,
            } as ToolCallEndEvent;

            currentToolCallId = toolCallId;
            yield {
              type: EventType.TOOL_CALL_START,
              parentMessageId: currentMessageId,
              toolCallId: currentToolCallId!,
              toolCallName: currentToolCallName!,
            } as ToolCallStartEvent;

            toolCallState.prevIndex = toolCallState.index;
          }

          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: currentToolCallId!,
            delta: toolCallArgs,
          } as ToolCallArgsEvent;
        }
      }

      // Final cleanup
      if (mode === "tool" && currentToolCallId) {
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId: currentToolCallId,
        } as ToolCallEndEvent;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  // Unsupported type - throw error
  throw new Error(
    `Unsupported LangChain response type: ${typeof response}`
  );
}
