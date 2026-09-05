import { verifyEvents } from "@ag-ui/client";
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
import { from, lastValueFrom, toArray } from "rxjs";
import { expect } from "vitest";

import { ADKJSAgent } from "../index";

export type Script = (
  context: InvocationContext,
) =>
  | readonly AdkEvent[]
  | Promise<readonly AdkEvent[]>
  | AsyncIterable<AdkEvent>;

export class ScriptedAgent extends BaseAgent {
  constructor(
    private readonly script: Script,
    options: { name?: string; subAgents?: BaseAgent[] } = {},
  ) {
    super({
      name: options.name ?? "scripted_agent",
      ...(options.subAgents ? { subAgents: options.subAgents } : {}),
    });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    for await (const event of await this.script(context)) {
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

/** One model turn: a single response, or the chunks of a streamed one. */
type Turn = LlmResponse | LlmResponse[];

export class DeterministicLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private turnIndex = 0;

  constructor(private readonly turns: readonly Turn[]) {
    super({ model: "deterministic-test-model" });
  }

  get callCount(): number {
    return this.turnIndex;
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    const turn = this.turns[this.turnIndex++];
    if (!turn) {
      throw new Error("DeterministicLlm ran out of responses.");
    }
    yield* Array.isArray(turn) ? turn : [turn];
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
  agent: ADKJSAgent,
  input: RunAgentInput,
): Promise<AGUIEvent[]> {
  return lastValueFrom(agent.run(input).pipe(toArray()));
}

/** Fails unless the stream is protocol-legal end to end. */
export async function verified(events: readonly AGUIEvent[]): Promise<void> {
  await expect(
    lastValueFrom(from(events).pipe(verifyEvents(false), toArray())),
  ).resolves.toHaveLength(events.length);
}

/** An ADK event raising one `adk_request_input` interrupt. */
export function requestInputEvent(params: {
  id: string;
  message: string;
  eventId?: string;
  invocationId?: string;
  author?: string;
  path?: string;
  responseSchema?: Record<string, unknown>;
}): AdkEvent {
  return createEvent({
    ...(params.eventId ? { id: params.eventId } : {}),
    ...(params.invocationId ? { invocationId: params.invocationId } : {}),
    author: params.author ?? "scripted_agent",
    ...(params.path ? { nodeInfo: { path: params.path } } : {}),
    content: {
      role: "model",
      parts: [
        {
          functionCall: {
            id: params.id,
            name: "adk_request_input",
            args: {
              message: params.message,
              ...(params.responseSchema
                ? { response_schema: params.responseSchema }
                : {}),
            },
          },
        },
      ],
    },
    longRunningToolIds: [params.id],
  });
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
