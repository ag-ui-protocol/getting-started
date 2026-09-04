import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock workspace packages that aren't built in worktree isolation
vi.mock("@ag-ui/client", () => {
  class AbstractAgent {
    constructor(_config?: Record<string, unknown>) {}
    clone() {
      return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    }
  }
  return {
    AbstractAgent,
    EventType: {
      RUN_STARTED: "RUN_STARTED",
      RUN_FINISHED: "RUN_FINISHED",
      RUN_ERROR: "RUN_ERROR",
      TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
      TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
      TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
      TOOL_CALL_START: "TOOL_CALL_START",
      TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
      TOOL_CALL_END: "TOOL_CALL_END",
      TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
      STATE_SNAPSHOT: "STATE_SNAPSHOT",
      MESSAGES_SNAPSHOT: "MESSAGES_SNAPSHOT",
      CUSTOM: "CUSTOM",
      REASONING_START: "REASONING_START",
      REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
      REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
      REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
      REASONING_END: "REASONING_END",
      REASONING_ENCRYPTED_VALUE: "REASONING_ENCRYPTED_VALUE",
    },
    randomUUID: () => crypto.randomUUID(),
  };
});

vi.mock("@ag-ui/core", () => ({}));

// Mock the Claude Agent SDK so we don't need real API credentials
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
}));

// Mock the SDK types import
vi.mock("@anthropic-ai/sdk/resources/beta/messages/messages", () => ({}));

import { query } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeAgentAdapter } from "./adapter";

function makeAsyncIterable(messages: Record<string, unknown>[]) {
  let index = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (index < messages.length) {
          return { value: messages[index++], done: false };
        }
        return { value: undefined, done: true };
      },
    }),
    interrupt: vi.fn(),
  };
}

describe("modelUsage in RUN_FINISHED result", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips modelUsage from result message to RUN_FINISHED", async () => {
    const mockModelUsage = {
      "claude-sonnet-4-20250514": {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 200,
      },
    };

    (query as ReturnType<typeof vi.fn>).mockReturnValue(
      makeAsyncIterable([
        {
          type: "result",
          result: "done",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1000,
          num_turns: 1,
          total_cost_usd: 0.05,
          usage: { input_tokens: 1000, output_tokens: 500 },
          modelUsage: mockModelUsage,
        },
      ]),
    );

    const adapter = new ClaudeAgentAdapter({ model: "claude-sonnet-4-20250514" });

    const events: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "t1",
          runId: "r1",
          messages: [],
          tools: [],
          context: [],
        })
        .subscribe({
          next: (event) => events.push(event as Record<string, unknown>),
          error: reject,
          complete: resolve,
        });
    });

    const finished = events.find((e) => e.type === "RUN_FINISHED");
    expect(finished).toBeDefined();
    const result = finished!.result as Record<string, unknown>;
    expect(result.modelUsage).toEqual(mockModelUsage);
  });

  it("tolerates absent modelUsage (undefined, not a throw)", async () => {
    (query as ReturnType<typeof vi.fn>).mockReturnValue(
      makeAsyncIterable([
        {
          type: "result",
          result: "done",
          is_error: false,
          duration_ms: 500,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: { input_tokens: 100, output_tokens: 50 },
          // modelUsage intentionally absent
        },
      ]),
    );

    const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });

    const events: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "t2",
          runId: "r2",
          messages: [],
          tools: [],
          context: [],
        })
        .subscribe({
          next: (event) => events.push(event as Record<string, unknown>),
          error: reject,
          complete: resolve,
        });
    });

    const finished = events.find((e) => e.type === "RUN_FINISHED");
    expect(finished).toBeDefined();
    const result = finished!.result as Record<string, unknown>;
    expect(result.modelUsage).toBeUndefined();
  });
});
