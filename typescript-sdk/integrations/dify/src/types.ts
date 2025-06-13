import { ToolCall } from "@ag-ui/core";

// Dify 原始消息结构
export interface DifyMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: DifyToolCall[]; // 仅 assistant 消息可能有工具调用
  tool_call_id?: string; // 仅 tool 消息需要关联工具调用ID
}

// Dify 工具调用结构
export interface DifyToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串
}

// Dify 流式响应类型
export interface DifyStreamResponse {
  type: "text" | "tool_call_start" | "tool_call_args" | "tool_call_end" | "message_end";
  messageId?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: string;
  result?: string;
}

// Dify 客户端配置
export interface DifyClientConfig {
  apiKey: string;
  baseUrl?: string;
}

// AG-UI 消息类型扩展
export interface AGUIMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: {
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }[];
  toolCallId?: string;
} 