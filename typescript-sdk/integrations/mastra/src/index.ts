import type {
  AgentConfig,
  AssistantMessage,
  BaseEvent,
  Message,
  MessagesSnapshotEvent,
  RunAgentInput,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageChunkEvent,
  ToolCall,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolMessage,
} from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
  CopilotServiceAdapter,
  ExperimentalEmptyAdapter,
} from "@copilotkit/runtime";
import { processDataStream } from "@ai-sdk/ui-utils";
import type { CoreMessage, Mastra } from "@mastra/core";
import { registerApiRoute } from "@mastra/core/server";
import type { Agent as LocalMastraAgent } from "@mastra/core/agent";
import type { Context } from "hono";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { randomUUID } from "@ag-ui/client";
import { Observable } from "rxjs";
import { MastraClient } from "@mastra/client-js";
type RemoteMastraAgent = ReturnType<MastraClient["getAgent"]>;

export interface MastraAgentConfig extends AgentConfig {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  runtimeContext?: RuntimeContext;
}

interface MastraAgentStreamOptions {
  onTextPart?: (text: string) => void;
  onFinishMessagePart?: () => void;
  onToolCallPart?: (streamPart: { toolCallId: string; toolName: string; args: any }) => void;
  onToolResultPart?: (streamPart: { toolCallId: string; result: any }) => void;
  onError?: (error: Error) => void;
}

export class MastraAgent extends AbstractAgent {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  runtimeContext?: RuntimeContext;

  constructor({ agent, resourceId, runtimeContext, ...rest }: MastraAgentConfig) {
    super(rest);
    this.agent = agent;
    this.resourceId = resourceId;
    this.runtimeContext = runtimeContext;
  }

  static async getRemoteAgents({
    mastraClient,
    resourceId,
  }: {
    mastraClient: MastraClient;
    resourceId?: string;
  }): Promise<Record<string, AbstractAgent>> {
    const agents = await mastraClient.getAgents();

    return Object.entries(agents).reduce(
      (acc, [agentId]) => {
        const agent = mastraClient.getAgent(agentId);

        acc[agentId] = new MastraAgent({
          agentId,
          agent,
          resourceId,
        });

        return acc;
      },
      {} as Record<string, AbstractAgent>,
    );
  }

  static getLocalAgents({
    mastra,
    resourceId,
    runtimeContext,
  }: {
    mastra: Mastra;
    resourceId?: string;
    runtimeContext?: RuntimeContext;
  }): Record<string, AbstractAgent> {
    const agents = mastra.getAgents() || {};
    const networks = mastra.getNetworks() || [];

    const networkAGUI = networks.reduce(
      (acc, network) => {
        acc[network.name!] = new MastraAgent({
          agentId: network.name!,
          agent: network as unknown as LocalMastraAgent,
          resourceId,
          runtimeContext,
        });
        return acc;
      },
      {} as Record<string, AbstractAgent>,
    );

    const agentAGUI = Object.entries(agents).reduce(
      (acc, [agentId, agent]) => {
        acc[agentId] = new MastraAgent({
          agentId,
          agent,
          resourceId,
          runtimeContext,
        });
        return acc;
      },
      {} as Record<string, AbstractAgent>,
    );

    return {
      ...agentAGUI,
      ...networkAGUI,
    };
  }

  static getLocalAgent({
    mastra,
    agentId,
    resourceId,
    runtimeContext,
  }: {
    mastra: Mastra;
    agentId: string;
    resourceId?: string;
    runtimeContext?: RuntimeContext;
  }) {
    const agent = mastra.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return new MastraAgent({
      agentId,
      agent,
      resourceId,
      runtimeContext,
    }) as AbstractAgent;
  }

  static getNetwork({
    mastra,
    networkId,
    resourceId,
    runtimeContext,
  }: {
    mastra: Mastra;
    networkId: string;
    resourceId?: string;
    runtimeContext?: RuntimeContext;
  }) {
    const network = mastra.getNetwork(networkId);
    if (!network) {
      throw new Error(`Network ${networkId} not found`);
    }
    return new MastraAgent({
      agentId: network.name!,
      agent: network as unknown as LocalMastraAgent,
      resourceId,
      runtimeContext,
    }) as AbstractAgent;
  }

