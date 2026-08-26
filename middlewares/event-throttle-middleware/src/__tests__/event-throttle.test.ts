import { describe, it, expect, vi } from "vitest";
import { Observable, Subject, Subscription } from "rxjs";
import {
  AbstractAgent,
  Middleware,
  BaseEvent,
  EventType,
  RunAgentInput,
} from "@ag-ui/client";
import { EventThrottleMiddleware } from "../index";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** A minimal agent whose event stream we control via a Subject. */
class TestAgent extends AbstractAgent {
  public subject = new Subject<BaseEvent>();

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return this.subject.asObservable();
  }
}

/** Cast helper — BaseEvent's Zod passthrough schema adds an index signature. */
function ev(partial: { type: EventType; [key: string]: unknown }): BaseEvent {
  return partial as BaseEvent;
}

const runStarted = () => ev({ type: EventType.RUN_STARTED });
const runFinished = () => ev({ type: EventType.RUN_FINISHED });
const textChunk = (messageId: string, delta: string) =>
  ev({ type: EventType.TEXT_MESSAGE_CHUNK, messageId, delta });
const stateSnapshot = (snapshot: Record<string, unknown>) =>
  ev({ type: EventType.STATE_SNAPSHOT, snapshot });
const toolCallStart = (toolCallId: string) =>
  ev({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "test" });
const toolCallChunk = (toolCallId: string, delta: string) =>
  ev({ type: EventType.TOOL_CALL_CHUNK, toolCallId, delta });
const reasoningChunk = (messageId: string, delta: string) =>
  ev({ type: EventType.REASONING_MESSAGE_CHUNK, messageId, delta });

/** Collect all events emitted by an observable into an array. */
function collectEvents(obs$: Observable<BaseEvent>): {
  events: BaseEvent[];
  done: Promise<void>;
} {
  const events: BaseEvent[] = [];
  const done = new Promise<void>((resolve, reject) => {
    obs$.subscribe({
      next: (e) => events.push(e),
      error: reject,
      complete: resolve,
    });
  });
  return { events, done };
}

/**
 * Run the middleware (or raw agent) by piping events through,
 * collecting what comes out the other side.
 */
function setup(middleware?: Middleware) {
  const agent = new TestAgent();
  const input: RunAgentInput = {
    threadId: "t1",
    runId: "r1",
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };

  let events$: Observable<BaseEvent>;
  if (middleware) {
    events$ = middleware.run(input, agent);
  } else {
    events$ = agent.run(input);
  }

  const { events, done } = collectEvents(events$);
  return { agent, events, done };
}

/** Collect deltas from TEXT_MESSAGE_CHUNK events. */
function collectTextDeltas(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
    .map((e) => (e as any).delta)
    .join("");
}

/** Collect deltas from TOOL_CALL_CHUNK events. */
function collectToolCallDeltas(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.TOOL_CALL_CHUNK)
    .map((e) => (e as any).delta)
    .join("");
}

