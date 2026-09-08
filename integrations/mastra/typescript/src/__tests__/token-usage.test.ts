import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/client";
import {
  collectEvents,
  makeInput,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
} from "./helpers";

const finishChunk = { type: "finish", payload: {} };

function runFinished(events: any[]) {
  return events.find((e) => e.type === EventType.RUN_FINISHED) as any;
}

describe("MastraAgent — RUN_FINISHED token usage", () => {
  it("surfaces AI-SDK usage, labelled from the agent model", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [finishChunk],
      usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
      model: { provider: "openai.chat", modelId: "gpt-4o-mini" },
    });
    const finished = runFinished(await collectEvents(agent, makeInput()));
    expect(finished).toBeDefined();
    expect(finished.usage).toEqual([
      {
        provider: "openai.chat",
        model: "gpt-4o-mini",
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 42,
      },
    ]);
  });

  it("resolves usage exposed as a promise (AI-SDK's shape)", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [finishChunk],
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 2, totalTokens: 7 }),
    });
    const finished = runFinished(await collectEvents(agent, makeInput()));
    expect(finished.usage?.[0]).toMatchObject({ inputTokens: 5, totalTokens: 7 });
  });

  it("omits usage when the response reports none", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: [finishChunk] });
    const finished = runFinished(await collectEvents(agent, makeInput()));
    expect(finished.usage).toBeUndefined();
  });

  it("reports terminal usage from a remote stream", async () => {
    const agent = makeRemoteMastraAgent({
      streamChunks: [
        {
          type: "step-finish",
          payload: {
            output: {
              usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            },
          },
        },
        {
          type: "finish",
          payload: {
            output: {
              usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
            },
          },
        },
      ],
    });

    const finished = runFinished(await collectEvents(agent, makeInput()));

    expect(finished.usage).toEqual([
      { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
    ]);
  });
});

// The resumed half of a human-in-the-loop run is a separate runId making its own
// model calls, so its token spend has to be reported too. Without this the
// interrupting RUN_FINISHED carries usage for the pre-approval work and the
// resumed one carries none — and because `undefined` means "not measured", a
// consumer cannot tell the post-approval spend was lost.
describe("MastraAgent — RUN_FINISHED token usage on resumed runs", () => {
  const resumeInterrupt = {
    type: "mastra_suspend",
    toolCallId: "tc-1",
    runId: "run-1",
  };

  function makeResumeInput(interruptEvent: Record<string, any>) {
    return makeInput({
      forwardedProps: {
        command: {
          resume: { approved: true },
          interruptEvent: JSON.stringify(interruptEvent),
        },
      },
    });
  }

  it("reports usage on the local resume path", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [],
      resumeChunks: [{ type: "text-delta", payload: { text: "Approved." } }],
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      model: { provider: "openai.chat", modelId: "gpt-4o-mini" },
    });

    const finished = runFinished(await collectEvents(agent, makeResumeInput(resumeInterrupt)));

    expect(finished).toBeDefined();
    expect(finished.usage).toEqual([
      {
        provider: "openai.chat",
        model: "gpt-4o-mini",
        inputTokens: 8,
        outputTokens: 3,
        totalTokens: 11,
      },
    ]);
  });

  it("omits usage on the resume path when the resumed run reports none", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [],
      resumeChunks: [{ type: "text-delta", payload: { text: "Approved." } }],
    });

    const finished = runFinished(await collectEvents(agent, makeResumeInput(resumeInterrupt)));

    expect(finished).toBeDefined();
    expect(finished.usage).toBeUndefined();
  });

  it("reports fallback usage from a remote resumed stream", async () => {
    const agent = makeRemoteMastraAgent({
      resumeChunks: [
        {
          type: "finish",
          payload: {
            usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
          },
        },
      ],
    });

    const finished = runFinished(
      await collectEvents(agent, makeResumeInput(resumeInterrupt)),
    );

    expect(finished.usage).toEqual([
      { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    ]);
  });
});
