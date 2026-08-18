import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { EventType, RunAgentInput, RunFinishedEvent } from "@ag-ui/client";
import { firstValueFrom, toArray } from "rxjs";
import { LangChainAgent } from "../agent";

function makeInput(): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [{ id: "msg-1", role: "user", content: "hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
  } as RunAgentInput;
}

async function collectEvents(agent: LangChainAgent, input: RunAgentInput) {
  return firstValueFrom(agent.run(input).pipe(toArray()));
}

describe("LangChainAgent — RUN_FINISHED carries token usage", () => {
  it("attaches usage from a chainFn AIMessage to RUN_FINISHED", async () => {
    const agent = new LangChainAgent({
      chainFn: async () =>
        new AIMessage({
          content: "Hello",
          usage_metadata: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
          response_metadata: { model_name: "gpt-4o" },
        }),
    });

    const events = await collectEvents(agent, makeInput());
    const finished = events.find(
      (e): e is RunFinishedEvent => e.type === EventType.RUN_FINISHED,
    );

    expect(finished).toBeDefined();
    expect(finished!.usage).toHaveLength(1);
    expect(finished!.usage![0]).toMatchObject({
      model: "gpt-4o",
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    });
  });

  it("omits usage when the response reports none", async () => {
    const agent = new LangChainAgent({
      chainFn: async () => "plain string response",
    });

    const events = await collectEvents(agent, makeInput());
    const finished = events.find(
      (e): e is RunFinishedEvent => e.type === EventType.RUN_FINISHED,
    );

    expect(finished).toBeDefined();
    expect(finished!.usage).toBeUndefined();
  });
});
