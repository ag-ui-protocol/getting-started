import { Message } from "@ag-ui/client";
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

/**
 * Converts AG-UI Message to LangChain BaseMessage
 */
export function convertAGUIMessageToLangChain(message: Message): BaseMessage {
  // User message
  if (message.role === "user") {
    // Handle string content
    if (typeof message.content === "string") {
      return new HumanMessage(message.content);
    }
    // Handle array content (extract text parts)
    if (Array.isArray(message.content)) {
      const textContent = message.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n");
      return new HumanMessage(textContent);
    }
    return new HumanMessage("");
  }

  // Assistant message
  if (message.role === "assistant") {
    const toolCalls = message.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments),
    })) || [];

    return new AIMessage({
      content: message.content || "",
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }

  // Tool/Function result message
  if (message.role === "tool") {
    return new ToolMessage({
      content: message.content,
      tool_call_id: message.toolCallId,
      // Carry the AG-UI failure signal onto LangChain's tool-result status, so a
      // client-reported tool failure is not delivered to the model as a success.
      status: message.error ? "error" : "success",
    });
  }

  // System message
  if (message.role === "system") {
    return new SystemMessage(message.content as string);
  }

  // Fallback - treat as human message
  return new HumanMessage(String(message.content || ""));
}

/**
 * Converts array of AG-UI Messages to LangChain BaseMessages
 */
export function convertAGUIMessagesToLangChain(messages: Message[]): BaseMessage[] {
  return messages.map(convertAGUIMessageToLangChain);
}
