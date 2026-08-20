// Main agent class. Wires AI SDK v7 streamText into AG-UI by:
//   1. converting input messages/tools to AI SDK shapes
//   2. driving streamText() with abort propagation
//   3. delegating fullStream → AG-UI event mapping to StreamHandler
//
// StreamHandler owns the full RUN_STARTED → RUN_FINISHED lifecycle, so this
// class only sets up the pipe and tears it down on unsubscribe.

import {
  AbstractAgent,
  type AgentConfig,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolChoice,
} from "ai";
import { Observable } from "rxjs";
import { convertMessagesToVercelAISDKMessages } from "./message-converter";
import { convertToolsToVercelAISDKTools } from "./tool-converter";
import { StreamHandler } from "./stream-handler";

export interface VercelAISDKAgentConfig extends AgentConfig {
  model: LanguageModel;
  maxSteps?: number;
  toolChoice?: ToolChoice<Record<string, unknown>>;
}

// streamText has no request-context channel, so frontend-provided context
// entries are delivered to the model as a leading system message.
function contextToSystemMessages(context: RunAgentInput["context"]): ModelMessage[] {
  if (!context?.length) return [];
  const lines = context.map((c) => `- ${c.description}: ${c.value}`);
  return [
    {
      role: "system",
      content: `Context provided by the frontend application:\n${lines.join("\n")}`,
    },
  ];
}

export class VercelAISDKAgent extends AbstractAgent {
  model: LanguageModel;
  maxSteps: number;
  toolChoice: ToolChoice<Record<string, unknown>>;
  // Per-call HTTP headers forwarded to the AI SDK provider on every run.
  // Mutable so consumers can swap test-only headers between runs (e.g.
  // aimock context). Empty / undefined values are dropped in run().
  public headers?: Record<string, string>;

  constructor(private config: VercelAISDKAgentConfig) {
    const { model, maxSteps, toolChoice, ...rest } = config;
    super(rest);
    this.model = model;
    this.maxSteps = maxSteps ?? 1;
    this.toolChoice = toolChoice ?? "auto";
  }

  public clone() {
    // super.clone() copies the AbstractAgent runtime state (threadId,
    // messages, state, subscribers, middleware); re-attach the fields the
    // base clone doesn't know about.
    const cloned = super.clone() as VercelAISDKAgent;
    cloned.config = this.config;
    cloned.model = this.model;
    cloned.maxSteps = this.maxSteps;
    cloned.toolChoice = this.toolChoice;
    if (this.headers) {
      cloned.headers = { ...this.headers };
    }
    return cloned;
  }

  // AbstractAgent.abortRun() is a no-op; abort the in-flight streamText
  // request so the public stop/cancel API actually cancels the model call
  // (same pattern as HttpAgent and the other in-process integrations).
  public abortRun() {
    this.activeAbortController?.abort();
    super.abortRun();
  }

  private activeAbortController?: AbortController;

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const abortController = new AbortController();
      this.activeAbortController = abortController;

      const result = streamText({
        model: this.model,
        messages: [
          ...contextToSystemMessages(input.context),
          ...convertMessagesToVercelAISDKMessages(input.messages),
        ],
        // AG-UI histories carry system/developer messages inline; v7 rejects
        // them in `messages` by default in favor of `instructions`.
        allowSystemInMessages: true,
        tools: convertToolsToVercelAISDKTools(input.tools),
        stopWhen: stepCountIs(this.maxSteps),
        toolChoice: this.toolChoice,
        abortSignal: abortController.signal,
        ...(this.headers && Object.keys(this.headers).length > 0
          ? { headers: this.headers }
          : {}),
      });

      const handler = new StreamHandler(input, subscriber);
      handler.process(result.fullStream).catch((err) => {
        if (!subscriber.closed) subscriber.error(err);
      });

      return () => {
        abortController.abort();
        if (this.activeAbortController === abortController) {
          this.activeAbortController = undefined;
        }
      };
    });
  }
}
