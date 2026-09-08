import { EventType } from "@ag-ui/client";
import { Agent } from "@mastra/core/agent";
import { MockMemory } from "@mastra/core/memory";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { MastraAgent } from "../mastra";
import { makeInput, collectEvents } from "./helpers";

function createStreamModel(chunks: any[]) {
  return new MastraLanguageModelV2Mock({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
      request: { body: {} },
      response: undefined,
    }),
  });
}

function createTextStreamModel(text: string) {
  return createStreamModel([
    { type: "text-delta" as const, id: "text-1", delta: text },
    {
      type: "finish" as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "stop" as const,
    },
  ]);
}

// Fall-back path: an LLM that emits ONLY the final tool-call (no incremental
// tool-input-* chunks). Mirrors older @mastra/core in the supported 1.0.x floor.
function createToolCallStreamModel(
  toolName: string,
  toolArgs: Record<string, unknown>,
) {
  return createStreamModel([
    {
      type: "tool-call" as const,
      toolCallId: "tc-1",
      toolName,
      input: JSON.stringify(toolArgs),
    },
    {
      type: "finish" as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "tool-calls" as const,
    },
  ]);
}

// Streaming path: an LLM that streams the tool-call args as incremental
// tool-input-delta chunks (Mastra maps these to tool-call-delta chunks). The
// `argChunks` are raw JSON-text fragments that concatenate to a valid args JSON.
function createStreamingToolCallModel(
  toolName: string,
  toolCallId: string,
  argChunks: string[],
) {
  return createStreamModel([
    { type: "tool-input-start" as const, id: toolCallId, toolName },
    ...argChunks.map((delta) => ({
      type: "tool-input-delta" as const,
      id: toolCallId,
      delta,
    })),
    { type: "tool-input-end" as const, id: toolCallId },
    {
      type: "tool-call" as const,
      toolCallId,
      toolName,
      input: argChunks.join(""),
    },
    {
      type: "finish" as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "tool-calls" as const,
    },
  ]);
}

function createTestAgent(model: any, opts?: { memory?: MockMemory }) {
  return new Agent({
    id: "test-agent",
    name: "test-agent",
    instructions: "Test",
    model,
    ...opts,
  });
}

function wrapAgent(agent: Agent, opts?: { resourceId?: string }) {
  return new MastraAgent({
    agentId: agent.name,
    agent,
    resourceId: opts?.resourceId ?? "resource-1",
  });
}

