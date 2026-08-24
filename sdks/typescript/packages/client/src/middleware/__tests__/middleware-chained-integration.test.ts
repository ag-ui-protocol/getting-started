import { AbstractAgent } from "@/agent";
import { Middleware } from "@/middleware";
import type { EventWithState } from "@/middleware/middleware";
import {
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
  TextMessageChunkEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallChunkEvent,
  ToolCallResultEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  MessagesSnapshotEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";
import { describe, it, expect, vi } from "vitest";

// Mock uuid so runAgent() doesn't generate random IDs
vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue("mock-uuid"),
}));

// Mock structuredClone to work in test environment
vi.mock("@/utils", async () => {
  const actual = await vi.importActual<typeof import("@/utils")>("@/utils");
  return {
    ...actual,
    structuredClone_: (obj: any) => {
      if (obj === undefined) return undefined;
      const jsonString = JSON.stringify(obj);
      if (jsonString === undefined || jsonString === "undefined") return undefined;
      return JSON.parse(jsonString);
    },
  };
});

// ── Reusable helpers ─────────────────────────────────────────────────────────

/** Narrow a message to the assistant role, failing the test otherwise. */
function expectAssistantMessage(message: Message | undefined) {
  if (message?.role !== "assistant") {
    throw new Error(`Expected assistant message, got role ${message?.role}`);
  }
  return message;
}

/**
 * Uses runNextWithState and captures { messages, state } at RUN_FINISHED.
 * This is the middleware pattern that broke before the fix when chained:
 * the outer wrapper lacked .messages, causing defaultApplyEvents to fail.
 */
class CapturingMiddleware extends Middleware {
  capturedMessages: Message[] = [];
  capturedState: any = undefined;
  capturedEventsWithState: EventWithState[] = [];

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.runNextWithState(input, next).pipe((source) => {
      return new Observable<BaseEvent>((subscriber) => {
        source.subscribe({
          next: (ews: EventWithState) => {
            this.capturedEventsWithState.push(ews);
            if (ews.event.type === EventType.RUN_FINISHED) {
              this.capturedMessages = ews.messages;
              this.capturedState = ews.state;
            }
            subscriber.next(ews.event);
          },
          complete: () => subscriber.complete(),
          error: (err) => subscriber.error(err),
        });
      });
    });
  }
}

/**
 * A pass-through middleware that calls runNext (no state tracking).
 */
class PassThroughMiddleware extends Middleware {
  invoked = false;

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    this.invoked = true;
    return this.runNext(input, next);
  }
}

/**
 * A middleware that injects a STATE_SNAPSHOT after RUN_STARTED.
 * Verifies that middleware can enrich the event stream and that
 * downstream middlewares see the injected state.
 */
class EventInjectingMiddleware extends Middleware {
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.runNext(input, next).subscribe({
        next: (event) => {
          subscriber.next(event);
          // Inject a state snapshot right after RUN_STARTED
          if (event.type === EventType.RUN_STARTED) {
            subscriber.next({
              type: EventType.STATE_SNAPSHOT,
              snapshot: { injected: true },
            } as StateSnapshotEvent);
          }
        },
        complete: () => subscriber.complete(),
        error: (err) => subscriber.error(err),
      });
    });
  }
}

// ── Agents ───────────────────────────────────────────────────────────────────

/**
 * Emits: RUN_STARTED → TEXT_MESSAGE_CHUNK → RUN_FINISHED.
 * TEXT_MESSAGE_CHUNK is expanded by transformChunks into
 * TEXT_MESSAGE_START + TEXT_MESSAGE_CONTENT + TEXT_MESSAGE_END.
 */
class TextChunkAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        role: "assistant",
        delta: "Hello from agent",
      } as TextMessageChunkEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

/**
 * Emits full (non-chunk) text message events — no transformation needed.
 */
class FullTextAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-1",
        role: "assistant",
      } as TextMessageStartEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Full text",
      } as TextMessageContentEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-1",
      } as TextMessageEndEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

/**
 * Emits a TOOL_CALL_CHUNK which gets transformed into
 * TOOL_CALL_START + TOOL_CALL_ARGS + TOOL_CALL_END, then a TOOL_CALL_RESULT.
 */
class ToolCallChunkAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc-1",
        toolCallName: "get_weather",
        parentMessageId: "tool-msg-1",
        delta: '{"city":"NYC"}',
      } as ToolCallChunkEvent);
      // RUN_FINISHED closes the pending tool call chunk (TOOL_CALL_END emitted)
      subscriber.next({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tool-result-1",
        toolCallId: "tc-1",
        content: "72°F",
      } as ToolCallResultEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

/**
 * Emits full (non-chunk) tool call events.
 */
class FullToolCallAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "search",
        parentMessageId: "tool-msg-1",
      } as ToolCallStartEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc-1",
        delta: '{"q":"test"}',
      } as ToolCallArgsEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_END,
        toolCallId: "tc-1",
      } as ToolCallEndEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tool-result-1",
        toolCallId: "tc-1",
        content: "result",
      } as ToolCallResultEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

/**
 * Emits text AND state events for verifying combined propagation.
 */
class TextAndStateAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.STATE_SNAPSHOT,
        snapshot: { temperature: 72 },
      } as StateSnapshotEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        role: "assistant",
        delta: "Weather is nice",
      } as TextMessageChunkEvent);
      subscriber.next({
        type: EventType.STATE_DELTA,
        delta: [{ op: "replace", path: "/temperature", value: 75 }],
      } as StateDeltaEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

/**
 * Emits multiple text messages and a MESSAGES_SNAPSHOT that replaces them.
 */
class MessagesSnapshotAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      // Emit a text message first
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-1",
        role: "assistant",
      } as TextMessageStartEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "original",
      } as TextMessageContentEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-1",
      } as TextMessageEndEvent);
      // Now emit a MESSAGES_SNAPSHOT that replaces the conversation
      subscriber.next({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "snap-1", role: "user", content: "question" },
          { id: "snap-2", role: "assistant", content: "answer" },
        ],
      } as MessagesSnapshotEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

/**
 * Emits multiple sequential text message chunks (different message IDs).
 */
class MultiMessageAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        role: "assistant",
        delta: "First",
      } as TextMessageChunkEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-2",
        role: "assistant",
        delta: "Second",
      } as TextMessageChunkEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

/**
 * Emits a text message followed by a tool call (mixed event types).
 */
class TextThenToolAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      // Text message
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        role: "assistant",
        delta: "Let me search",
      } as TextMessageChunkEvent);
      // Tool call (closes the pending text chunk first)
      subscriber.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "search",
        parentMessageId: "msg-1",
      } as ToolCallStartEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc-1",
        delta: '{"q":"test"}',
      } as ToolCallArgsEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_END,
        toolCallId: "tc-1",
      } as ToolCallEndEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tool-result-1",
        toolCallId: "tc-1",
        content: "found it",
      } as ToolCallResultEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Chained middleware integration (via runAgent)", () => {
  // ─── Basic chaining ────────────────────────────────────────────────────────

  describe("basic chaining with TEXT_MESSAGE_CHUNK transformation", () => {
    it("two CapturingMiddlewares both track messages correctly", async () => {
      const inner = new CapturingMiddleware();
      const outer = new CapturingMiddleware();

      const agent = new TextChunkAgent({ threadId: "t1" });
      agent.use(outer, inner);

      const { newMessages } = await agent.runAgent();

      expect(newMessages).toHaveLength(1);
      expect(newMessages[0]).toMatchObject({ role: "assistant", content: "Hello from agent" });

      expect(inner.capturedMessages).toHaveLength(1);
      expect(inner.capturedMessages[0]).toMatchObject({ role: "assistant", content: "Hello from agent" });

      // This was the broken case: outer middleware's `next` was a bare { run } wrapper
      expect(outer.capturedMessages).toHaveLength(1);
      expect(outer.capturedMessages[0]).toMatchObject({ role: "assistant", content: "Hello from agent" });
    });

    it("three CapturingMiddlewares all track messages correctly", async () => {
      const innermost = new CapturingMiddleware();
      const middle = new CapturingMiddleware();
      const outermost = new CapturingMiddleware();

      const agent = new TextChunkAgent({ threadId: "t1" });
      agent.use(outermost, middle, innermost);

      await agent.runAgent();

      for (const mw of [innermost, middle, outermost]) {
        expect(mw.capturedMessages).toHaveLength(1);
        expect(mw.capturedMessages[0]).toMatchObject({ role: "assistant", content: "Hello from agent" });
      }
    });
  });

  // ─── Full text events (no chunk transformation) ────────────────────────────

  describe("full text message events (no chunk transformation)", () => {
    it("chained middlewares track full text message events", async () => {
      const inner = new CapturingMiddleware();
      const outer = new CapturingMiddleware();

      const agent = new FullTextAgent({ threadId: "t1" });
      agent.use(outer, inner);

      await agent.runAgent();

      for (const mw of [inner, outer]) {
        expect(mw.capturedMessages).toHaveLength(1);
        expect(mw.capturedMessages[0]).toMatchObject({ role: "assistant", content: "Full text" });
      }
    });
  });

  // ─── Tool call chunk transformation ────────────────────────────────────────

  describe("TOOL_CALL_CHUNK transformation", () => {
    it("chained middlewares track tool call messages from chunks", async () => {
      const inner = new CapturingMiddleware();
      const outer = new CapturingMiddleware();

      const agent = new ToolCallChunkAgent({ threadId: "t1" });
      agent.use(outer, inner);

      await agent.runAgent();

      // Should have: assistant message with tool call + tool result message
      for (const mw of [inner, outer]) {
        expect(mw.capturedMessages).toHaveLength(2);

        // First message: assistant with tool calls
        const assistantMsg = expectAssistantMessage(mw.capturedMessages[0]);
        expect(assistantMsg.role).toBe("assistant");
        expect(assistantMsg.toolCalls).toHaveLength(1);
        expect(assistantMsg.toolCalls![0]).toMatchObject({
          id: "tc-1",
          function: { name: "get_weather", arguments: '{"city":"NYC"}' },
        });

        // Second message: tool result
        const toolMsg = mw.capturedMessages[1];
        expect(toolMsg.role).toBe("tool");
        expect(toolMsg.content).toBe("72°F");
      }
    });
  });

  // ─── Full tool call events (no chunk transformation) ───────────────────────

  describe("full tool call events (no chunk transformation)", () => {
    it("chained middlewares track full tool call events", async () => {
      const inner = new CapturingMiddleware();
      const outer = new CapturingMiddleware();

      const agent = new FullToolCallAgent({ threadId: "t1" });
      agent.use(outer, inner);

      await agent.runAgent();

      for (const mw of [inner, outer]) {
        expect(mw.capturedMessages).toHaveLength(2);

        const assistantMsg = expectAssistantMessage(mw.capturedMessages[0]);
        expect(assistantMsg.role).toBe("assistant");
        expect(assistantMsg.toolCalls).toHaveLength(1);
        expect(assistantMsg.toolCalls![0]).toMatchObject({
          id: "tc-1",
          function: { name: "search", arguments: '{"q":"test"}' },
        });

        const toolMsg = mw.capturedMessages[1];
        expect(toolMsg.role).toBe("tool");
        expect(toolMsg.content).toBe("result");
      }
    });
  });

  // ─── State propagation ─────────────────────────────────────────────────────

  describe("state propagation", () => {
    it("chained middlewares propagate STATE_SNAPSHOT and STATE_DELTA", async () => {
      const inner = new CapturingMiddleware();
      const outer = new CapturingMiddleware();

      const agent = new TextAndStateAgent({ threadId: "t1" });
      agent.use(outer, inner);

      await agent.runAgent();

      // Both middlewares should see the final state after the delta was applied
      expect(inner.capturedState).toEqual({ temperature: 75 });
      expect(outer.capturedState).toEqual({ temperature: 75 });

      // Both should have captured the text message
      expect(inner.capturedMessages).toHaveLength(1);
      expect(outer.capturedMessages).toHaveLength(1);
    });

    it("state evolves incrementally across events in each middleware layer", async () => {
      const mw = new CapturingMiddleware();

      const agent = new TextAndStateAgent({ threadId: "t1" });
      agent.use(mw);

      await agent.runAgent();

      // Walk the captured events-with-state to verify incremental state tracking
      const stateSnapshots = mw.capturedEventsWithState.filter(
        (e) => e.event.type === EventType.STATE_SNAPSHOT,
      );
      expect(stateSnapshots).toHaveLength(1);
      expect(stateSnapshots[0].state).toEqual({ temperature: 72 });

      const stateDeltas = mw.capturedEventsWithState.filter(
        (e) => e.event.type === EventType.STATE_DELTA,
      );
      expect(stateDeltas).toHaveLength(1);
      expect(stateDeltas[0].state).toEqual({ temperature: 75 });
    });
  });

  // ─── MESSAGES_SNAPSHOT ─────────────────────────────────────────────────────

  describe("MESSAGES_SNAPSHOT handling", () => {
    it("chained middlewares see snapshot-replaced messages", async () => {
      const inner = new CapturingMiddleware();
      const outer = new CapturingMiddleware();

      const agent = new MessagesSnapshotAgent({ threadId: "t1" });
      agent.use(outer, inner);

      await agent.runAgent();

      // After MESSAGES_SNAPSHOT, messages should be replaced
      for (const mw of [inner, outer]) {
        expect(mw.capturedMessages).toHaveLength(2);
        expect(mw.capturedMessages[0]).toMatchObject({ id: "snap-1", role: "user", content: "question" });
        expect(mw.capturedMessages[1]).toMatchObject({ id: "snap-2", role: "assistant", content: "answer" });
      }
    });
  });

  // ─── Multiple sequential messages ──────────────────────────────────────────

  describe("multiple sequential text messages", () => {
    it("chained middlewares track multiple text messages from chunks", async () => {
      const inner = new CapturingMiddleware();
      const outer = new CapturingMiddleware();

      const agent = new MultiMessageAgent({ threadId: "t1" });
      agent.use(outer, inner);

      await agent.runAgent();

      for (const mw of [inner, outer]) {
        expect(mw.capturedMessages).toHaveLength(2);
        expect(mw.capturedMessages[0]).toMatchObject({ id: "msg-1", content: "First" });
        expect(mw.capturedMessages[1]).toMatchObject({ id: "msg-2", content: "Second" });
      }
    });
  });

  // ─── Mixed text + tool call events ─────────────────────────────────────────

  describe("mixed text and tool call events", () => {
    it("chained middlewares track text message followed by tool call", async () => {
      const inner = new CapturingMiddleware();
      const outer = new CapturingMiddleware();

      const agent = new TextThenToolAgent({ threadId: "t1" });
      agent.use(outer, inner);

      await agent.runAgent();

      for (const mw of [inner, outer]) {
        // msg-1 should be an assistant message with content AND tool calls
        // (TOOL_CALL_START with parentMessageId "msg-1" attaches to the existing message)
        const msg1 = expectAssistantMessage(mw.capturedMessages.find((m) => m.id === "msg-1"));
        expect(msg1).toBeDefined();
        expect(msg1.role).toBe("assistant");
        expect(msg1.content).toBe("Let me search");
        expect(msg1.toolCalls).toHaveLength(1);
        expect(msg1.toolCalls![0]).toMatchObject({
          id: "tc-1",
          function: { name: "search" },
        });

        // tool result
        const toolResult = mw.capturedMessages.find((m) => m.role === "tool");
        expect(toolResult).toBeDefined();
        expect(toolResult!.content).toBe("found it");
      }
    });
  });

  // ─── Mixed middleware types ────────────────────────────────────────────────

  describe("mixed middleware types in chain", () => {
    it("CapturingMiddleware + PassThroughMiddleware works", async () => {
      const passThrough = new PassThroughMiddleware();
      const capturing = new CapturingMiddleware();

      const agent = new TextChunkAgent({ threadId: "t1" });
      agent.use(capturing, passThrough);

      await agent.runAgent();

      expect(passThrough.invoked).toBe(true);
      expect(capturing.capturedMessages).toHaveLength(1);
      expect(capturing.capturedMessages[0]).toMatchObject({
        role: "assistant",
        content: "Hello from agent",
      });
    });

    it("PassThroughMiddleware + CapturingMiddleware (reversed order) works", async () => {
      const passThrough = new PassThroughMiddleware();
      const capturing = new CapturingMiddleware();

      const agent = new TextChunkAgent({ threadId: "t1" });
      agent.use(passThrough, capturing);

      await agent.runAgent();

      expect(passThrough.invoked).toBe(true);
      expect(capturing.capturedMessages).toHaveLength(1);
      expect(capturing.capturedMessages[0]).toMatchObject({
        role: "assistant",
        content: "Hello from agent",
      });
    });

    it("EventInjectingMiddleware + CapturingMiddleware works", async () => {
      const injecting = new EventInjectingMiddleware();
      const capturing = new CapturingMiddleware();

      const agent = new TextChunkAgent({ threadId: "t1" });
      // injecting is inner (wraps agent), capturing is outer (wraps injecting)
      agent.use(capturing, injecting);

      await agent.runAgent();

      expect(capturing.capturedMessages).toHaveLength(1);
      expect(capturing.capturedMessages[0]).toMatchObject({
        role: "assistant",
        content: "Hello from agent",
      });
      // The injected state should be visible
      expect(capturing.capturedState).toMatchObject({ injected: true });
    });
  });

  // ─── Initial messages / pre-existing state ─────────────────────────────────

  describe("agent with initial messages", () => {
    it("agent.messages accumulates initial + new messages through middleware chain", async () => {
      const inner = new CapturingMiddleware();
      const outer = new CapturingMiddleware();

      const agent = new TextChunkAgent({
        threadId: "t1",
        initialMessages: [{ id: "existing", role: "user", content: "Hi" }],
      });
      agent.use(outer, inner);

      await agent.runAgent();

      // Agent's own messages should contain initial + new
      expect(agent.messages).toHaveLength(2);
      expect(agent.messages[0]).toMatchObject({ role: "user", content: "Hi" });
      expect(agent.messages[1]).toMatchObject({ role: "assistant", content: "Hello from agent" });

      // Middlewares see messages via the getter (agent.messages), which includes
      // both initial and new messages by the time RUN_FINISHED fires
      for (const mw of [inner, outer]) {
        expect(mw.capturedMessages).toHaveLength(2);
        expect(mw.capturedMessages[0]).toMatchObject({ role: "user", content: "Hi" });
        expect(mw.capturedMessages[1]).toMatchObject({ role: "assistant", content: "Hello from agent" });
      }
    });

    it("initial state is preserved when no state events are emitted", async () => {
      const mw = new CapturingMiddleware();

      const agent = new TextChunkAgent({
        threadId: "t1",
        initialState: { preserved: true },
      });
      agent.use(mw);

      await agent.runAgent();

      // Without STATE_SNAPSHOT/STATE_DELTA events, the initial state should be preserved
      expect(mw.capturedState).toEqual({ preserved: true });
    });
  });

  // ─── Event-with-state tracking across all event types ──────────────────────

  describe("EventWithState tracking across event types", () => {
    it("messages accumulate correctly at each event in the stream", async () => {
      const mw = new CapturingMiddleware();

      const agent = new FullTextAgent({ threadId: "t1" });
      agent.use(mw);

      await agent.runAgent();

      const eventTypes = mw.capturedEventsWithState.map((e) => e.event.type);

      // transformChunks is a no-op for full events, so we get:
      // RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, RUN_FINISHED
      expect(eventTypes).toContain(EventType.RUN_STARTED);
      expect(eventTypes).toContain(EventType.TEXT_MESSAGE_START);
      expect(eventTypes).toContain(EventType.TEXT_MESSAGE_CONTENT);
      expect(eventTypes).toContain(EventType.TEXT_MESSAGE_END);
      expect(eventTypes).toContain(EventType.RUN_FINISHED);

      // At TEXT_MESSAGE_START, a new message should appear
      const atStart = mw.capturedEventsWithState.find(
        (e) => e.event.type === EventType.TEXT_MESSAGE_START,
      )!;
      expect(atStart.messages).toHaveLength(1);
      expect(atStart.messages[0]).toMatchObject({ id: "msg-1", content: "" });

      // At TEXT_MESSAGE_CONTENT, the message content should be updated
      const atContent = mw.capturedEventsWithState.find(
        (e) => e.event.type === EventType.TEXT_MESSAGE_CONTENT,
      )!;
      expect(atContent.messages[0]).toMatchObject({ id: "msg-1", content: "Full text" });

      // At RUN_FINISHED, message is complete
      const atFinished = mw.capturedEventsWithState.find(
        (e) => e.event.type === EventType.RUN_FINISHED,
      )!;
      expect(atFinished.messages[0]).toMatchObject({ id: "msg-1", content: "Full text" });
    });

    it("tool call messages build incrementally across events", async () => {
      const mw = new CapturingMiddleware();

      const agent = new FullToolCallAgent({ threadId: "t1" });
      agent.use(mw);

      await agent.runAgent();

      // At TOOL_CALL_START, assistant message with empty tool call should appear
      const atStart = mw.capturedEventsWithState.find(
        (e) => e.event.type === EventType.TOOL_CALL_START,
      )!;
      expect(atStart.messages).toHaveLength(1);
      const startMsg = expectAssistantMessage(atStart.messages[0]);
      expect(startMsg.toolCalls).toHaveLength(1);
      expect(startMsg.toolCalls![0].function.arguments).toBe("");

      // At TOOL_CALL_ARGS, arguments should be populated
      const atArgs = mw.capturedEventsWithState.find(
        (e) => e.event.type === EventType.TOOL_CALL_ARGS,
      )!;
      expect(expectAssistantMessage(atArgs.messages[0]).toolCalls![0].function.arguments).toBe(
        '{"q":"test"}',
      );

      // At TOOL_CALL_RESULT, tool message should be added
      const atResult = mw.capturedEventsWithState.find(
        (e) => e.event.type === EventType.TOOL_CALL_RESULT,
      )!;
      expect(atResult.messages).toHaveLength(2);
      expect(atResult.messages[1]).toMatchObject({ role: "tool", content: "result" });
    });
  });
});
