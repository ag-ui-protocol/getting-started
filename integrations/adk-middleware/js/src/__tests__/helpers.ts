import { type AGUIEvent, type RunAgentInput } from "@ag-ui/core";
import {
  BaseAgent,
  BaseLlm,
  createEvent,
  type BaseLlmConnection,
  type Event as AdkEvent,
  type InvocationContext,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { lastValueFrom, toArray } from "rxjs";

import { ADKAgent } from "../index";

export type Script = (
  context: InvocationContext,
) => readonly AdkEvent[] | Promise<readonly AdkEvent[]>;

export class ScriptedAgent extends BaseAgent {
  constructor(private readonly script: Script) {
    super({ name: "scripted_agent" });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    for (const event of await this.script(context)) {
      yield event;
    }
  }

  protected override async *runLiveImpl(): AsyncGenerator<
    AdkEvent,
    void,
    void
  > {
    return;
  }
}

export class DeterministicLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: readonly LlmResponse[]) {
    super({ model: "deterministic-test-model" });
  }

  get callCount(): number {
    return this.responseIndex;
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    const response = this.responses[this.responseIndex++];
    if (!response) {
      throw new Error("DeterministicLlm ran out of responses.");
    }
    yield response;
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error("DeterministicLlm does not support live mode.");
  }
}

export function runInput(
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    state: {},
    messages: [{ id: "user-1", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

export async function collect(
  agent: ADKAgent,
  input: RunAgentInput,
): Promise<AGUIEvent[]> {
  return lastValueFrom(agent.run(input).pipe(toArray()));
}

export function textEvent(params: {
  id: string;
  text: string;
  partial?: boolean;
  thought?: boolean;
}): AdkEvent {
  return createEvent({
    id: params.id,
    author: "scripted_agent",
    partial: params.partial,
    content: {
      role: "model",
      parts: [{ text: params.text, thought: params.thought }],
    },
  });
}
