import {
  AbstractAgent,
  BaseEvent,
  RunAgentInput,
  EventType,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
} from "@ag-ui/client";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { TokenUsage, aggregateTokenUsage } from "@ag-ui/core";
import { LangChainResponse, streamLangChainResponse } from "./streaming";
import { convertAGUIToolsToLangChain } from "./tools";
import { Observable } from "rxjs";
import { convertAGUIMessagesToLangChain } from "./messages";

/**
 * Best-effort provider/model identity from a LangChain chat model instance.
 * `_llmType()` is the stable provider tag (e.g. "openai", "anthropic"); the
 * model name lives on `.model` (newer) or `.modelName` (older). Used to label
 * token usage that the streamed chunks left unlabeled.
 */
function getModelIdentity(model: any): { provider?: string; model?: string } {
  const provider = typeof model?._llmType === "function" ? model._llmType() : undefined;
  const modelName = model?.model ?? model?.modelName;
  return {
    provider: typeof provider === "string" ? provider : undefined,
    model: typeof modelName === "string" ? modelName : undefined,
  };
}

/**
 * Parameters passed to chainFn callback
 */
export interface ChainFnParams {
  /**
   * Converted LangChain messages
   */
  messages: BaseMessage[];
  /**
   * Converted LangChain tools
   */
  tools: DynamicStructuredTool[];
  /**
   * Application state (can be edited via state tools)
   */
  state?: any;
  /**
   * Application context
   */
  context: Array<{ description: string; value: string }>;
  /**
   * Thread ID
   */
  threadId: string;
  /**
   * Run ID
   */
  runId: string;
  /**
   * Per-request HTTP headers forwarded from the runtime (e.g. x-aimock-context).
   * Undefined when no headers are set on the agent instance.
   */
  headers?: Record<string, string>;
}

/**
 * Configuration for advanced usage with custom LangChain logic
 */
export interface LangChainAgentChainFnConfig {
  /**
   * Custom function that handles LangChain execution
   * This allows full control over chains, graphs, and custom logic
   */
  chainFn: (
    params: ChainFnParams,
  ) => Promise<LangChainResponse> | LangChainResponse;
}

/**
 * Configuration for simple usage with direct model
 */
export interface LangChainAgentModelConfig {
  /**
   * LangChain chat model instance
   */
  model: BaseChatModel;
  /**
   * Optional system prompt
   */
  prompt?: string;
  /**
   * Options to pass to bindTools()
   */
  bindToolsOptions?: Record<string, any>;
}

/**
 * Dual configuration: either chainFn OR model
 */
export type LangChainAgentConfig =
  | LangChainAgentChainFnConfig
  | LangChainAgentModelConfig;

/**
 * Type guard to check if config uses chainFn pattern
 */
function isChainFnConfig(
  config: LangChainAgentConfig,
): config is LangChainAgentChainFnConfig {
  return "chainFn" in config;
}

/**
 * LangChain Agent - bridges AG-UI and LangChain ecosystems
 *
 * Supports two usage patterns:
 *
 * 1. Advanced (chainFn): Full control over LangChain execution
 * ```typescript
 * new LangChainAgent({
 *   chainFn: async ({ messages, tools }) => {
 *     const model = new ChatOpenAI({ model: "gpt-4" });
 *     return model.bindTools(tools).stream(messages);
 *   }
 * })
 * ```
 *
 * 2. Simple (model): Direct model usage with automatic plumbing
 * ```typescript
 * new LangChainAgent({
 *   model: new ChatOpenAI({ model: "gpt-4" }),
 *   prompt: "You are a helpful assistant"
 * })
 * ```
 */
export class LangChainAgent extends AbstractAgent {
  private abortController?: AbortController;

  /**
   * Per-request HTTP headers to forward to the underlying LLM provider.
   * Set by CopilotKit Runtime via configureAgentForRequest() to propagate
   * x-aimock-context, x-aimock-strict, x-test-id, and other forwarded headers.
   */
  public headers?: Record<string, string>;

  constructor(private config: LangChainAgentConfig) {
    super();
  }

