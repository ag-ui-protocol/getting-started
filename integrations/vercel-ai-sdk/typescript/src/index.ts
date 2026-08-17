import {
  AgentConfig,
  AbstractAgent,
  EventType,
  BaseEvent,
  Message,
  AssistantMessage,
  RunAgentInput,
  MessagesSnapshotEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageChunkEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolCall,
  ToolMessage,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  CoreMessage,
  LanguageModelV1,
  processDataStream,
  streamText,
  tool as createVercelAISDKTool,
  ToolChoice,
  ToolSet,
  FilePart,
  ImagePart,
  TextPart,
} from "ai";
import { randomUUID } from "@ag-ui/client";
import { z } from "zod";

type VercelUserContent = Extract<CoreMessage, { role: "user" }>["content"];
type VercelUserArrayContent = Extract<VercelUserContent, any[]>;
type VercelUserPart =
  VercelUserArrayContent extends Array<infer Part> ? Part : never;

const toVercelUserParts = (
  inputContent: Message["content"],
): VercelUserPart[] => {
  if (!Array.isArray(inputContent)) {
    return [];
  }

  const parts: VercelUserPart[] = [];

  for (const part of inputContent) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text } as VercelUserPart);
    }
  }

  return parts;
};

const toVercelUserContent = (
  content: Message["content"],
): VercelUserContent => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  const parts = toVercelUserParts(content);
  if (parts.length === 0) {
    return "";
  }

  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }

  return parts;
};

type ProcessedEvent =
  | MessagesSnapshotEvent
  | RunFinishedEvent
  | RunStartedEvent
  | TextMessageChunkEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallStartEvent;

interface VercelAISDKAgentConfig extends AgentConfig {
  model: LanguageModelV1;
  maxSteps?: number;
  toolChoice?: ToolChoice<Record<string, unknown>>;
}

export class VercelAISDKAgent extends AbstractAgent {
  model: LanguageModelV1;
  maxSteps: number;
  toolChoice: ToolChoice<Record<string, unknown>>;
  public headers?: Record<string, string>;
  constructor(private config: VercelAISDKAgentConfig) {
    const { model, maxSteps, toolChoice, ...rest } = config;
    super({ ...rest });
    this.model = model;
    this.maxSteps = maxSteps ?? 1;
    this.toolChoice = toolChoice ?? "auto";
  }

  public clone() {
    const cloned = new VercelAISDKAgent(this.config);
    if (this.headers) {
      cloned.headers = { ...this.headers };
    }
    return cloned;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const finalMessages: Message[] = input.messages;

    return new Observable<ProcessedEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as RunStartedEvent);

      const response = streamText({
        model: this.model,
        messages: convertMessagesToVercelAISDKMessages(input.messages),
        tools: convertToolToVerlAISDKTools(input.tools),
        maxSteps: this.maxSteps,
        toolChoice: this.toolChoice,
        ...(this.headers && Object.keys(this.headers).length > 0
          ? { headers: this.headers }
          : {}),
      });

      let messageId = randomUUID();
      let assistantMessage: AssistantMessage = {
        id: messageId,
        role: "assistant",
        content: "",
        toolCalls: [],
      };
      finalMessages.push(assistantMessage);

