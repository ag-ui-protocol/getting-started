import { describe, expect, it } from "vitest";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { TokenUsage } from "@ag-ui/core";
import { streamLangChainResponse } from "../streaming";

/** Minimal stand-in for an IterableReadableStream of chunks. */
function fakeStream(chunks: any[]) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { done: false, value: chunks[i++] }
          : { done: true, value: undefined },
      releaseLock: () => {},
    }),
  };
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    // discard emitted AG-UI events; we only care about the usage sink here
  }
}

describe("streamLangChainResponse — usage sink", () => {
  it("reports usage from a streamed final AIMessageChunk", async () => {
    const collected: TokenUsage[] = [];
    const chunks = [
      new AIMessageChunk({ content: "Hel" }),
      new AIMessageChunk({
        content: "lo",
        usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        response_metadata: { model_name: "gpt-4o" },
      }),
    ];
    await drain(streamLangChainResponse(fakeStream(chunks) as any, (u) => collected.push(u)));
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("reports usage from a non-streamed AIMessage", async () => {
    const collected: TokenUsage[] = [];
    const msg = new AIMessage({
      content: "Hello",
      usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    await drain(streamLangChainResponse(msg, (u) => collected.push(u)));
    expect(collected).toHaveLength(1);
    expect(collected[0].totalTokens).toBe(5);
  });

  it("does not call the sink when no usage metadata is present", async () => {
    const collected: TokenUsage[] = [];
    await drain(
      streamLangChainResponse(fakeStream([new AIMessageChunk({ content: "hi" })]) as any, (u) =>
        collected.push(u),
      ),
    );
    expect(collected).toHaveLength(0);
  });
});
