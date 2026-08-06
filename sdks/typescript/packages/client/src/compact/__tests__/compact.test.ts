import { compactEvents } from "../compact";
import {
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  CustomEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
} from "@ag-ui/core";

describe("Event Compaction", () => {
  describe("Text Message Compaction", () => {
    it("should compact multiple text message content events into one", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "user" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Hello" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: " " },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "world" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect(compacted[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Hello world");
      expect(compacted[2].type).toBe(EventType.TEXT_MESSAGE_END);
    });

    it("should move interleaved events to after text message events", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Processing" },
        { type: EventType.CUSTOM, id: "custom1", name: "thinking" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "..." },
        { type: EventType.CUSTOM, id: "custom2", name: "done-thinking" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(5);
      // Text message events should come first
      expect(compacted[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Processing...");
      expect(compacted[2].type).toBe(EventType.TEXT_MESSAGE_END);
      // Other events should come after
      expect(compacted[3].type).toBe(EventType.CUSTOM);
      expect((compacted[3] as CustomEvent & { id: string }).id).toBe("custom1");
      expect(compacted[4].type).toBe(EventType.CUSTOM);
      expect((compacted[4] as CustomEvent & { id: string }).id).toBe("custom2");
    });

    it("should handle multiple messages independently", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "user" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Hi" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg2", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg2", delta: "Hello" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg2", delta: " there" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg2" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(6);
      // First message
      expect(compacted[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect((compacted[0] as TextMessageStartEvent).messageId).toBe("msg1");
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Hi");
      expect(compacted[2].type).toBe(EventType.TEXT_MESSAGE_END);
      // Second message
      expect(compacted[3].type).toBe(EventType.TEXT_MESSAGE_START);
      expect((compacted[3] as TextMessageStartEvent).messageId).toBe("msg2");
      expect(compacted[4].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[4] as TextMessageContentEvent).delta).toBe("Hello there");
      expect(compacted[5].type).toBe(EventType.TEXT_MESSAGE_END);
    });

    it("should handle incomplete messages", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "user" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Incomplete" },
        // No END event
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(2);
      expect(compacted[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Incomplete");
    });

    it("should pass through non-text-message events unchanged", () => {
      const events = [
        { type: EventType.CUSTOM, id: "custom1", name: "event1" },
        { type: EventType.TOOL_CALL_START, toolCallId: "tool1", toolCallName: "search" },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toEqual(events);
    });

    it("should handle empty content deltas", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "user" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Hello" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Hello");
    });
  });

  describe("Tool Call Compaction", () => {
    it("should compact multiple tool call args events into one", () => {
      const events = [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "search",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"query": "' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: "weather" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: ' today"' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: "}" },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect(compacted[0].type).toBe(EventType.TOOL_CALL_START);
      expect(compacted[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[1] as ToolCallArgsEvent).delta).toBe('{"query": "weather today"}');
      expect(compacted[2].type).toBe(EventType.TOOL_CALL_END);
    });

    it("should move interleaved events to after tool call events", () => {
      const events = [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "calculate",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"a": ' },
        { type: EventType.CUSTOM, id: "custom1", name: "processing" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '10, "b": 20}' },
        { type: EventType.CUSTOM, id: "custom2", name: "calculating" },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(5);
      // Tool call events should come first
      expect(compacted[0].type).toBe(EventType.TOOL_CALL_START);
      expect(compacted[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[1] as ToolCallArgsEvent).delta).toBe('{"a": 10, "b": 20}');
      expect(compacted[2].type).toBe(EventType.TOOL_CALL_END);
      // Other events should come after
      expect(compacted[3].type).toBe(EventType.CUSTOM);
      expect((compacted[3] as CustomEvent & { id: string }).id).toBe("custom1");
      expect(compacted[4].type).toBe(EventType.CUSTOM);
      expect((compacted[4] as CustomEvent & { id: string }).id).toBe("custom2");
    });

    it("should handle multiple tool calls independently", () => {
      const events = [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "search",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"query": "test"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool2",
          toolCallName: "calculate",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool2", delta: '{"a": ' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool2", delta: "5}" },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool2" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(6);
      // First tool call
      expect(compacted[0].type).toBe(EventType.TOOL_CALL_START);
      expect((compacted[0] as ToolCallStartEvent).toolCallId).toBe("tool1");
      expect(compacted[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[1] as ToolCallArgsEvent).delta).toBe('{"query": "test"}');
      expect(compacted[2].type).toBe(EventType.TOOL_CALL_END);
      // Second tool call
      expect(compacted[3].type).toBe(EventType.TOOL_CALL_START);
      expect((compacted[3] as ToolCallStartEvent).toolCallId).toBe("tool2");
      expect(compacted[4].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[4] as ToolCallArgsEvent).delta).toBe('{"a": 5}');
      expect(compacted[5].type).toBe(EventType.TOOL_CALL_END);
    });

    it("should handle incomplete tool calls", () => {
      const events = [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "search",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"incomplete": ' },
        // No END event
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(2);
      expect(compacted[0].type).toBe(EventType.TOOL_CALL_START);
      expect(compacted[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[1] as ToolCallArgsEvent).delta).toBe('{"incomplete": ');
    });

    it("should handle empty args deltas", () => {
      const events = [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "search",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: "" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"test": true}' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: "" },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect((compacted[1] as ToolCallArgsEvent).delta).toBe('{"test": true}');
    });
  });

  describe("Mixed Compaction", () => {
    it("should handle text messages and tool calls together", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Let me " },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "search for that" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "search",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"q": "' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: 'test"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(6);
      // Text message
      expect(compacted[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Let me search for that");
      expect(compacted[2].type).toBe(EventType.TEXT_MESSAGE_END);
      // Tool call
      expect(compacted[3].type).toBe(EventType.TOOL_CALL_START);
      expect(compacted[4].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[4] as ToolCallArgsEvent).delta).toBe('{"q": "test"}');
      expect(compacted[5].type).toBe(EventType.TOOL_CALL_END);
    });
  });

  describe("State Compaction", () => {
    it("should compact multiple state snapshots into one per run", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { count: 1 } },
        { type: EventType.STATE_SNAPSHOT, snapshot: { count: 2 } },
        { type: EventType.STATE_SNAPSHOT, snapshot: { count: 3 } },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect(compacted[0].type).toBe(EventType.RUN_STARTED);
      expect(compacted[1].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ count: 3 });
      expect(compacted[2].type).toBe(EventType.RUN_FINISHED);
    });

    it("should compact snapshot + deltas into a single snapshot", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { count: 0, name: "test" } },
        { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/count", value: 1 }] },
        { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/count", value: 2 }] },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect(compacted[0].type).toBe(EventType.RUN_STARTED);
      expect(compacted[1].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ count: 2, name: "test" });
      expect(compacted[2].type).toBe(EventType.RUN_FINISHED);
    });

    it("should compact deltas-only into a single snapshot (starting from empty)", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/foo", value: "bar" }] },
        { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/baz", value: 42 }] },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect(compacted[0].type).toBe(EventType.RUN_STARTED);
      expect(compacted[1].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ foo: "bar", baz: 42 });
      expect(compacted[2].type).toBe(EventType.RUN_FINISHED);
    });

    it("should handle snapshot followed by delta that overwrites it", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { a: 1, b: 2 } },
        { type: EventType.STATE_DELTA, delta: [{ op: "remove", path: "/b" }] },
        { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/c", value: 3 }] },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ a: 1, c: 3 });
    });

    it("should handle multiple runs independently", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { step: 1 } },
        { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/step", value: 2 }] },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r2" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { step: 10 } },
        { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/step", value: 20 }] },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r2" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(6);
      // Run 1
      expect(compacted[0].type).toBe(EventType.RUN_STARTED);
      expect(compacted[1].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ step: 2 });
      expect(compacted[2].type).toBe(EventType.RUN_FINISHED);
      // Run 2
      expect(compacted[3].type).toBe(EventType.RUN_STARTED);
      expect(compacted[4].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[4] as StateSnapshotEvent).snapshot).toEqual({ step: 20 });
      expect(compacted[5].type).toBe(EventType.RUN_FINISHED);
    });

    it("should not emit state snapshot when no state events in run", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Hello" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(5);
      expect(compacted.filter((e) => e.type === EventType.STATE_SNAPSHOT)).toHaveLength(0);
    });

    it("should handle state events outside of runs", () => {
      const events = [
        { type: EventType.STATE_SNAPSHOT, snapshot: { x: 1 } },
        { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/x", value: 2 }] },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(1);
      expect(compacted[0].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[0] as StateSnapshotEvent).snapshot).toEqual({ x: 2 });
    });

    it("should handle snapshot after deltas within a run (snapshot resets state)", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/old", value: true }] },
        { type: EventType.STATE_SNAPSHOT, snapshot: { fresh: true } },
        { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/extra", value: 1 }] },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ fresh: true, extra: 1 });
    });

    it("should preserve non-state events alongside state compaction", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { count: 0 } },
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Hi" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
        { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/count", value: 1 }] },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(6);
      expect(compacted[0].type).toBe(EventType.RUN_STARTED);
      // Text message events
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(compacted[2].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(compacted[3].type).toBe(EventType.TEXT_MESSAGE_END);
      // Compacted state before RUN_FINISHED
      expect(compacted[4].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[4] as StateSnapshotEvent).snapshot).toEqual({ count: 1 });
      expect(compacted[5].type).toBe(EventType.RUN_FINISHED);
    });

    it("should flush state events before RUN_STARTED when they precede any run", () => {
      const events = [
        { type: EventType.STATE_SNAPSHOT, snapshot: { preRun: true } },
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { inRun: true } },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(4);
      expect(compacted[0].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[0] as StateSnapshotEvent).snapshot).toEqual({ preRun: true });
      expect(compacted[1].type).toBe(EventType.RUN_STARTED);
      expect(compacted[2].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[2] as StateSnapshotEvent).snapshot).toEqual({ inRun: true });
      expect(compacted[3].type).toBe(EventType.RUN_FINISHED);
    });

    it("should flush state events between runs", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { run: 1 } },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { between: true } },
        { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/extra", value: 1 }] },
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r2" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { run: 2 } },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r2" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(7);
      // Run 1
      expect(compacted[0].type).toBe(EventType.RUN_STARTED);
      expect(compacted[1].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ run: 1 });
      expect(compacted[2].type).toBe(EventType.RUN_FINISHED);
      // Between runs — flushed before RUN_STARTED
      expect(compacted[3].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[3] as StateSnapshotEvent).snapshot).toEqual({ between: true, extra: 1 });
      // Run 2
      expect(compacted[4].type).toBe(EventType.RUN_STARTED);
      expect(compacted[5].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[5] as StateSnapshotEvent).snapshot).toEqual({ run: 2 });
      expect(compacted[6].type).toBe(EventType.RUN_FINISHED);
    });

    it("should flush state on RUN_ERROR", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { count: 0 } },
        { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/count", value: 5 }] },
        { type: EventType.RUN_ERROR, threadId: "t1", runId: "r1", message: "something failed" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect(compacted[0].type).toBe(EventType.RUN_STARTED);
      expect(compacted[1].type).toBe(EventType.STATE_SNAPSHOT);
      expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ count: 5 });
      expect(compacted[2].type).toBe(EventType.RUN_ERROR);
    });

    it("should handle complex nested state with JSON patch operations", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        {
          type: EventType.STATE_SNAPSHOT,
          snapshot: { users: [{ name: "Alice", age: 30 }], settings: { theme: "dark" } },
        },
        {
          type: EventType.STATE_DELTA,
          delta: [{ op: "add", path: "/users/-", value: { name: "Bob", age: 25 } }],
        },
        {
          type: EventType.STATE_DELTA,
          delta: [{ op: "replace", path: "/settings/theme", value: "light" }],
        },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({
        users: [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
        ],
        settings: { theme: "light" },
      });
    });

    // Regression tests for #1720 — flushState used to start each batch
    // from `state = {}`, so a delta in a later flush that referenced
    // a path from an earlier flush's snapshot raised
    // OPERATION_PATH_CANNOT_ADD / JsonPointerException. flushState
    // now seeds from the prior batch's running state.

    it("carries state across runs when run 2 has only deltas (no snapshot)", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { run_log: [] } },
        {
          type: EventType.STATE_DELTA,
          delta: [{ op: "add", path: "/run_log/-", value: { kind: "token", text: "hi" } }],
        },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
        // Run 2: no STATE_SNAPSHOT — must inherit `/run_log` from run 1
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r2" },
        {
          type: EventType.STATE_DELTA,
          delta: [{ op: "add", path: "/run_log/-", value: { kind: "token", text: "there" } }],
        },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r2" },
      ];

      // Before the fix this throws OPERATION_PATH_CANNOT_ADD on run 2.
      expect(() => compactEvents(events)).not.toThrow();

      const compacted = compactEvents(events);
      const snapshots = compacted.filter(
        (e) => e.type === EventType.STATE_SNAPSHOT,
      ) as StateSnapshotEvent[];

      // Run 1 snapshot
      expect(snapshots[0].snapshot).toEqual({ run_log: [{ kind: "token", text: "hi" }] });
      // Run 2 snapshot has BOTH entries — state carried across runs
      expect(snapshots[1].snapshot).toEqual({
        run_log: [
          { kind: "token", text: "hi" },
          { kind: "token", text: "there" },
        ],
      });
    });

    it("does not throw when a post-run delta replaces a field from the prior snapshot", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { pipeline_stage: "classifier" } },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
        // Inter-run delta clears the stage; without the prior-batch
        // seed this raises JsonPointerException because /pipeline_stage
        // doesn't exist on a fresh `{}`.
        {
          type: EventType.STATE_DELTA,
          delta: [{ op: "replace", path: "/pipeline_stage", value: null }],
        },
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r2" },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r2" },
      ];

      expect(() => compactEvents(events)).not.toThrow();
    });

    it("trailing-only deltas (no run boundary) see prior state", () => {
      const events = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.STATE_SNAPSHOT, snapshot: { counter: 0 } },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
        // No more RUN events — these land in the trailing flush
        {
          type: EventType.STATE_DELTA,
          delta: [{ op: "replace", path: "/counter", value: 5 }],
        },
      ];

      expect(() => compactEvents(events)).not.toThrow();

      const compacted = compactEvents(events);
      const snapshots = compacted.filter(
        (e) => e.type === EventType.STATE_SNAPSHOT,
      ) as StateSnapshotEvent[];

      // Last snapshot reflects both the run-1 baseline AND the trailing delta
      expect(snapshots[snapshots.length - 1].snapshot).toEqual({ counter: 5 });
    });
  });
});