  protected run(input: RunAgentInput): Observable<BaseEvent> {
    const finalMessages: Message[] = [...input.messages];
    let messageId = randomUUID();
    let assistantMessage: AssistantMessage = {
      id: messageId,
      role: "assistant",
      content: "",
      toolCalls: [],
    };
    finalMessages.push(assistantMessage);

    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as RunStartedEvent);

      this.streamMastraAgent(input, {
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
        onToolCallPart: (streamPart) => {
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
        onError: (error) => {
          console.error("error", error);
          // Handle error
          subscriber.error(error);
        },
      });

      return () => {};
    });
  }

  /**
   * Streams in process or remote mastra agent.
   * @param input - The input for the mastra agent.
   * @param options - The options for the mastra agent.
   * @returns The stream of the mastra agent.
   */
  private streamMastraAgent(
    { threadId, runId, messages, tools }: RunAgentInput,
    {
      onTextPart,
      onFinishMessagePart,
      onToolCallPart,
      onToolResultPart,
      onError,
    }: MastraAgentStreamOptions,
  ) {
    const clientTools = tools.reduce(
      (acc, tool) => {
        acc[tool.name as string] = {
          id: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        };
        return acc;
      },
      {} as Record<string, any>,
    );
    const resourceId = this.resourceId ?? threadId;
    const convertedMessages = convertAGUIMessagesToMastra(messages);
    const runtimeContext = this.runtimeContext;

    function isLocalMastraAgent(
      agent: LocalMastraAgent | RemoteMastraAgent,
    ): agent is LocalMastraAgent {
      return "metrics" in agent;
    }

    if (isLocalMastraAgent(this.agent)) {
      // in process agent
      return this.agent
        .stream(convertedMessages, {
          threadId,
          resourceId,
          runId,
          clientTools,
          runtimeContext,
        })
        .then((response) => {
          return processDataStream({
            stream: (response as any).toDataStreamResponse().body!,
            onTextPart,
            onToolCallPart,
            onToolResultPart,
            onFinishMessagePart,
          });
        })
        .catch((error) => {
          onError?.(error);
        });
    } else {
      // remote agent
      return this.agent
        .stream({
          threadId,
          resourceId,
          runId,
          messages: convertedMessages,
          clientTools,
        })
        .then((response) => {
          return response.processDataStream({
            onTextPart,
            onToolCallPart,
            onToolResultPart,
            onFinishMessagePart,
          });
        })
        .catch((error) => {
          onError?.(error);
        });
    }
  }
}

export function convertAGUIMessagesToMastra(messages: Message[]): CoreMessage[] {
  const result: CoreMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: any[] = message.content ? [{ type: "text", text: message.content }] : [];
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
        content: message.content || "",
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
          },
        ],
      });
    }
  }

  return result;
}

export function registerCopilotKit<T extends Record<string, any> | unknown = unknown>({
  path,
  resourceId,
  serviceAdapter = new ExperimentalEmptyAdapter(),
  agents,
  setContext,
}: {
  path: string;
  resourceId: string;
  serviceAdapter?: CopilotServiceAdapter;
  agents?: Record<string, AbstractAgent>;
  setContext?: (
    c: Context<{
      Variables: {
        mastra: Mastra;
      };
    }>,
    runtimeContext: RuntimeContext<T>,
  ) => void | Promise<void>;
}) {
  return registerApiRoute(path, {
    method: `ALL`,
    handler: async (c) => {
      const mastra = c.get("mastra");

      const runtimeContext = new RuntimeContext<T>();

      if (setContext) {
        await setContext(c, runtimeContext);
      }

      const aguiAgents =
        agents ||
        MastraAgent.getLocalAgents({
          resourceId,
          mastra,
          runtimeContext,
        });

      const runtime = new CopilotRuntime({
        agents: aguiAgents,
      });

      const handler = copilotRuntimeNodeHttpEndpoint({
        endpoint: path,
        runtime,
        serviceAdapter,
      });

      return handler.handle(c.req.raw, {});
    },
  });
}