      processDataStream({
        stream: response.toDataStreamResponse().body!,
        onTextPart: (text) => {
          assistantMessage.content += text;
          const event: TextMessageChunkEvent = {
            type: EventType.TEXT_MESSAGE_CHUNK,
            role: "assistant",
            messageId,
            delta: text,
          };
          subscriber.next(event);
        },
        onFinishMessagePart: () => {
          // Emit message snapshot
          const event: MessagesSnapshotEvent = {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: finalMessages,
          };
          subscriber.next(event);

          // Emit run finished event
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as RunFinishedEvent);

          // Complete the observable
          subscriber.complete();
        },
        onToolCallPart(streamPart) {
          let toolCall: ToolCall = {
            id: streamPart.toolCallId,
            type: "function",
            function: {
              name: streamPart.toolName,
              arguments: JSON.stringify(streamPart.args),
            },
          };
          assistantMessage.toolCalls!.push(toolCall);

          const startEvent: ToolCallStartEvent = {
            type: EventType.TOOL_CALL_START,
            parentMessageId: messageId,
            toolCallId: streamPart.toolCallId,
            toolCallName: streamPart.toolName,
          };
          subscriber.next(startEvent);

          const argsEvent: ToolCallArgsEvent = {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: streamPart.toolCallId,
            delta: JSON.stringify(streamPart.args),
          };
          subscriber.next(argsEvent);

          const endEvent: ToolCallEndEvent = {
            type: EventType.TOOL_CALL_END,
            toolCallId: streamPart.toolCallId,
          };
          subscriber.next(endEvent);
        },
        onToolResultPart(streamPart) {
          const toolMessage: ToolMessage = {
            role: "tool",
            id: randomUUID(),
            toolCallId: streamPart.toolCallId,
            content: JSON.stringify(streamPart.result),
          };
          finalMessages.push(toolMessage);
        },
        onErrorPart(streamPart) {
          subscriber.error(streamPart);
        },
      }).catch((error) => {
        console.error("catch error", error);
        // Handle error
        subscriber.error(error);
      });

      return () => {};
    });
  }
}

export function convertMessagesToVercelAISDKMessages(
  messages: Message[],
): CoreMessage[] {
  const result: CoreMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: any[] = message.content
        ? [{ type: "text", text: message.content }]
        : [];
      for (const toolCall of message.toolCalls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments),
        });
      }
      result.push({
        role: "assistant",
        content: parts,
      });
    } else if (message.role === "user") {
      result.push({
        role: "user",
        content: toVercelUserContent(message.content),
      });
    } else if (message.role === "tool") {
      let toolName = "unknown";
      for (const msg of messages) {
        if (msg.role === "assistant") {
          for (const toolCall of msg.toolCalls ?? []) {
            if (toolCall.id === message.toolCallId) {
              toolName = toolCall.function.name;
              break;
            }
          }
        }
      }
      result.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: toolName,
            result: message.content,
            // Carry the AG-UI failure signal onto the AI SDK v4 tool-result flag, so a
            // client-reported tool failure is not delivered to the model as a success.
            isError: !!message.error,
          },
        ],
      });
    }
  }

  return result;
}

export function convertJsonSchemaToZodSchema(
  jsonSchema: any,
  required: boolean,
): z.ZodSchema {
  if (jsonSchema.type === "object") {
    const spec: { [key: string]: z.ZodSchema } = {};

    if (!jsonSchema.properties || !Object.keys(jsonSchema.properties).length) {
      return !required ? z.object(spec).optional() : z.object(spec);
    }

    for (const [key, value] of Object.entries(jsonSchema.properties)) {
      spec[key] = convertJsonSchemaToZodSchema(
        value,
        jsonSchema.required ? jsonSchema.required.includes(key) : false,
      );
    }
    let schema = z.object(spec).describe(jsonSchema.description);
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "string") {
    let schema = z.string().describe(jsonSchema.description);
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "number") {
    let schema = z.number().describe(jsonSchema.description);
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "boolean") {
    let schema = z.boolean().describe(jsonSchema.description);
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "array") {
    let itemSchema = convertJsonSchemaToZodSchema(jsonSchema.items, true);
    let schema = z.array(itemSchema).describe(jsonSchema.description);
    return required ? schema : schema.optional();
  }
  throw new Error("Invalid JSON schema");
}

export function convertToolToVerlAISDKTools(
  tools: RunAgentInput["tools"],
): ToolSet {
  return tools.reduce(
    (acc: ToolSet, tool: RunAgentInput["tools"][number]) => ({
      ...acc,
      [tool.name]: createVercelAISDKTool({
        description: tool.description,
        parameters: convertJsonSchemaToZodSchema(tool.parameters, true),
      }),
    }),
    {},
  );
}