describe("integration with real Mastra Agent", () => {
  describe("text streaming", () => {
    it("emits RUN_STARTED, TEXT_MESSAGE_CHUNK, RUN_FINISHED for a simple text response", async () => {
      const agent = createTestAgent(createTextStreamModel("Hello world"));
      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({ messages: [{ id: "1", role: "user", content: "Hi" }] }),
      );

      const types = events.map((e) => e.type);
      expect(types[0]).toBe(EventType.RUN_STARTED);
      expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);

      const textChunks = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      );
      expect(textChunks.length).toBeGreaterThan(0);
    });

    it("text chunks share the same messageId within a turn", async () => {
      const model = createStreamModel([
        { type: "text-delta" as const, id: "t1", delta: "Part 1 " },
        { type: "text-delta" as const, id: "t1", delta: "Part 2" },
        {
          type: "finish" as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          finishReason: "stop" as const,
        },
      ]);
      const agent = createTestAgent(model);

      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      const textChunks = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      );
      if (textChunks.length >= 2) {
        expect((textChunks[0] as any).messageId).toBe(
          (textChunks[1] as any).messageId,
        );
      }
    });
  });

  describe("tool calls", () => {
    const weatherTools = [
      {
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ];

    it("streams tool-call args incrementally when the model emits arg deltas", async () => {
      // Two arg-text fragments that concatenate to {"city":"NYC"}
      const argChunks = ['{"city":', '"NYC"}'];
      const agent = createTestAgent(
        createStreamingToolCallModel("get_weather", "tc-1", argChunks),
      );
      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "What's the weather?" }],
          tools: weatherTools,
        }),
      );

      const toolStarts = events.filter(
        (e) => e.type === EventType.TOOL_CALL_START,
      );
      expect(toolStarts).toHaveLength(1);
      expect((toolStarts[0] as any).toolCallName).toBe("get_weather");
      expect((toolStarts[0] as any).toolCallId).toBe("tc-1");

      // The whole point: args arrive as MULTIPLE deltas, not a single blob.
      const toolArgs = events.filter(
        (e) => e.type === EventType.TOOL_CALL_ARGS,
      );
      expect(toolArgs.length).toBe(argChunks.length);
      expect(toolArgs.every((e) => (e as any).toolCallId === "tc-1")).toBe(
        true,
      );
      // Concatenated deltas reconstruct the full args JSON.
      const assembled = toolArgs.map((e) => (e as any).delta).join("");
      expect(assembled).toBe('{"city":"NYC"}');
      expect(JSON.parse(assembled)).toEqual({ city: "NYC" });

      // Exactly one START and one END bracket the streamed args.
      const toolEnds = events.filter((e) => e.type === EventType.TOOL_CALL_END);
      expect(toolEnds).toHaveLength(1);

      // Ordering: START before all ARGS, all ARGS before END.
      const types = events.map((e) => e.type);
      const startIdx = types.indexOf(EventType.TOOL_CALL_START);
      const endIdx = types.indexOf(EventType.TOOL_CALL_END);
      const argIdxs = types
        .map((t, i) => (t === EventType.TOOL_CALL_ARGS ? i : -1))
        .filter((i) => i !== -1);
      expect(startIdx).toBeLessThan(Math.min(...argIdxs));
      expect(Math.max(...argIdxs)).toBeLessThan(endIdx);
    });

    it("falls back to a single TOOL_CALL_ARGS when the model emits no arg deltas", async () => {
      // Floor / backwards-compat: @mastra/core that emits only the final
      // tool-call chunk (no tool-call-delta) must still produce a clean
      // START + single full-args ARGS + END.
      const agent = createTestAgent(
        createToolCallStreamModel("get_weather", { city: "NYC" }),
      );
      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "What's the weather?" }],
          tools: weatherTools,
        }),
      );

      const toolStarts = events.filter(
        (e) => e.type === EventType.TOOL_CALL_START,
      );
      expect(toolStarts).toHaveLength(1);
      expect((toolStarts[0] as any).toolCallName).toBe("get_weather");

      const toolArgs = events.filter(
        (e) => e.type === EventType.TOOL_CALL_ARGS,
      );
      // Exactly one delta carrying the complete args.
      expect(toolArgs).toHaveLength(1);
      expect(JSON.parse((toolArgs[0] as any).delta)).toEqual({ city: "NYC" });

      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_END),
      ).toHaveLength(1);
    });
  });

  describe("working memory", () => {
    it("completes successfully with working memory enabled", async () => {
      const memory = new MockMemory({ enableWorkingMemory: true });
      const agent = createTestAgent(
        createTextStreamModel("I'll remember that."),
        { memory },
      );

      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "My name is Alice" }],
        }),
      );

      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    });

    it("STATE_SNAPSHOT is emitted before RUN_FINISHED when memory is configured", async () => {
      const memory = new MockMemory({ enableWorkingMemory: true });
      const agent = createTestAgent(createTextStreamModel("ok"), { memory });

      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      const types = events.map((e) => e.type);
      const finishedIdx = types.indexOf(EventType.RUN_FINISHED);
      const snapshotIdx = types.indexOf(EventType.STATE_SNAPSHOT);

      if (snapshotIdx !== -1) {
        expect(finishedIdx).toBeGreaterThan(snapshotIdx);
      }
    });
  });

  describe("event ordering", () => {
    it("RUN_STARTED and RUN_FINISHED carry correct threadId and runId", async () => {
      const agent = createTestAgent(createTextStreamModel("ok"));

      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          threadId: "my-thread",
          runId: "my-run",
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      const runStarted = events.find(
        (e) => e.type === EventType.RUN_STARTED,
      ) as any;
      const runFinished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;

      expect(runStarted.threadId).toBe("my-thread");
      expect(runStarted.runId).toBe("my-run");
      expect(runFinished.threadId).toBe("my-thread");
      expect(runFinished.runId).toBe("my-run");
    });
  });

  describe("message conversion", () => {
    it("handles a multi-message conversation without errors", async () => {
      const agent = createTestAgent(
        createTextStreamModel("I see the full history."),
      );

      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [
            { id: "1", role: "user", content: "Hello" },
            { id: "2", role: "assistant", content: "Hi there!" },
            { id: "3", role: "user", content: "How are you?" },
          ],
        }),
      );

      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    });
  });
});
