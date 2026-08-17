import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

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
  query: queryMock,
  createSdkMcpServer: vi.fn(() => ({})),
}));

// Mock the SDK types import
vi.mock("@anthropic-ai/sdk/resources/beta/messages/messages", () => ({}));

import { ClaudeAgentAdapter } from "./adapter";

describe("ClaudeAgentAdapter headers property", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryMock.mockImplementation(() => ({
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
    }));
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    // Also suppress console.error from adapter error paths
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits debug log when headers are set", async () => {
    const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
    adapter.headers = { "x-aimock-context": "test-integration" };

    const events: unknown[] = [];
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
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    expect(debugSpy).toHaveBeenCalledWith(
      "[ClaudeAdapter] headers set but not forwarded (Claude Agent SDK does not support per-request HTTP headers)",
    );
  });

  it("does NOT emit debug log when headers are undefined", async () => {
    const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
    // headers left undefined

    const events: unknown[] = [];
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
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    const headerCalls = debugSpy.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        call[0].includes("headers set but not forwarded"),
    );
    expect(headerCalls).toHaveLength(0);
  });

  it("does NOT emit debug log when headers is an empty object", async () => {
    const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
    adapter.headers = {};

    const events: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "t3",
          runId: "r3",
          messages: [],
          tools: [],
          context: [],
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    const headerCalls = debugSpy.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        call[0].includes("headers set but not forwarded"),
    );
    expect(headerCalls).toHaveLength(0);
  });

  describe("clone()", () => {
    it("preserves headers across clone()", () => {
      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
      adapter.headers = {
        "x-aimock-context": "test-clone",
        "x-test-id": "clone-123",
      };

      const cloned = adapter.clone();

      expect(cloned.headers).toEqual({
        "x-aimock-context": "test-clone",
        "x-test-id": "clone-123",
      });
    });

    it("creates a defensive copy (mutating clone does not affect original)", () => {
      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
      adapter.headers = { "x-aimock-context": "original" };

      const cloned = adapter.clone();
      cloned.headers!["x-aimock-context"] = "mutated";
      cloned.headers!["x-new"] = "added";

      expect(adapter.headers).toEqual({ "x-aimock-context": "original" });
      expect(cloned.headers).not.toBe(adapter.headers);
    });

    it("leaves headers undefined on clone when not set on original", () => {
      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });

      const cloned = adapter.clone();

      expect(cloned.headers).toBeUndefined();
    });
  });

  it("declares headers as a public property", () => {
    const adapter = new ClaudeAgentAdapter();
    // Should be undefined by default
    expect(adapter.headers).toBeUndefined();

    // Should accept assignment
    adapter.headers = { "x-test": "value" };
    expect(adapter.headers).toEqual({ "x-test": "value" });
  });

  it("includes reasoning in snapshots only when explicitly enabled", async () => {
    queryMock.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield streamEvent({
          type: "message_start",
        });
        yield streamEvent({
          type: "content_block_start",
          content_block: { type: "thinking" },
        });
        yield streamEvent({
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "private thought" },
        });
        yield streamEvent({
          type: "content_block_delta",
          delta: { type: "signature_delta", signature: "encrypted-signature" },
        });
        yield streamEvent({
          type: "content_block_stop",
        });
      },
      interrupt: vi.fn(),
    }));

    const adapter = new ClaudeAgentAdapter({
      model: "claude-haiku-4-5",
      includeReasoningInMessagesSnapshot: true,
    });
    const events: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "reasoning-thread",
          runId: "reasoning-run",
          messages: [{ id: "u1", role: "user", content: "hello" }],
          tools: [],
          context: [],
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    const snapshot = events.find(
      (event) => (event as { type?: string }).type === "MESSAGES_SNAPSHOT",
    ) as { messages: Array<{ role: string; content?: string }> } | undefined;
    expect(snapshot?.messages).toContainEqual({
      id: expect.any(String),
      role: "reasoning",
      content: "private thought",
      encryptedValue: "encrypted-signature",
    });
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "REASONING_ENCRYPTED_VALUE",
      "MESSAGES_SNAPSHOT",
      "RUN_FINISHED",
    ]);
  });

  it("preserves the default behavior of omitting reasoning from snapshots", async () => {
    queryMock.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield streamEvent({ type: "message_start" });
        yield streamEvent({
          type: "content_block_start",
          content_block: { type: "thinking" },
        });
        yield streamEvent({
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "private thought" },
        });
        yield streamEvent({ type: "content_block_stop" });
      },
      interrupt: vi.fn(),
    }));

    const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
    const events: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "default-thread",
          runId: "default-run",
          messages: [{ id: "u1", role: "user", content: "hello" }],
          tools: [],
          context: [],
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    const snapshot = events.find(
      (event) => (event as { type?: string }).type === "MESSAGES_SNAPSHOT",
    ) as { messages: Array<{ role: string }> } | undefined;
    expect(snapshot).toBeUndefined();
  });

  it("filters reasoning messages from the provider prompt", async () => {
    queryMock.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "result",
          result: "test response",
          is_error: false,
        };
      },
      interrupt: vi.fn(),
    }));

    const adapter = new ClaudeAgentAdapter({
      model: "claude-haiku-4-5",
      includeReasoningInMessagesSnapshot: true,
    });
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "provider-thread",
          runId: "provider-run",
          messages: [
            { id: "u1", role: "user", content: "hello" },
            { id: "r1", role: "reasoning", content: "do not send me" },
            { id: "u2", role: "user", content: "continue" },
          ],
          tools: [],
          context: [],
        })
        .subscribe({ error: reject, complete: resolve });
    });

    expect(queryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: "continue" }),
    );
  });

  it("preserves prior reasoning and orders multiple reasoning blocks", async () => {
    queryMock.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield streamEvent({ type: "message_start" });
        yield streamEvent({
          type: "content_block_start",
          content_block: { type: "thinking" },
        });
        yield streamEvent({
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "current first" },
        });
        yield streamEvent({ type: "content_block_stop" });
        yield streamEvent({
          type: "content_block_start",
          content_block: { type: "thinking" },
        });
        yield streamEvent({
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "current second" },
        });
        yield streamEvent({ type: "content_block_stop" });
      },
      interrupt: vi.fn(),
    }));

    const adapter = new ClaudeAgentAdapter({
      model: "claude-haiku-4-5",
      includeReasoningInMessagesSnapshot: true,
    });
    const events: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "ordering-thread",
          runId: "ordering-run",
          messages: [
            { id: "u1", role: "user", content: "hello" },
            { id: "prior-r", role: "reasoning", content: "prior thought" },
            { id: "u2", role: "user", content: "continue" },
          ],
          tools: [],
          context: [],
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    const snapshot = events.find(
      (event) => (event as { type?: string }).type === "MESSAGES_SNAPSHOT",
    ) as { messages: Array<{ id: string; role: string; content?: string }> };
    expect(snapshot.messages).toEqual([
      { id: "u1", role: "user", content: "hello" },
      { id: "prior-r", role: "reasoning", content: "prior thought" },
      { id: "u2", role: "user", content: "continue" },
      {
        id: expect.any(String),
        role: "reasoning",
        content: "current first",
      },
      {
        id: expect.any(String),
        role: "reasoning",
        content: "current second",
      },
    ]);
  });

  it("emits a reasoning snapshot before RUN_ERROR", async () => {
    queryMock.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield streamEvent({ type: "message_start" });
        yield streamEvent({
          type: "content_block_start",
          content_block: { type: "thinking" },
        });
        yield streamEvent({
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "partial thought" },
        });
        throw new Error("stream failed");
      },
      interrupt: vi.fn(),
    }));

    const adapter = new ClaudeAgentAdapter({
      model: "claude-haiku-4-5",
      includeReasoningInMessagesSnapshot: true,
    });
    const events: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "failure-thread",
          runId: "failure-run",
          messages: [{ id: "u1", role: "user", content: "hello" }],
          tools: [],
          context: [],
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "MESSAGES_SNAPSHOT",
      "RUN_ERROR",
    ]);
  });

  it("does not forward the adapter-only option to Claude SDK options", () => {
    const adapter = new ClaudeAgentAdapter({
      model: "claude-haiku-4-5",
      includeReasoningInMessagesSnapshot: true,
    });

    expect(
      adapter.buildOptions({
        threadId: "options-thread",
        runId: "options-run",
        messages: [],
        tools: [],
        context: [],
      }),
    ).not.toHaveProperty("includeReasoningInMessagesSnapshot");
  });
});

function streamEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "stream_event",
    event,
  };
}
