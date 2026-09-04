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
  query: vi.fn(() => {
    return {
      [Symbol.asyncIterator]: () => ({
        next: vi
          .fn()
          .mockResolvedValueOnce({
            value: {
              type: "result",
              result: "test response",
              is_error: false,
            },
            done: false,
          })
          .mockResolvedValueOnce({ value: undefined, done: true }),
      }),
      interrupt: vi.fn(),
    };
  }),
  createSdkMcpServer: vi.fn(() => ({})),
}));

// Mock the SDK types import
vi.mock("@anthropic-ai/sdk/resources/beta/messages/messages", () => ({}));

import { ClaudeAgentAdapter } from "./adapter";

describe("buildOptions systemPrompt handling", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const inputWithContext = {
    threadId: "t1",
    runId: "r1",
    messages: [],
    tools: [],
    context: [{ description: "env", value: "test" }],
  };

  const inputWithoutContext = {
    threadId: "t1",
    runId: "r1",
    messages: [],
    tools: [],
    context: [],
  };

  it("preserves preset object and folds addendum into append", () => {
    const adapter = new ClaudeAgentAdapter({
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
        append: "Be concise.",
      },
    });

    const opts = adapter.buildOptions(inputWithContext);
    const sp = opts.systemPrompt as {
      type: string;
      preset: string;
      append: string;
    };

    expect(typeof sp).toBe("object");
    expect(sp.type).toBe("preset");
    expect(sp.preset).toBe("claude_code");
    expect(sp.append).toContain("Be concise.");
    expect(sp.append).toContain("env: test");
  });

  it("preserves preset object with empty append", () => {
    const adapter = new ClaudeAgentAdapter({
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
      },
    });

    const opts = adapter.buildOptions(inputWithContext);
    const sp = opts.systemPrompt as {
      type: string;
      preset: string;
      append: string;
    };

    expect(typeof sp).toBe("object");
    expect(sp.type).toBe("preset");
    expect(sp.preset).toBe("claude_code");
    expect(sp.append).toContain("env: test");
  });

  it("does not produce [object Object] from preset systemPrompt", () => {
    const adapter = new ClaudeAgentAdapter({
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
        append: "Custom instructions.",
      },
    });

    const opts = adapter.buildOptions(inputWithContext);
    const spStr = JSON.stringify(opts.systemPrompt);

    expect(spStr).not.toContain("[object Object]");
  });

  it("concatenates addendum to a plain string systemPrompt", () => {
    const adapter = new ClaudeAgentAdapter({
      systemPrompt: "You are helpful.",
    });

    const opts = adapter.buildOptions(inputWithContext);
    const sp = opts.systemPrompt as string;

    expect(typeof sp).toBe("string");
    expect(sp).toContain("You are helpful.");
    expect(sp).toContain("env: test");
  });

  it("uses addendum alone when systemPrompt is undefined", () => {
    const adapter = new ClaudeAgentAdapter({});

    const opts = adapter.buildOptions(inputWithContext);
    const sp = opts.systemPrompt as string;

    expect(typeof sp).toBe("string");
    expect(sp).toContain("env: test");
  });

  it("does not modify systemPrompt when there is no addendum", () => {
    const preset = {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: "Custom.",
    };
    const adapter = new ClaudeAgentAdapter({
      systemPrompt: preset,
    });

    const opts = adapter.buildOptions(inputWithoutContext);

    // With no context/state, addendum is empty and systemPrompt should be unchanged
    expect(opts.systemPrompt).toEqual(preset);
  });
});
