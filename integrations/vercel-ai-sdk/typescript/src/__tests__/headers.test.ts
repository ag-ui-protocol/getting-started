import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventType } from "@ag-ui/client";
import type {
  LanguageModelUsage,
  StepResultPerformance,
  TextStreamPart,
  ToolSet,
} from "ai";
import { VercelAISDKAgent } from "../index";
import { RunAgentInput } from "@ag-ui/client";
import { firstValueFrom, toArray } from "rxjs";

// Mock the `ai` module so we can intercept streamText calls
const mockStreamText = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => {
      mockStreamText(...args);
      // Minimal v7-shaped result: run() only consumes `fullStream`. A real
      // stream (not just call interception) keeps these tests on the
      // successful RUN_FINISHED path instead of silently exercising RUN_ERROR.
      //
      // Written out longhand rather than via ./helpers' builders: this factory
      // is hoisted above the imports, so it can only reference types (erased)
      // and not values. The annotation still pins it to the v7 contract.
      const usage: LanguageModelUsage = {
        inputTokens: 1,
        inputTokenDetails: {
          noCacheTokens: 1,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 1,
        outputTokenDetails: { textTokens: 1, reasoningTokens: undefined },
        totalTokens: 2,
      };
      const performance: StepResultPerformance = {
        effectiveOutputTokensPerSecond: 0,
        outputTokensPerSecond: undefined,
        inputTokensPerSecond: undefined,
        effectiveTotalTokensPerSecond: 0,
        stepTimeMs: 0,
        responseTimeMs: 0,
        toolExecutionMs: {},
        timeToFirstOutputMs: undefined,
      };
      async function* fullStream(): AsyncIterable<TextStreamPart<ToolSet>> {
        yield { type: "start" };
        yield { type: "start-step", request: {}, warnings: [] };
        yield { type: "text-start", id: "t1" };
        yield { type: "text-delta", id: "t1", text: "hello" };
        yield { type: "text-end", id: "t1" };
        yield {
          type: "finish-step",
          response: { id: "step-1", modelId: "test-model", timestamp: new Date(0) },
          usage,
          performance,
          finishReason: "stop",
          rawFinishReason: undefined,
          providerMetadata: undefined,
        };
        yield {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: undefined,
          totalUsage: usage,
        };
      }
      return { fullStream: fullStream() };
    },
  };
});

// Minimal mock model; streamText is mocked, so this is never invoked.
const mockModel = {
  provider: "test",
  modelId: "test-model",
  doGenerate: vi.fn(),
  doStream: vi.fn(),
};

function expectSuccessfulRun(events: Array<{ type: string }>): void {
  const types = events.map((e) => e.type);
  expect(types).not.toContain(EventType.RUN_ERROR);
  expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
}

function makeInput(overrides?: Partial<RunAgentInput>): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [{ id: "msg-1", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

describe("VercelAISDKAgent header forwarding", () => {
  beforeEach(() => {
    mockStreamText.mockClear();
  });

  it("forwards headers to streamText when set", async () => {
    const agent = new VercelAISDKAgent({
      agentId: "test",
      model: mockModel as any,
    });
    agent.headers = {
      "x-aimock-context": "vercel-test",
      "x-test-id": "abc-123",
    };

    const events = await firstValueFrom(agent.run(makeInput()).pipe(toArray()));

    expectSuccessfulRun(events);
    expect(mockStreamText).toHaveBeenCalledTimes(1);

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.headers).toEqual({
      "x-aimock-context": "vercel-test",
      "x-test-id": "abc-123",
    });
  });

  it("does not include headers in streamText call when headers is undefined", async () => {
    const agent = new VercelAISDKAgent({
      agentId: "test",
      model: mockModel as any,
    });
    // headers is undefined by default

    const events = await firstValueFrom(agent.run(makeInput()).pipe(toArray()));

    expectSuccessfulRun(events);
    expect(mockStreamText).toHaveBeenCalledTimes(1);

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("headers");
  });

  describe("clone()", () => {
    it("preserves headers across clone()", () => {
      const agent = new VercelAISDKAgent({
        agentId: "test",
        model: mockModel as any,
      });
      agent.headers = {
        "x-aimock-context": "test-clone",
        "x-test-id": "clone-123",
      };

      const cloned = agent.clone() as VercelAISDKAgent;

      expect(cloned.headers).toEqual({
        "x-aimock-context": "test-clone",
        "x-test-id": "clone-123",
      });
    });

    it("creates a defensive copy (mutating clone does not affect original)", () => {
      const agent = new VercelAISDKAgent({
        agentId: "test",
        model: mockModel as any,
      });
      agent.headers = { "x-aimock-context": "original" };

      const cloned = agent.clone() as VercelAISDKAgent;
      cloned.headers!["x-aimock-context"] = "mutated";
      cloned.headers!["x-new"] = "added";

      expect(agent.headers).toEqual({ "x-aimock-context": "original" });
      expect(cloned.headers).not.toBe(agent.headers);
    });

    it("leaves headers undefined on clone when not set on original", () => {
      const agent = new VercelAISDKAgent({
        agentId: "test",
        model: mockModel as any,
      });

      const cloned = agent.clone() as VercelAISDKAgent;

      expect(cloned.headers).toBeUndefined();
    });
  });

  it("does not include headers in streamText call when headers is empty", async () => {
    const agent = new VercelAISDKAgent({
      agentId: "test",
      model: mockModel as any,
    });
    agent.headers = {};

    const events = await firstValueFrom(agent.run(makeInput()).pipe(toArray()));

    expectSuccessfulRun(events);
    expect(mockStreamText).toHaveBeenCalledTimes(1);

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("headers");
  });
});
