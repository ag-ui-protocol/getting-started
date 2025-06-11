import { Message } from "@ag-ui/core";
import { DifyMessage, DifyToolCall, AGUIMessage } from "./types";

/**
 * 将 Dify 消息转换为 AG-UI 标准消息
 */
export function difyMessagesToAgui(messages: DifyMessage[]): AGUIMessage[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "user":
        return {
          id: msg.id,
          role: "user",
          content: msg.content,
        };
      case "assistant":
        return {
          id: msg.id,
          role: "assistant",
          content: msg.content,
          toolCalls: msg.tool_calls?.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })) || [],
        };
      case "system":
        return {
          id: msg.id,
          role: "system",
          content: msg.content,
        };
      case "tool":
        return {
          id: msg.id,
          role: "tool",
          content: msg.content,
          toolCallId: msg.tool_call_id!, // 工具消息必须关联 tool_call_id
        };
      default:
        throw new Error(`Unsupported Dify message role: ${msg.role}`);
    }
  });
}

/**
 * 将 AG-UI 消息转换为 Dify 接受的格式（用于反向交互）
 */
export function aguiMessagesToDify(messages: AGUIMessage[]): DifyMessage[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "user":
        return {
          id: msg.id,
          role: "user",
          content: msg.content,
        };
      case "assistant":
        return {
          id: msg.id,
          role: "assistant",
          content: msg.content,
          tool_calls: msg.toolCalls?.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })) || [],
        };
      case "system":
        return {
          id: msg.id,
          role: "system",
          content: msg.content,
        };
      case "tool":
        return {
          id: msg.id,
          role: "tool",
          content: msg.content,
          tool_call_id: msg.toolCallId!,
        };
      default:
        throw new Error(`Unsupported AG-UI message role: ${msg.role}`);
    }
  });
} 