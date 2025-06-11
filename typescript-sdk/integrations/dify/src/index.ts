import { AbstractAgent, RunAgentInput, AGUIEvent, EventType, Tool } from "@ag-ui/client";
import { Observable, from } from "rxjs";

// 合并 types.ts 内容
export interface DifyClientConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface DifyStreamResponse {
  event: string;
  conversation_id?: string;
  message_id?: string;
  answer?: string;
  data?: any;
  metadata?: any;
}

// 合并 utils.ts 内容
export function difyMessagesToAgui(messages: any[]): any[] {
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));
}

export function aguiMessagesToDify(messages: any[]): any[] {
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));
}

// 简单的Dify客户端实现
class DifyClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: DifyClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.dify.ai/v1";
    console.log("DifyClient 配置:", {
      baseUrl: this.baseUrl,
      apiKeyLength: this.apiKey?.length || 0,
      apiKeyPrefix: this.apiKey?.substring(0, 4) + "..." // 只打印前4位，保护密钥安全
    });
  }

  async *streamChat(params: {
    messages: any[];
    tools?: any[];
  }): AsyncGenerator<DifyStreamResponse> {
    const url = `${this.baseUrl}/chat-messages`;
    
    // 从消息中提取最后一条用户消息作为 query
    const lastUserMessage = [...params.messages].reverse().find((msg: { role: string }) => msg.role === 'user');
    const body = {
      inputs: {},
      query: lastUserMessage?.content || '',
      response_mode: "streaming",
      conversation_id: "", // 如果需要保持对话上下文，这里需要传入
      user: "ag-ui-user", // 可以自定义用户标识
    };
    
    console.log("Dify API 请求详情:", {
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body, null, 2)
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error("Dify API 错误响应:", {
        status: response.status,
        statusText: response.statusText,
        url: response.url
      });
      throw new Error(`Dify API error: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Failed to get response reader");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim() === "") continue;
        if (!line.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(line.slice(6));
          console.log("Dify API 响应数据:", data);
          yield data as DifyStreamResponse;
        } catch (e) {
          console.error("Failed to parse Dify stream data:", e);
        }
      }
    }
  }
}

export class DifyAgent extends AbstractAgent {
  private difyClient: DifyClient;

  constructor(config: DifyClientConfig) {
    super();
    this.difyClient = new DifyClient(config);
  }

  run(input: RunAgentInput): Observable<AGUIEvent> {
    return from(this.stream(input));
  }

  async *stream(input: RunAgentInput): AsyncGenerator<AGUIEvent> {
    // 1. 发送 AG-UI 输入到 Dify（转换为Dify消息格式）
    const difyMessages = aguiMessagesToDify(input.messages);
    const difyTools = input.tools?.map((tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    // 2. 调用Dify流式对话接口
    const difyStream = await this.difyClient.streamChat({
      messages: difyMessages,
      tools: difyTools,
    });

    // 3. 发送 AG-UI 事件：运行开始
    yield {
      type: EventType.RUN_STARTED,
      timestamp: new Date(),
      threadId: input.threadId,
      runId: input.runId,
    };

    // 4. 处理Dify流响应，转换为AG-UI事件
    let currentMessageId: string | undefined;
    for await (const chunk of difyStream) {
      switch (chunk.event) {
        case "message": // 文本消息
          if (!currentMessageId) {
            currentMessageId = chunk.message_id;
            // 发送消息开始事件
            yield {
              type: EventType.TEXT_MESSAGE_START,
              messageId: currentMessageId,
              role: "assistant",
              timestamp: new Date(),
            };
          }
          // 发送文本内容增量事件
          if (chunk.answer) {
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: currentMessageId,
              delta: chunk.answer,
              timestamp: new Date(),
            };
          }
          break;

        case "message_end": // 消息结束
          if (currentMessageId) {
            yield {
              type: EventType.TEXT_MESSAGE_END,
              messageId: currentMessageId,
              timestamp: new Date(),
            };
          }
          break;

        case "workflow_finished": // 工作流结束
          yield {
            type: EventType.RUN_FINISHED,
            timestamp: new Date(),
            threadId: input.threadId,
            runId: input.runId,
          };
          break;
      }
    }
  }
} 