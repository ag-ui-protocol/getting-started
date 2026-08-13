/**
 * Tests for messages-tuple stream mode support.
 *
 * When "events" stream mode doesn't produce on_chat_model_stream events
 * (e.g., LangGraph Platform with create_agent), the "messages-tuple" stream
 * mode provides streaming via [AIMessageChunk, metadata] tuples.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LangGraphAgent } from "./agent";
import { EventType } from "@ag-ui/client";

// Minimal config to construct the agent
function createAgent() {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });

  // Wire up a mock subscriber and activeRun so dispatchEvent works
  const events: any[] = [];
  (agent as any).subscriber = { next: (e: any) => events.push(e) };
  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
  };
  (agent as any).messagesInProcess = {};

  return { agent, events };
}

describe("messages-tuple stream mode", () => {
  describe("handleSingleEvent routing", () => {
    it("routes array events to handleMessagesTupleEvent when events mode is inactive", () => {
      const { agent, events } = createAgent();

      const chunk = [
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "Hello",
          response_metadata: {},
        },
        {},
      ];

      agent.handleSingleEventV2(chunk);

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
    });

    it("skips array events when events mode is active", () => {
      const { agent, events } = createAgent();

      // Simulate events mode producing data
      agent.handleSingleEventV2({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {
          chunk: {
            id: "msg-0",
            content: "test",
            response_metadata: { finish_reason: null },
          },
        },
      });
      const eventCountAfterEventsMode = events.length;

      // Now a messages-tuple array should be skipped
      agent.handleSingleEventV2([
        { type: "AIMessageChunk", id: "msg-1", content: "Hello", response_metadata: {} },
        {},
      ]);

      expect(events.length).toBe(eventCountAfterEventsMode);
    });

    it("passes non-array events through to parent handler", () => {
      const { agent, events } = createAgent();

      // A regular events-mode event should work normally
      agent.handleSingleEventV2({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {
          chunk: {
            id: "msg-1",
            content: "Hello",
            response_metadata: {},
          },
        },
      });

      expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_START)).toBe(
        true,
      );
    });
  });

  describe("handleMessagesTupleEvent text streaming", () => {
    it("emits TEXT_MESSAGE_START + CONTENT for first text chunk", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "Hello",
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: EventType.TEXT_MESSAGE_START,
        role: "assistant",
        messageId: "msg-1",
      });
      expect(events[1]).toMatchObject({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Hello",
      });
    });

    it("emits only CONTENT for subsequent text chunks", () => {
      const { agent, events } = createAgent();

      // First chunk starts the message
      agent.handleSingleEventV2([
        { type: "AIMessageChunk", id: "msg-1", content: "Hello", response_metadata: {} },
        {},
      ]);
      // Second chunk continues
      agent.handleSingleEventV2([
        { type: "AIMessageChunk", id: "msg-1", content: " world", response_metadata: {} },
        {},
      ]);

      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: " world",
      });
    });

    it("emits TEXT_MESSAGE_END on finish", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEventV2([
        { type: "AIMessageChunk", id: "msg-1", content: "Hello", response_metadata: {} },
        {},
      ]);
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);

      const endEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_END,
      );
      expect(endEvents).toHaveLength(1);
      expect(endEvents[0].messageId).toBe("msg-1");
    });
  });

  describe("handleMessagesTupleEvent tool call streaming", () => {
    it("emits TOOL_CALL_START + ARGS for tool call chunks", () => {
      const { agent, events } = createAgent();

      // Tool call start
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);

      expect(events[0]).toMatchObject({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "search",
      });

      // Tool call args
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [{ args: '{"query":' }],
          response_metadata: {},
        },
        {},
      ]);

      expect(events[1]).toMatchObject({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc-1",
        delta: '{"query":',
      });
    });

    it("emits TOOL_CALL_END on finish after tool call", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);

      const endEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_END,
      );
      expect(endEvents).toHaveLength(1);
      expect(endEvents[0].toolCallId).toBe("tc-1");
    });

    // B2 — a tool-calling turn finishes with finish_reason "tool_calls", not
    // "stop". Keying only on "stop" left the open tool call without its
    // TOOL_CALL_END. Any terminal finish_reason must close the open block.
    it('emits TOOL_CALL_END when finish_reason is "tool_calls"', () => {
      const { agent, events } = createAgent();

      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          response_metadata: { finish_reason: "tool_calls" },
        },
        {},
      ]);

      const endEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_END,
      );
      expect(endEvents).toHaveLength(1);
      expect(endEvents[0].toolCallId).toBe("tc-1");
    });

    // B2 — a truncated text turn finishes with "length"; it must still close.
    it('emits TEXT_MESSAGE_END when finish_reason is "length"', () => {
      const { agent, events } = createAgent();

      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "partial",
          response_metadata: {},
        },
        {},
      ]);
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          response_metadata: { finish_reason: "length" },
        },
        {},
      ]);

      const endEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_END,
      );
      expect(endEvents).toHaveLength(1);
    });
  });

  describe("handleMessagesTupleEvent edge cases", () => {
    it("skips non-AI chunks", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEventV2([
        { type: "HumanMessage", id: "msg-1", content: "Hello" },
        {},
      ]);

      expect(events).toHaveLength(0);
    });

    it("skips empty initialization chunks", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(0);
    });

    it("handles content as array with text block", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: [{ type: "text", text: "Hello from array" }],
          response_metadata: {},
        },
        {},
      ]);

      expect(events[1]).toMatchObject({
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Hello from array",
      });
    });

    it("ends text message when tool call starts mid-stream", () => {
      const { agent, events } = createAgent();

      // Start text
      agent.handleSingleEventV2([
        { type: "AIMessageChunk", id: "msg-1", content: "Let me search", response_metadata: {} },
        {},
      ]);

      // Tool call starts — should end the text message first
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);

      const textEnd = events.find((e) => e.type === EventType.TEXT_MESSAGE_END);
      const toolStart = events.find(
        (e) => e.type === EventType.TOOL_CALL_START,
      );
      expect(textEnd).toBeDefined();
      expect(toolStart).toBeDefined();

      // Text end should come before tool start
      const textEndIdx = events.indexOf(textEnd);
      const toolStartIdx = events.indexOf(toolStart);
      expect(textEndIdx).toBeLessThan(toolStartIdx);
    });

    it("reuses the same messageId for text that resumes after a tool call", () => {
      const { agent, events } = createAgent();

      // First text segment before tool call
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "Let me search",
          response_metadata: {},
        },
        {},
      ]);

      // Tool call starts — ends the text message
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);

      // Tool call finishes
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);

      // Second text segment after tool call — chunk.id is different (new model invocation)
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-2",
          content: "The result is 42",
          response_metadata: {},
        },
        {},
      ]);

      const textStarts = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      expect(textStarts.length).toBeGreaterThanOrEqual(1);
      // All text message start events must share the same messageId
      const firstId = textStarts[0].messageId;
      for (const start of textStarts) {
        expect(start.messageId).toBe(firstId);
      }

      // The content events after the tool call must also use the same messageId
      const contentAfterTool = events.filter(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_CONTENT &&
          e.delta === "The result is 42",
      );
      expect(contentAfterTool).toHaveLength(1);
      expect(contentAfterTool[0].messageId).toBe(firstId);
    });
  });

  describe("handleMessagesTupleEvent events mode - stable messageId", () => {
    it("reuses the same messageId for text that resumes after a tool call (events mode)", () => {
      const { agent, events } = createAgent();

      // First text segment
      agent.handleSingleEventV2({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {
          chunk: {
            id: "msg-abc",
            content: "Let me search",
            tool_call_chunks: [],
            response_metadata: {},
          },
        },
      });

      // Tool call arrives — triggers TEXT_MESSAGE_END + TOOL_CALL_START
      agent.handleSingleEventV2({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {
          chunk: {
            id: "msg-abc",
            content: "",
            tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
            response_metadata: {},
          },
        },
      });

      // Tool call ends
      agent.handleSingleEventV2({
        event: "on_chat_model_end",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {},
      });

      // Second text segment — different chunk.id from new model invocation
      agent.handleSingleEventV2({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {
          chunk: {
            id: "msg-xyz",
            content: "The result is 42",
            tool_call_chunks: [],
            response_metadata: {},
          },
        },
      });

      const textStarts = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      expect(textStarts.length).toBeGreaterThanOrEqual(1);
      const firstId = textStarts[0].messageId;
      for (const start of textStarts) {
        expect(start.messageId).toBe(firstId);
      }

      const contentAfterTool = events.filter(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_CONTENT &&
          e.delta === "The result is 42",
      );
      expect(contentAfterTool).toHaveLength(1);
      expect(contentAfterTool[0].messageId).toBe(firstId);
    });

    it("mints a fresh messageId when the graph transitions to a different node (events mode)", () => {
      // Multi-node scenario covering the events-mode read site
      // (on_chat_model_stream routed through handleSingleEvent's switch case,
      // not through handleMessagesTupleEvent). Pairs with the messages-tuple
      // multi-node test below.
      const { agent, events } = createAgent();
      (agent as any).activeRun.nodeName = "supervisor";

      // 1. Supervisor emits its routing message.
      agent.handleSingleEventV2({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {
          chunk: {
            id: "msg-sup",
            content: "Routing to billing",
            tool_call_chunks: [],
            response_metadata: {},
          },
        },
      });

      // 2. Supervisor's LLM call ends, clearing messagesInProcess.
      agent.handleSingleEventV2({
        event: "on_chat_model_end",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {},
      });

      // 3. Graph transitions to billing. handleNodeChange clears the pinned
      //    text message id, so the next text chunk mints fresh.
      agent.handleNodeChange("billing");

      // 4. Billing emits its response from a new LLM invocation.
      agent.handleSingleEventV2({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {
          chunk: {
            id: "msg-bil",
            content: "Here's your invoice",
            tool_call_chunks: [],
            response_metadata: {},
          },
        },
      });

      const textStarts = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      expect(textStarts).toHaveLength(2);
      expect(textStarts[0].messageId).toBe("msg-sup");
      expect(textStarts[1].messageId).toBe("msg-bil");
      expect(textStarts[0].messageId).not.toBe(textStarts[1].messageId);
    });

    it("reuses the same messageId across multiple text/tool cycles in one run", () => {
      // Three text segments separated by two tool calls all share one
      // messageId. Pins the invariant against any future "reset on tool end".
      const { agent, events } = createAgent();

      // Cycle 1: text → tool → finish
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-a",
          content: "First",
          response_metadata: {},
        },
        {},
      ]);
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-a",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-a",
          content: "",
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);

      // Cycle 2: text (new chunk id) → tool → finish
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-b",
          content: "Second",
          response_metadata: {},
        },
        {},
      ]);
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-b",
          content: "",
          tool_call_chunks: [{ id: "tc-2", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-b",
          content: "",
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);

      // Cycle 3: final text segment with a third chunk id
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-c",
          content: "Third",
          response_metadata: {},
        },
        {},
      ]);

      const textStarts = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      expect(textStarts.length).toBeGreaterThanOrEqual(3);
      const firstId = textStarts[0].messageId;
      for (const start of textStarts) {
        expect(start.messageId).toBe(firstId);
      }

      const deltasToId = new Map<string, string>();
      for (const e of events) {
        if (e.type === EventType.TEXT_MESSAGE_CONTENT) {
          deltasToId.set(e.delta, e.messageId);
        }
      }
      expect(deltasToId.get("First")).toBe(firstId);
      expect(deltasToId.get("Second")).toBe(firstId);
      expect(deltasToId.get("Third")).toBe(firstId);
    });

    it("does not reuse a prior run's messageId on a new run", () => {
      // Mimic the run-boundary reset that runAgentStream performs at the
      // start of each run by replacing activeRun wholesale.
      const { agent, events } = createAgent();

      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "run1-chunk",
          content: "Hello",
          response_metadata: {},
        },
        {},
      ]);
      const run1Starts = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      expect(run1Starts).toHaveLength(1);
      const run1Id = run1Starts[0].messageId;

      // Run boundary: runAgentStream replaces activeRun with a fresh object
      (agent as any).activeRun = {
        id: "run-2",
        threadId: "thread-1",
        hasFunctionStreaming: false,
      };
      (agent as any).messagesInProcess = {};
      events.length = 0;

      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "run2-chunk",
          content: "World",
          response_metadata: {},
        },
        {},
      ]);

      const run2Starts = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      expect(run2Starts).toHaveLength(1);
      expect(run2Starts[0].messageId).not.toBe(run1Id);
      expect(run2Starts[0].messageId).toBe("run2-chunk");
    });

    it("mints a fresh messageId when the graph transitions to a different node", () => {
      // Different nodes within one run produce separate message bubbles.
      // Mimics a supervisor → specialist agent flow. Drives the test through
      // handleNodeChange (the same code path the outer event loop uses to
      // update activeRun.nodeName) so the test covers the loop+handler
      // interaction, not just the handler in isolation.
      const { agent, events } = createAgent();
      (agent as any).activeRun.nodeName = "supervisor";

      // 1. Supervisor emits its routing message.
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-sup",
          content: "Routing to billing",
          response_metadata: {},
        },
        {},
      ]);

      // 2. Supervisor's stream finishes. Clears messagesInProcess so the next
      //    text chunk enters the "new stream" branch.
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-sup",
          content: "",
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);

      // 3. Graph transitions to the billing node. This is what the outer
      //    loop does when it sees a different langgraph_node in event
      //    metadata; we drive it directly to mimic that side effect.
      agent.handleNodeChange("billing");

      // 4. Billing emits its response. Different node, so fresh id.
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "msg-bil",
          content: "Here's your invoice",
          response_metadata: {},
        },
        {},
      ]);

      const textStarts = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      expect(textStarts).toHaveLength(2);
      expect(textStarts[0].messageId).toBe("msg-sup");
      expect(textStarts[1].messageId).toBe("msg-bil");
      expect(textStarts[0].messageId).not.toBe(textStarts[1].messageId);
    });

    it("reuses the same messageId across LLM invocations within a single node", () => {
      // The canonical bug case from #1317: text → tool → text within one
      // node, where the second text comes from a fresh LLM invocation with
      // a different chunk.id. Confirms node-boundary scoping doesn't break
      // the original fix.
      const { agent, events } = createAgent();
      (agent as any).activeRun.nodeName = "agent";

      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "chunk-1",
          content: "Let me search",
          response_metadata: {},
        },
        {},
      ]);
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "chunk-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "chunk-1",
          content: "",
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);
      // No node change. Fresh LLM invocation, different chunk.id.
      agent.handleSingleEventV2([
        {
          type: "AIMessageChunk",
          id: "chunk-2",
          content: "The answer is 42",
          response_metadata: {},
        },
        {},
      ]);

      const textStarts = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      expect(textStarts.length).toBeGreaterThanOrEqual(2);
      const firstId = textStarts[0].messageId;
      for (const start of textStarts) {
        expect(start.messageId).toBe(firstId);
      }
      expect(firstId).toBe("chunk-1");
    });

    it("ManuallyEmitMessage uses its own messageId and does not mutate currentTextMessageId", () => {
      const { agent, events } = createAgent();
      (agent as any).activeRun.currentTextMessageId = "stable-stream-id";

      agent.handleSingleEventV2({
        event: "on_custom_event",
        name: "manually_emit_message",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: { message_id: "user-supplied-id", message: "Hello" },
      });

      const textStarts = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      expect(textStarts).toHaveLength(1);
      expect(textStarts[0].messageId).toBe("user-supplied-id");
      expect((agent as any).activeRun.currentTextMessageId).toBe(
        "stable-stream-id",
      );
    });
  });
});