/** Collect deltas from REASONING_MESSAGE_CHUNK events. */
function collectReasoningDeltas(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.REASONING_MESSAGE_CHUNK)
    .map((e) => (e as any).delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventThrottleMiddleware", () => {
  describe("baseline (no middleware)", () => {
    it("without middleware, every event passes through 1:1", async () => {
      const { agent, events, done } = setup();

      agent.subject.next(runStarted());
      agent.subject.next(textChunk("m1", "A"));
      agent.subject.next(textChunk("m1", "B"));
      agent.subject.next(textChunk("m1", "C"));
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;
      expect(events).toHaveLength(5);
    });
  });

  describe("time-based throttle", () => {
    it("coalesces synchronous chunks via leading-edge and completion flush", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 50 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      for (let i = 0; i < 20; i++) {
        agent.subject.next(textChunk("m1", String.fromCharCode(65 + i)));
      }
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      const chunkEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      );
      expect(chunkEvents.length).toBeLessThan(20);
      expect(chunkEvents.length).toBeGreaterThanOrEqual(1);

      expect(collectTextDeltas(events)).toBe("ABCDEFGHIJKLMNOPQRST");
    });
  });

  describe("chunk-size throttle", () => {
    it("with minChunkSize, notifications wait until enough chars accumulate", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 5000, minChunkSize: 10 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      for (let i = 0; i < 20; i++) {
        agent.subject.next(textChunk("m1", String.fromCharCode(65 + i)));
      }
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      const chunkEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      );
      // With minChunkSize=10, chunks accumulate until 10 chars, then flush.
      // 20 single-char chunks → flush at 10, then remaining 10 flushed by RUN_FINISHED.
      // Each flush coalesces its chunks into 1 event → expect ~2 chunk events.
      expect(chunkEvents.length).toBeGreaterThanOrEqual(1);
      expect(chunkEvents.length).toBeLessThanOrEqual(4);

      expect(collectTextDeltas(events)).toBe("ABCDEFGHIJKLMNOPQRST");
    });
  });

  describe("combined thresholds", () => {
    it("fires when either time or chunk threshold is hit first", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 10000, minChunkSize: 5 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      for (let i = 0; i < 15; i++) {
        agent.subject.next(textChunk("m1", String.fromCharCode(65 + i)));
      }
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      const chunkEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      );
      // minChunkSize=5 → flush every 5 chars. 15 chars = 3 flushes + possibly remainder from RUN_FINISHED
      expect(chunkEvents.length).toBeGreaterThanOrEqual(2);
      expect(chunkEvents.length).toBeLessThanOrEqual(5);

      expect(collectTextDeltas(events)).toBe("ABCDEFGHIJKLMNO");
    });
  });

  describe("leading edge", () => {
    it("first buffered event fires immediately when no prior flush", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
      const { agent, events, done } = setup(mw);

      // First event is a text chunk — with no prior flush, lastFlushTime is 0
      // so leading-edge fires immediately
      agent.subject.next(textChunk("m1", "hello"));
      expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK).length).toBe(1);

      agent.subject.next(textChunk("m1", " world"));
      // Second chunk is buffered (within 5000ms window)
      expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK).length).toBe(1);

      agent.subject.complete();
      await done;

      // After completion, buffer is flushed
      expect(collectTextDeltas(events)).toBe("hello world");
    });
  });

  describe("immediate events flush buffer", () => {
    it("TOOL_CALL_START flushes pending chunks before passing through", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      agent.subject.next(textChunk("m1", "hello"));
      agent.subject.next(textChunk("m1", " world"));
      agent.subject.next(toolCallStart("tc1"));
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      const chunkPositions = events
        .map((e, i) => (e.type === EventType.TEXT_MESSAGE_CHUNK ? i : -1))
        .filter((i) => i >= 0);
      const toolStartPos = events.findIndex(
        (e) => e.type === EventType.TOOL_CALL_START,
      );

      // All chunks must appear BEFORE the tool call start
      for (const pos of chunkPositions) {
        expect(pos).toBeLessThan(toolStartPos);
      }
    });
  });

  describe("trailing timer", () => {
    it("pending events flush after the time window", async () => {
      vi.useFakeTimers();
      try {
        const mw = new EventThrottleMiddleware({ intervalMs: 50 });
        const { agent, events, done } = setup(mw);

        agent.subject.next(runStarted());
        agent.subject.next(textChunk("m1", "A"));
        agent.subject.next(textChunk("m1", "B"));

        const chunksBeforeTimer = events.filter(
          (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
        ).length;

        await vi.advanceTimersByTimeAsync(60);

        const chunksAfterTimer = events.filter(
          (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
        ).length;

        expect(chunksAfterTimer).toBeGreaterThan(chunksBeforeTimer);

        agent.subject.next(runFinished());
        agent.subject.complete();
        await vi.advanceTimersByTimeAsync(0);
        await done;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("stream completion", () => {
    it("remaining buffer is flushed on complete", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      agent.subject.next(textChunk("m1", "A"));
      agent.subject.next(textChunk("m1", "B"));
      agent.subject.next(textChunk("m1", "C"));
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      expect(collectTextDeltas(events)).toBe("ABC");
    });
  });

  describe("stream error", () => {
    it("buffer is discarded on error and error is propagated", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      agent.subject.next(textChunk("m1", "A"));
      agent.subject.next(textChunk("m1", "B"));
      agent.subject.next(textChunk("m1", "C"));

      const chunksBeforeError = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      ).length;

      agent.subject.error(new Error("stream error"));
      await expect(done).rejects.toThrow("stream error");

      const chunksAfterError = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      ).length;

      expect(chunksAfterError).toBe(chunksBeforeError);
    });
  });

  describe("validation", () => {
    it("throws on negative intervalMs", () => {
      expect(() => new EventThrottleMiddleware({ intervalMs: -1 })).toThrow(
        "non-negative finite number",
      );
    });

    it("throws on NaN intervalMs", () => {
      expect(() => new EventThrottleMiddleware({ intervalMs: NaN })).toThrow(
        "non-negative finite number",
      );
    });

    it("throws on Infinity intervalMs", () => {
      expect(
        () => new EventThrottleMiddleware({ intervalMs: Infinity }),
      ).toThrow("non-negative finite number");
    });

    it("throws on negative minChunkSize", () => {
      expect(
        () =>
          new EventThrottleMiddleware({
            intervalMs: 16,
            minChunkSize: -5,
          }),
      ).toThrow("non-negative finite number");
    });

    it("intervalMs: 0 with no minChunkSize is a no-op passthrough", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 0 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      for (let i = 0; i < 5; i++) {
        agent.subject.next(textChunk("m1", String.fromCharCode(65 + i)));
      }
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      expect(events).toHaveLength(7);
    });

    it("intervalMs: 0 with minChunkSize > 0 throttles by chunk size", async () => {
      const mw = new EventThrottleMiddleware({
        intervalMs: 0,
        minChunkSize: 5,
      });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      for (let i = 0; i < 15; i++) {
        agent.subject.next(textChunk("m1", String.fromCharCode(65 + i)));
      }
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      const chunkEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      );
      expect(chunkEvents.length).toBeGreaterThanOrEqual(2);
      expect(chunkEvents.length).toBeLessThan(15);

      expect(collectTextDeltas(events)).toBe("ABCDEFGHIJKLMNO");
    });
  });

  describe("state events", () => {
    it("non-coalescable bufferable events all pass through in order", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      agent.subject.next(stateSnapshot({ count: 1 }));
      agent.subject.next(stateSnapshot({ count: 2 }));
      agent.subject.next(stateSnapshot({ count: 3 }));
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      const stateEvents = events.filter(
        (e) => e.type === EventType.STATE_SNAPSHOT,
      );
      expect(stateEvents).toHaveLength(3);
      expect((stateEvents[0] as any).snapshot).toEqual({ count: 1 });
      expect((stateEvents[1] as any).snapshot).toEqual({ count: 2 });
      expect((stateEvents[2] as any).snapshot).toEqual({ count: 3 });
    });
  });

  describe("message ID change resets chunk tracking", () => {
    it("minChunkSize resets when messageId changes", async () => {
      const mw = new EventThrottleMiddleware({
        intervalMs: 5000,
        minChunkSize: 5,
      });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      for (let i = 0; i < 4; i++) {
        agent.subject.next(textChunk("m1", String.fromCharCode(65 + i)));
      }
      for (let i = 0; i < 6; i++) {
        agent.subject.next(textChunk("m2", String.fromCharCode(75 + i)));
      }
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      const chunkEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      );
      expect(chunkEvents.length).toBeGreaterThanOrEqual(2);
      expect(chunkEvents.length).toBeLessThanOrEqual(10);
    });
  });

  describe("multiple runs", () => {
    it("second run on same middleware gets fresh throttle state", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 5000 });

      const run1 = setup(mw);
      run1.agent.subject.next(runStarted());
      run1.agent.subject.next(textChunk("m1", "first"));
      run1.agent.subject.next(runFinished());
      run1.agent.subject.complete();
      await run1.done;

      const run2 = setup(mw);
      run2.agent.subject.next(runStarted());
      run2.agent.subject.next(textChunk("m2", "second"));
      run2.agent.subject.next(runFinished());
      run2.agent.subject.complete();
      await run2.done;

      const run2Chunks = run2.events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      );
      expect(run2Chunks.length).toBeGreaterThanOrEqual(1);
      expect((run2Chunks[0] as any).delta).toBe("second");
    });
  });

  describe("coalescing", () => {
    it("coalesces TOOL_CALL_CHUNK events by toolCallId", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      agent.subject.next(toolCallChunk("tc1", '{"na'));
      agent.subject.next(toolCallChunk("tc1", 'me":'));
      agent.subject.next(toolCallChunk("tc1", '"foo"}'));
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      expect(collectToolCallDeltas(events)).toBe('{"name":"foo"}');
      const tcChunks = events.filter((e) => e.type === EventType.TOOL_CALL_CHUNK);
      // Should be coalesced into fewer events
      expect(tcChunks.length).toBeLessThan(3);
    });

    it("coalesces REASONING_MESSAGE_CHUNK events by messageId", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      agent.subject.next(reasoningChunk("r1", "think"));
      agent.subject.next(reasoningChunk("r1", "ing..."));
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      expect(collectReasoningDeltas(events)).toBe("thinking...");
      const rChunks = events.filter((e) => e.type === EventType.REASONING_MESSAGE_CHUNK);
      expect(rChunks.length).toBeLessThan(2);
    });

    it("does not coalesce chunks with different IDs", async () => {
      const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
      const { agent, events, done } = setup(mw);

      agent.subject.next(runStarted());
      agent.subject.next(textChunk("m1", "hello"));
      agent.subject.next(textChunk("m2", "world"));
      agent.subject.next(runFinished());
      agent.subject.complete();

      await done;

      const chunks = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK);
      expect(chunks).toHaveLength(2);
      expect((chunks[0] as any).messageId).toBe("m1");
      expect((chunks[0] as any).delta).toBe("hello");
      expect((chunks[1] as any).messageId).toBe("m2");
      expect((chunks[1] as any).delta).toBe("world");
    });
  });

  describe("teardown", () => {
    it("unsubscribing clears pending timer and stops events", async () => {
      vi.useFakeTimers();
      try {
        const mw = new EventThrottleMiddleware({ intervalMs: 50 });
        const agent = new TestAgent();
        const input: RunAgentInput = {
          threadId: "t1",
          runId: "r1",
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {},
        };

        const events: BaseEvent[] = [];
        const events$ = mw.run(input, agent);
        const subscription: Subscription = events$.subscribe({
          next: (e) => events.push(e),
        });

        agent.subject.next(runStarted());
        agent.subject.next(textChunk("m1", "A"));
        agent.subject.next(textChunk("m1", "B"));

        // A trailing timer is now scheduled. Unsubscribe before it fires.
        subscription.unsubscribe();

        const countAtUnsubscribe = events.length;

        // Advance past the timer — no events should be emitted
        await vi.advanceTimersByTimeAsync(200);

        expect(events.length).toBe(countAtUnsubscribe);
      } finally {
        vi.useRealTimers();
      }
    });

    it("error clears pending trailing timer", async () => {
      vi.useFakeTimers();
      try {
        const mw = new EventThrottleMiddleware({ intervalMs: 50 });
        const { agent, events, done } = setup(mw);

        agent.subject.next(runStarted());
        agent.subject.next(textChunk("m1", "A"));
        agent.subject.next(textChunk("m1", "B"));

        // A trailing timer is now scheduled. Error before it fires.
        agent.subject.error(new Error("boom"));
        await expect(done).rejects.toThrow("boom");

        const countAtError = events.filter(
          (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
        ).length;

        // Advance past the timer — no additional events
        await vi.advanceTimersByTimeAsync(200);

        expect(
          events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK).length,
        ).toBe(countAtError);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("subagent lanes never coalesce together", () => {
  const taggedChunk = (messageId: string, delta: string, owner?: string, metadata?: unknown) =>
    ev({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId,
      delta,
      ...(owner !== undefined && { subagentRunId: owner }),
      ...(metadata !== undefined && { metadata }),
    });

  // Reusing one entity id across owners is protocol-invalid; the client
  // verifier exists to reject it. Coalescing across owners would erase the
  // contradiction before the verifier ever sees it — and silently merge the
  // two lanes' deltas and metadata into whichever owner came first.
  it("preserves an ownership contradiction instead of merging it away", async () => {
    const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
    const { agent, events, done } = setup(mw);

    agent.subject.next(runStarted());
    agent.subject.next(taggedChunk("m1", "A", "s1", { fromS1: true }));
    agent.subject.next(taggedChunk("m1", "B", "s2", { fromS2: true }));
    agent.subject.next(runFinished());
    agent.subject.complete();

    await done;

    const chunks = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK);
    expect(chunks).toHaveLength(2);
    expect((chunks[0] as any).subagentRunId).toBe("s1");
    expect((chunks[0] as any).delta).toBe("A");
    expect((chunks[0] as any).metadata).toEqual({ fromS1: true });
    expect((chunks[1] as any).subagentRunId).toBe("s2");
    expect((chunks[1] as any).delta).toBe("B");
    expect((chunks[1] as any).metadata).toEqual({ fromS2: true });
  });

  it("still coalesces within one owner's lane", async () => {
    const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
    const { agent, events, done } = setup(mw);

    agent.subject.next(runStarted());
    agent.subject.next(taggedChunk("m1", "A", "s1"));
    agent.subject.next(taggedChunk("m1", "B", "s1", { finishReason: "stop" }));
    agent.subject.next(runFinished());
    agent.subject.complete();

    await done;

    const chunks = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK);
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as any).delta).toBe("AB");
    expect((chunks[0] as any).subagentRunId).toBe("s1");
    expect((chunks[0] as any).metadata).toEqual({ finishReason: "stop" });
  });

  it("does not merge an untagged chunk into a tagged opener", async () => {
    // An untagged continuation is VALID (the opener owns it), but merging it
    // into the tagged chunk would bake the opener's owner onto content the
    // producer left untagged. It stays separate here; the chunk transform
    // resolves its owner from the opener downstream.
    const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
    const { agent, events, done } = setup(mw);

    agent.subject.next(runStarted());
    agent.subject.next(taggedChunk("m1", "A", "s1"));
    agent.subject.next(taggedChunk("m1", "B"));
    agent.subject.next(taggedChunk("m1", "C"));
    agent.subject.next(runFinished());
    agent.subject.complete();

    await done;

    const chunks = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK);
    expect(chunks).toHaveLength(2);
    expect((chunks[0] as any).subagentRunId).toBe("s1");
    expect((chunks[0] as any).delta).toBe("A");
    // The two untagged continuations coalesce with each other.
    expect((chunks[1] as any).subagentRunId).toBeUndefined();
    expect((chunks[1] as any).delta).toBe("BC");
  });

  it("never aliases two lanes whose ids merely concatenate alike", async () => {
    // Owner "a" + id "b:c" and owner "a:b" + id "c" concatenate identically
    // under any fixed delimiter — ids are unconstrained strings, so the key
    // must be structurally encoded. Round 2 of the merge review reproduced
    // these two lanes coalescing into one chunk.
    const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
    const { agent, events, done } = setup(mw);

    agent.subject.next(runStarted());
    agent.subject.next(taggedChunk("b:c", "A", "a", { lane: 1 }));
    agent.subject.next(taggedChunk("c", "B", "a:b", { lane: 2 }));
    agent.subject.next(runFinished());
    agent.subject.complete();

    await done;

    const chunks = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK);
    expect(chunks).toHaveLength(2);
    expect((chunks[0] as any).messageId).toBe("b:c");
    expect((chunks[0] as any).subagentRunId).toBe("a");
    expect((chunks[0] as any).delta).toBe("A");
    expect((chunks[0] as any).metadata).toEqual({ lane: 1 });
    expect((chunks[1] as any).messageId).toBe("c");
    expect((chunks[1] as any).subagentRunId).toBe("a:b");
    expect((chunks[1] as any).delta).toBe("B");
    expect((chunks[1] as any).metadata).toEqual({ lane: 2 });
  });

  it("keeps an explicit empty-string owner distinct from absent attribution", async () => {
    const mw = new EventThrottleMiddleware({ intervalMs: 5000 });
    const { agent, events, done } = setup(mw);

    agent.subject.next(runStarted());
    agent.subject.next(taggedChunk("m1", "A", ""));
    agent.subject.next(taggedChunk("m1", "B"));
    agent.subject.next(runFinished());
    agent.subject.complete();

    await done;

    const chunks = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK);
    expect(chunks).toHaveLength(2);
    expect((chunks[0] as any).subagentRunId).toBe("");
    expect((chunks[1] as any).subagentRunId).toBeUndefined();
  });
});