  public run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      // Emit RUN_STARTED
      const startEvent: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      };
      subscriber.next(startEvent);

      // Set up abort controller
      const abortController = new AbortController();
      this.abortController = abortController;

      // Execute async logic
      (async () => {
        try {
          // Convert AG-UI messages to LangChain messages
          const langchainMessages = convertAGUIMessagesToLangChain(
            input.messages,
          );

          // Add system message if using model config with prompt
          if (!isChainFnConfig(this.config) && this.config.prompt) {
            const systemPrompt = this.buildSystemPrompt(
              this.config.prompt,
              input.context,
              input.state,
            );
            langchainMessages.unshift({
              content: systemPrompt,
              getType: () => "system",
            } as BaseMessage);
          }

          // Convert AG-UI tools to LangChain tools
          const langchainTools = convertAGUIToolsToLangChain(
            input.tools as any[],
          );

          let response: LangChainResponse;

          // Provider/model labels for usage entries whose chunks didn't carry
          // them. Known only in the direct-model pattern (we hold the model).
          let modelIdentity: { provider?: string; model?: string } = {};

          // Execute based on configuration pattern
          if (isChainFnConfig(this.config)) {
            // Pattern A: User-provided chainFn — expose headers so user code can forward them
            response = await this.config.chainFn({
              messages: langchainMessages,
              tools: langchainTools,
              state: input.state,
              context: input.context,
              threadId: input.threadId,
              runId: input.runId,
              headers: this.headers,
            });
          } else {
            // Pattern B: Direct model usage
            const modelConfig = this.config as LangChainAgentModelConfig;
            modelIdentity = getModelIdentity(modelConfig.model);
            const boundModel = modelConfig.bindToolsOptions
              ? modelConfig.model.bindTools?.(
                  langchainTools,
                  modelConfig.bindToolsOptions,
                )
              : modelConfig.model.bindTools?.(langchainTools);

            // `options.headers` is a provider-specific extension supported by @langchain/openai
            // and @langchain/anthropic via their underlying SDK's RequestOptions. It is NOT
            // part of BaseChatModel's typed surface — hence the explicit shape annotation.
            const callOptions: {
              signal: AbortSignal;
              options?: { headers: Record<string, string> };
            } = {
              signal: abortController.signal,
            };

            if (this.headers && Object.keys(this.headers).length > 0) {
              callOptions.options = { headers: this.headers };
            }

            const model = boundModel || modelConfig.model;
            response = await model.stream(
              langchainMessages,
              callOptions as Parameters<typeof model.stream>[1],
            );
          }

          // Collect provider-reported token usage as the response streams, then
          // attach the per-(provider, model) aggregate to the terminal event.
          const usageEntries: TokenUsage[] = [];

          // Stream the response and emit AG-UI events
          for await (const event of streamLangChainResponse(response, (u) =>
            usageEntries.push(u),
          )) {
            if (abortController.signal.aborted) {
              break;
            }
            subscriber.next(event);
          }

          // Emit RUN_FINISHED if not aborted
          if (!abortController.signal.aborted) {
            // Fill provider/model from the configured model when the streamed
            // chunks didn't include them (LangChain-JS streaming often omits
            // model_name), so downstream can compare usage per provider/model.
            const labeled = usageEntries.map((u) => ({
              ...u,
              ...(u.provider == null && modelIdentity.provider != null
                ? { provider: modelIdentity.provider }
                : {}),
              ...(u.model == null && modelIdentity.model != null
                ? { model: modelIdentity.model }
                : {}),
            }));
            const usage = aggregateTokenUsage(labeled);
            const finishedEvent: RunFinishedEvent = {
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
              ...(usage.length > 0 ? { usage } : {}),
            };
            subscriber.next(finishedEvent);
          }

          subscriber.complete();
        } catch (error) {
          if (!abortController.signal.aborted) {
            const errorEvent: RunErrorEvent = {
              type: EventType.RUN_ERROR,
              message: error instanceof Error ? error.message : String(error),
            };
            subscriber.next(errorEvent);
            subscriber.error(error);
          } else {
            subscriber.complete();
          }
        } finally {
          this.abortController = undefined;
        }
      })();

      // Cleanup function
      return () => {
        abortController.abort();
      };
    });
  }

  /**
   * Build system prompt with context and state
   */
  private buildSystemPrompt(
    prompt: string,
    context: Array<{ description: string; value: string }>,
    state?: any,
  ): string {
    const parts: string[] = [prompt];

    // Add context if present
    if (context && context.length > 0) {
      parts.push("\n## Context from the application\n");
      for (const ctx of context) {
        parts.push(`${ctx.description}:\n${ctx.value}\n`);
      }
    }

    // Add state if present
    if (state !== undefined && state !== null) {
      const hasState =
        typeof state !== "object" || Object.keys(state).length > 0;
      if (hasState) {
        parts.push(
          "\n## Application State\n" +
            "This is state from the application.\n" +
            `\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n`,
        );
      }
    }

    return parts.join("");
  }

  clone(): LangChainAgent {
    const cloned = new LangChainAgent(this.config);
    if (this.headers) {
      cloned.headers = { ...this.headers };
    }
    return cloned;
  }

  abortRun(): void {
    this.abortController?.abort();
  }
}
