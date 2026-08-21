import { EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core";
import {
  Agent,
  BaseLlm,
  InMemorySessionService,
  Runner,
  requestInputTool,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { lastValueFrom, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

import { ADKAgent } from "../agent";
import { MessageSnapshot } from "../message-snapshot";

class StreamingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: readonly LlmResponse[][]) {
    super({ model: "streaming-test-model" });
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    const responses = this.responses[this.responseIndex++];
    if (!responses) {
      throw new Error("StreamingLlm ran out of responses.");
    }
    for (const response of responses) {
      yield response;
    }
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error("StreamingLlm does not support live mode.");
  }
}

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    state: {},
    messages: [{ id: "user-1", role: "user", content: "Begin" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

async function collect(
  agent: ADKAgent,
  runInput: RunAgentInput,
): Promise<AGUIEvent[]> {
  return lastValueFrom(agent.run(runInput).pipe(toArray()));
}

function checkpoint(
  initial: RunAgentInput["messages"],
  events: readonly AGUIEvent[],
): RunAgentInput["messages"] {
  const snapshot = new MessageSnapshot(initial);
  for (const event of events) {
    snapshot.apply(event);
  }
  return snapshot.getMessages();
}

describe("streaming session identity", () => {
  it("does not restore a streamed assistant checkpoint into ADK twice", async () => {
    const model = new StreamingLlm([
      [
        {
          partial: true,
          content: { role: "model", parts: [{ text: "Hel" }] },
        },
        {
          partial: true,
          content: { role: "model", parts: [{ text: "lo" }] },
        },
        {
          content: { role: "model", parts: [{ text: "Hello" }] },
        },
      ],
      [{ content: { role: "model", parts: [{ text: "Next" }] } }],
    ]);
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new Agent({ name: "streaming_agent", model }),
      }),
      userId: "user-1",
    });
    const firstInput = input();
    const first = await collect(bridge.clone(), firstInput);
    const messages = checkpoint(firstInput.messages, first);

    const second = await collect(
      bridge.clone(),
      input({
        runId: "run-2",
        messages: [
          ...messages,
          { id: "user-2", role: "user", content: "Continue" },
        ],
      }),
    );

    expect(second.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    const secondRequest = JSON.stringify(model.requests[1]?.contents);
    expect(secondRequest.match(/Hello/g)).toHaveLength(1);
  });

  it("resumes after text streamed before an ADK input request", async () => {
    const model = new StreamingLlm([
      [
        {
          partial: true,
          content: { role: "model", parts: [{ text: "I need a region. " }] },
        },
        {
          content: {
            role: "model",
            parts: [
              { text: "I need a region. " },
              {
                functionCall: {
                  id: "region-request",
                  name: "adk_request_input",
                  args: { message: "Which region?" },
                },
              },
            ],
          },
        },
      ],
      [{ content: { role: "model", parts: [{ text: "Thanks." }] } }],
    ]);
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new Agent({
          name: "interrupting_agent",
          model,
          tools: [requestInputTool],
        }),
      }),
      userId: "user-1",
    });
    const firstInput = input();
    const first = await collect(bridge.clone(), firstInput);
    const finished = first.at(-1);
    expect(finished).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "interrupt" },
    });
    const outcome =
      finished?.type === EventType.RUN_FINISHED ? finished.outcome : undefined;
    if (
      !finished ||
      finished.type !== EventType.RUN_FINISHED ||
      outcome?.type !== "interrupt"
    ) {
      throw new Error("Expected an interrupt outcome.");
    }
    const messages = checkpoint(firstInput.messages, first);

    const resumed = await collect(
      bridge.clone(),
      input({
        runId: "run-2",
        messages,
        resume: [
          {
            interruptId: outcome.interrupts[0]!.id,
            status: "resolved",
            payload: { region: "eu-west-1" },
          },
        ],
      }),
    );

    expect(resumed.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    expect(resumed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Thanks.",
        }),
      ]),
    );
    expect(model.requests).toHaveLength(2);
  });
});