describe("metadata across coalesced chunks", () => {
  // Coalescing keeps the first chunk's fields and concatenates deltas, which is
  // right for role/name/toolCallName — they only appear on the first chunk.
  // Metadata is the opposite: it is designed to arrive last, carrying usage and
  // the finish reason. Dropping it here would swallow it before transformChunks
  // ever sees it.
  const chunkWithMetadata = (messageId: string, delta: string | undefined, metadata: unknown) =>
    ev({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId,
      ...(delta !== undefined && { delta }),
      metadata,
    });

  it("merges metadata from every coalesced chunk, last write winning", async () => {
    const mw = new EventThrottleMiddleware({ intervalMs: 50 });
    const { agent, events, done } = setup(mw);

    agent.subject.next(runStarted());
    agent.subject.next(chunkWithMetadata("m1", "Hel", { source: "openai", stage: "a" }));
    agent.subject.next(chunkWithMetadata("m1", "lo", { stage: "b" }));
    // The motivating case: a trailing usage-only chunk with no delta.
    agent.subject.next(chunkWithMetadata("m1", undefined, { usage: { output: 340 } }));
    agent.subject.next(runFinished());
    agent.subject.complete();

    await done;

    expect(collectTextDeltas(events)).toBe("Hello");

    const merged = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
      .reduce<Record<string, unknown>>((acc, e) => ({ ...acc, ...((e as any).metadata ?? {}) }), {});
    expect(merged).toEqual({ source: "openai", stage: "b", usage: { output: 340 } });
  });

  it("leaves chunks without metadata untouched", async () => {
    const mw = new EventThrottleMiddleware({ intervalMs: 50 });
    const { agent, events, done } = setup(mw);

    agent.subject.next(runStarted());
    agent.subject.next(textChunk("m1", "a"));
    agent.subject.next(textChunk("m1", "b"));
    agent.subject.next(runFinished());
    agent.subject.complete();

    await done;

    expect(collectTextDeltas(events)).toBe("ab");
    const chunks = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK);
    expect(chunks.every((e) => (e as any).metadata === undefined)).toBe(true);
  });
});
