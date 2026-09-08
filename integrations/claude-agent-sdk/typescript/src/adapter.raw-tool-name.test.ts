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

// Track the query mock so we can swap the stream per test
let mockStreamMessages: Array<Record<string, unknown>> = [];

// Mock the Claude Agent SDK so we don't need real API credentials
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    let idx = 0;
    return {
      [Symbol.asyncIterator]: () => ({
        next: vi.fn(async () => {
          if (idx < mockStreamMessages.length) {
            return { value: mockStreamMessages[idx++], done: false };
          }
          return { value: undefined, done: true };
        }),
      }),
      interrupt: vi.fn(),
    };
  }),
  createSdkMcpServer: vi.fn(() => ({})),
}));

// Mock the SDK types import
vi.mock("@anthropic-ai/sdk/resources/beta/messages/messages", () => ({}));

import { ClaudeAgentAdapter } from "./adapter";

function collectEvents(
  adapter: ClaudeAgentAdapter,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  return new Promise((resolve, reject) => {
    adapter.run(input as never).subscribe({
      next: (event: unknown) => events.push(event as Record<string, unknown>),
      error: reject,
      complete: () => resolve(events),
    });
  });
}

describe("raw MCP tool name exposure", () => {
  beforeEach(() => {
    mockStreamMessages = [];
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("streaming path (TOOL_CALL_START via content_block_start)", () => {
    it("emits metadata.rawName with the MCP-prefixed name for MCP tools", async () => {
      mockStreamMessages = [
        {
          type: "stream_event",
          event: { type: "message_start" },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: {
              type: "tool_use",
              id: "tool-1",
              name: "mcp__example_sandbox__Bash",
            },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_stop",
          },
        },
        {
          type: "stream_event",
          event: { type: "message_stop" },
        },
        {
          type: "result",
          result: "",
          is_error: false,
        },
      ];

      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
      const events = await collectEvents(adapter, {
        threadId: "t1",
        runId: "r1",
        messages: [],
        tools: [],
        context: [],
      });

      const toolCallStart = events.find((e) => e.type === "TOOL_CALL_START");
      expect(toolCallStart).toBeDefined();
      expect(toolCallStart!.toolCallName).toBe("Bash");
      const meta = toolCallStart!.metadata as Record<string, unknown>;
      expect(meta).toBeDefined();
      expect(meta.rawName).toBe("mcp__example_sandbox__Bash");
    });

    it("emits metadata.rawName equal to the display name for built-in tools", async () => {
      mockStreamMessages = [
        {
          type: "stream_event",
          event: { type: "message_start" },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: {
              type: "tool_use",
              id: "tool-2",
              name: "Bash",
            },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_stop",
          },
        },
        {
          type: "stream_event",
          event: { type: "message_stop" },
        },
        {
          type: "result",
          result: "",
          is_error: false,
        },
      ];

      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
      const events = await collectEvents(adapter, {
        threadId: "t2",
        runId: "r2",
        messages: [],
        tools: [],
        context: [],
      });

      const toolCallStart = events.find((e) => e.type === "TOOL_CALL_START");
      expect(toolCallStart).toBeDefined();
      expect(toolCallStart!.toolCallName).toBe("Bash");
      const meta = toolCallStart!.metadata as Record<string, unknown>;
      expect(meta).toBeDefined();
      expect(meta.rawName).toBe("Bash");
    });
  });

  describe("non-streaming path (complete assistant message)", () => {
    it("emits metadata.rawName with MCP prefix on TOOL_CALL_START for non-streamed tool blocks", async () => {
      mockStreamMessages = [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-3",
                name: "mcp__server__MyTool",
                input: { arg: "value" },
              },
            ],
          },
        },
        {
          type: "result",
          result: "",
          is_error: false,
        },
      ];

      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
      const events = await collectEvents(adapter, {
        threadId: "t3",
        runId: "r3",
        messages: [],
        tools: [],
        context: [],
      });

      const toolCallStart = events.find((e) => e.type === "TOOL_CALL_START");
      expect(toolCallStart).toBeDefined();
      expect(toolCallStart!.toolCallName).toBe("MyTool");
      const meta = toolCallStart!.metadata as Record<string, unknown>;
      expect(meta).toBeDefined();
      expect(meta.rawName).toBe("mcp__server__MyTool");
    });
  });

  describe("assistant message tool calls carry rawName in metadata", () => {
    it("includes rawName metadata on MCP tool calls in MESSAGES_SNAPSHOT", async () => {
      mockStreamMessages = [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-4",
                name: "mcp__sandbox__Read",
                input: { path: "/tmp/test" },
              },
            ],
          },
        },
        {
          type: "result",
          result: "",
          is_error: false,
        },
      ];

      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
      const events = await collectEvents(adapter, {
        threadId: "t4",
        runId: "r4",
        messages: [],
        tools: [],
        context: [],
      });

      const snapshot = events.find((e) => e.type === "MESSAGES_SNAPSHOT") as
        | { messages: Array<Record<string, unknown>> }
        | undefined;
      expect(snapshot).toBeDefined();

      const assistantMsg = snapshot!.messages.find(
        (m: Record<string, unknown>) => m.role === "assistant",
      ) as { toolCalls?: Array<Record<string, unknown>> } | undefined;
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.toolCalls).toBeDefined();
      expect(assistantMsg!.toolCalls!.length).toBeGreaterThan(0);

      const toolCall = assistantMsg!.toolCalls![0];
      const fn = toolCall.function as { name: string };
      expect(fn.name).toBe("Read");
      expect(toolCall.metadata).toEqual({ rawName: "mcp__sandbox__Read" });
    });

    it("includes rawName metadata equal to display name for built-in tool calls", async () => {
      mockStreamMessages = [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-5",
                name: "Read",
                input: { path: "/tmp/test" },
              },
            ],
          },
        },
        {
          type: "result",
          result: "",
          is_error: false,
        },
      ];

      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
      const events = await collectEvents(adapter, {
        threadId: "t5",
        runId: "r5",
        messages: [],
        tools: [],
        context: [],
      });

      const snapshot = events.find((e) => e.type === "MESSAGES_SNAPSHOT") as
        | { messages: Array<Record<string, unknown>> }
        | undefined;
      expect(snapshot).toBeDefined();

      const assistantMsg = snapshot!.messages.find(
        (m: Record<string, unknown>) => m.role === "assistant",
      ) as { toolCalls?: Array<Record<string, unknown>> } | undefined;
      expect(assistantMsg).toBeDefined();

      const toolCall = assistantMsg!.toolCalls![0];
      const fn = toolCall.function as { name: string };
      expect(fn.name).toBe("Read");
      expect(toolCall.metadata).toEqual({ rawName: "Read" });
    });
  });

  describe("streaming path also carries rawName metadata in MESSAGES_SNAPSHOT", () => {
    it("includes rawName metadata on streamed MCP tool calls", async () => {
      mockStreamMessages = [
        {
          type: "stream_event",
          event: { type: "message_start" },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: {
              type: "tool_use",
              id: "tool-6",
              name: "mcp__srv__Write",
            },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: '{"path":"/tmp/out"}',
            },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_stop",
          },
        },
        {
          type: "stream_event",
          event: { type: "message_stop" },
        },
        {
          type: "result",
          result: "",
          is_error: false,
        },
      ];

      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
      const events = await collectEvents(adapter, {
        threadId: "t6",
        runId: "r6",
        messages: [],
        tools: [],
        context: [],
      });

      const snapshot = events.find((e) => e.type === "MESSAGES_SNAPSHOT") as
        | { messages: Array<Record<string, unknown>> }
        | undefined;
      expect(snapshot).toBeDefined();

      const assistantMsg = snapshot!.messages.find(
        (m: Record<string, unknown>) => m.role === "assistant",
      ) as { toolCalls?: Array<Record<string, unknown>> } | undefined;
      expect(assistantMsg).toBeDefined();

      const toolCall = assistantMsg!.toolCalls![0];
      const fn = toolCall.function as { name: string };
      expect(fn.name).toBe("Write");
      expect(toolCall.metadata).toEqual({ rawName: "mcp__srv__Write" });
    });
  });
});
