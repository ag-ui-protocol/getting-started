import { describe, expect, it, vi } from "vitest";
import { AIMessageChunk } from "@langchain/core/messages";
import { EventType, RunAgentInput, RunFinishedEvent } from "@ag-ui/client";
import { firstValueFrom, toArray } from "rxjs";
import { LangChainAgent } from "../agent";

/** Minimal IterableReadableStream stand-in over the given chunks. */
function fakeStream(chunks: any[]) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
      releaseLock: () => {},
    }),
  };
}

function makeInput(): RunAgentInput {
  return {
    threadId: "t-1",
    runId: "r-1",
    messages: [{ id: "m1", role: "user", content: "hi" }],
    tools: [],
    context: [],
    forwardedProps: {},
  } as RunAgentInput;
}

describe("LangChainAgent — provider/model labelling (direct-model pattern)", () => {
  it("labels usage with the configured model's identity when chunks omit it", async () => {
    // A streamed final chunk carries usage but NO model_name — mirrors the real
    // LangChain-JS streaming behaviour observed against OpenAI.
    const chunk = new AIMessageChunk({
      content: "hello there friend",
      usage_metadata: { input_tokens: 14, output_tokens: 6, total_tokens: 20 },
    });
    const streamMock = vi.fn().mockResolvedValue(fakeStream([chunk]));
    const model = {
      _llmType: () => "openai",
      model: "gpt-4o-mini",
      stream: streamMock,
      bindTools: () => ({ stream: streamMock }),
    };

    const agent = new LangChainAgent({ model } as any);
    const events = await firstValueFrom(agent.run(makeInput()).pipe(toArray()));
    const finished = events.find(
      (e): e is RunFinishedEvent => e.type === EventType.RUN_FINISHED,
    );

    expect(finished!.usage).toHaveLength(1);
    expect(finished!.usage![0]).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 14,
      outputTokens: 6,
      totalTokens: 20,
    });
  });
});
