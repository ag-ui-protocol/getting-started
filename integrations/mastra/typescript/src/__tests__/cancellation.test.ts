import { describe, it, expect, vi, afterEach } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { Agent } from "@mastra/core/agent";
import { MockMemory } from "@mastra/core/memory";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { FakeMemory, makeInput, collectEvents } from "./helpers";
import { MastraAgent } from "../mastra";

// ---------------------------------------------------------------------------
// Regression tests for #2288: unsubscribing from the run() Observable must
// propagate cancellation into the underlying Mastra stream. Before the fix the
// teardown was `() => {}`, so an aborted run kept pulling (and billing) tokens
// to completion.
//
// Two separate mechanisms are covered, and they are NOT equivalent:
//
//   LOCAL  (@mastra/core Agent) — the AbortController's signal is handed to
//          `agent.stream()`/`agent.resumeStream()`, so @mastra/core itself
//          stops generating and emits a first-class `abort` chunk.
//
//   REMOTE (@mastra/client-js Agent) — `abortSignal` is deliberately NOT sent.
//          client-js Omits it from its stream params and reads the fetch signal
//          from construction-time `ClientOptions.abortSignal`, so a per-call
//          value would only be JSON-serialized into the POST body. All we can
//          do is short-circuit our own consumption loop. Server-side billing is
//          NOT stopped, and the tests below assert exactly that much and no
//          more.
//
// Each fake hands out a gate the test opens only AFTER unsubscribing, so the
// stream is provably still mid-flight when teardown fires.
// ---------------------------------------------------------------------------

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

const RESUME_INPUT = makeInput({
  messages: [{ id: "1", role: "user", content: "Hi" }] as any,
  forwardedProps: {
    command: {
      resume: { approved: true },
      interruptEvent: { toolCallId: "call-1", runId: "mastra-run-1" },
    },
  },
});

const STREAM_INPUT = makeInput({
  messages: [{ id: "1", role: "user", content: "Hi" }] as any,
});

/** Subscribes, waits for the first event, unsubscribes, then opens the gate. */
async function runUntilFirstEventThenUnsubscribe(
  agent: MastraAgent,
  input = STREAM_INPUT,
  gate?: { release: () => void },
) {
  const events: BaseEvent[] = [];
  const firstChunk = deferred();

  const subscription = agent.run(input).subscribe({
    next: (event) => {
      events.push(event);
      if (event.type === EventType.TEXT_MESSAGE_CHUNK) firstChunk.release();
    },
    error: () => firstChunk.release(),
    complete: () => firstChunk.release(),
  });

  await firstChunk.promise;
  subscription.unsubscribe();
  const countAtUnsubscribe = events.length;

  gate?.release();
  await tick();

  return { events, countAtUnsubscribe };
}

/**
 * A fullStream that yields one chunk, waits on `gate`, then yields MANY more.
 * `pulled` counts how many chunks the consumer actually pulled, which is how
 * the "stop consuming" assertions are made.
 */
function countingStream(gate: Promise<void>, after = 10) {
  const state = { pulled: 0 };
  const stream = (async function* () {
    state.pulled++;
    yield { type: "text-delta", payload: { text: "first" } };
    await gate;
    for (let i = 0; i < after; i++) {
      state.pulled++;
      yield { type: "text-delta", payload: { text: `more-${i}` } };
    }
    state.pulled++;
    yield { type: "finish", payload: {} };
  })();
  return { stream, state };
}

function makeCountingProcessDataStream(gate: Promise<void>, after = 10) {
  const state = { delivered: 0, handled: 0 };
  const processDataStream = async ({
    onChunk,
  }: {
    onChunk: (chunk: any) => Promise<void>;
  }) => {
    state.delivered++;
    await onChunk({ type: "text-delta", payload: { text: "first" } });
    await gate;
    for (let i = 0; i < after; i++) {
      state.delivered++;
      await onChunk({ type: "text-delta", payload: { text: `more-${i}` } });
    }
    state.delivered++;
    await onChunk({ type: "finish", payload: {} });
  };
  return { processDataStream, state };
}

function localFake(overrides: Record<string, any>) {
  return {
    memory: new FakeMemory(),
    async getMemory() {
      return (this as any).memory;
    },
    async listTools() {
      return {};
    },
    ...overrides,
  };
}

/**
 * Counts how many chunks actually reach the chunk processor. For the remote
 * (callback-driven) paths this is the only observable signal that we stopped
 * consuming: the producer keeps calling us back, and post-unsubscribe AG-UI
 * events are swallowed by the closed subscriber either way.
 */
function countHandledChunks(agent: MastraAgent) {
  const state = { handled: 0 };
  const original = (agent as any).createChunkProcessor.bind(agent);
  vi.spyOn(agent as any, "createChunkProcessor").mockImplementation(
    (...args: any[]) => {
      const { handleChunk, flush } = original(...args);
      return {
        flush,
        handleChunk: (chunk: any) => {
          state.handled++;
          return handleChunk(chunk);
        },
      };
    },
  );
  return state;
}

function wrap(fakeAgent: any) {
  return new MastraAgent({
    agentId: "test-agent",
    agent: fakeAgent as any,
    resourceId: "resource-1",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run() cancellation propagation (#2288)", () => {
  describe("local agent stream()", () => {
    it("aborts the signal forwarded to agent.stream() when unsubscribed", async () => {
      const gate = deferred();
      const { stream } = countingStream(gate.promise);
      let capturedOpts: any = null;

      const agent = wrap(
        localFake({
          async stream(_messages: any, opts: any) {
            capturedOpts = opts;
            return { fullStream: stream };
          },
        }),
      );

      const { events, countAtUnsubscribe } =
        await runUntilFirstEventThenUnsubscribe(agent, STREAM_INPUT, gate);

      expect(capturedOpts?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(capturedOpts.abortSignal.aborted).toBe(true);
      expect(events).toHaveLength(countAtUnsubscribe);
    });

    it("stops pulling from fullStream once cancelled", async () => {
      const gate = deferred();
      const { stream, state } = countingStream(gate.promise, 10);

      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: stream };
          },
        }),
      );

      await runUntilFirstEventThenUnsubscribe(agent, STREAM_INPUT, gate);

      // 1 chunk before the gate + at most 1 more pulled by the `for await`
      // before the abort check runs. Without the check the generator drains all
      // 12.
      expect(state.pulled).toBeLessThanOrEqual(2);
    });
  });

  describe("remote agent stream()", () => {
    it("does NOT send abortSignal to the remote agent (client-js ignores it)", async () => {
      const gate = deferred();
      const { processDataStream } = makeCountingProcessDataStream(gate.promise);
      let capturedOpts: any = null;

      const agent = wrap({
        async stream(_messages: any, opts: any) {
          capturedOpts = opts;
          return { processDataStream };
        },
      });

      await runUntilFirstEventThenUnsubscribe(agent, STREAM_INPUT, gate);

      // @mastra/client-js Omits `abortSignal` from StreamParamsBase and would
      // JSON-serialize it into the request body as `{}`. Sending it is worse
      // than useless, so the bridge must not.
      expect(capturedOpts).not.toBeNull();
      expect("abortSignal" in capturedOpts).toBe(false);
    });

    it("stops consuming the remote data stream once cancelled", async () => {
      const gate = deferred();
      const { processDataStream, state } = makeCountingProcessDataStream(
        gate.promise,
        10,
      );

      const agent = wrap({
        async stream() {
          return { processDataStream };
        },
      });
      const handled = countHandledChunks(agent);

      const { events, countAtUnsubscribe } =
        await runUntilFirstEventThenUnsubscribe(agent, STREAM_INPUT, gate);

      // The callback-driven remote stream keeps delivering (we cannot stop the
      // producer over client-js), but every post-abort chunk must be dropped
      // before it reaches the chunk processor.
      expect(state.delivered).toBe(12);
      expect(handled.handled).toBe(1);
      expect(events).toHaveLength(countAtUnsubscribe);
      expect(
        events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK),
      ).toHaveLength(1);
    });
  });

  describe("local agent resumeStream()", () => {
    it("aborts the signal forwarded via resume options when unsubscribed", async () => {
      const gate = deferred();
      const { stream } = countingStream(gate.promise);
      let capturedOpts: any = null;

      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: (async function* () {})() };
          },
          async resumeStream(_resumeData: any, opts: any) {
            capturedOpts = opts;
            return { fullStream: stream };
          },
        }),
      );

      const { events, countAtUnsubscribe } =
        await runUntilFirstEventThenUnsubscribe(agent, RESUME_INPUT, gate);

      expect(capturedOpts?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(capturedOpts.abortSignal.aborted).toBe(true);
      expect(events).toHaveLength(countAtUnsubscribe);
    });
  });

  describe("remote agent resumeStream()", () => {
    it("does NOT send abortSignal, and stops consuming when cancelled", async () => {
      const gate = deferred();
      const { processDataStream, state } = makeCountingProcessDataStream(
        gate.promise,
        10,
      );
      let capturedOpts: any = null;

      const agent = wrap({
        async stream() {
          return { processDataStream: async () => {} };
        },
        async resumeStream(_resumeData: any, opts: any) {
          capturedOpts = opts;
          return { processDataStream };
        },
      });
      const handled = countHandledChunks(agent);

      const { events, countAtUnsubscribe } =
        await runUntilFirstEventThenUnsubscribe(agent, RESUME_INPUT, gate);

      expect(capturedOpts).not.toBeNull();
      expect("abortSignal" in capturedOpts).toBe(false);
      expect(state.delivered).toBe(12);
      expect(handled.handled).toBe(1);
      expect(events).toHaveLength(countAtUnsubscribe);
    });
  });

  describe("abort chunks", () => {
    it("treats @mastra/core's `abort` chunk as terminal, without warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const agent = wrap(
        localFake({
          async stream() {
            return {
              fullStream: (async function* () {
                yield { type: "text-delta", payload: { text: "partial" } };
                // Shape emitted by @mastra/core when a run is cancelled.
                yield {
                  type: "abort",
                  runId: "r1",
                  from: "AGENT",
                  payload: {},
                };
              })(),
            };
          },
        }),
      );

      const events = await collectEvents(agent, STREAM_INPUT);

      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("Unrecognized stream chunk type"),
        ),
      ).toBe(false);
      // Recognizing the chunk must not change termination: the Observable
      // still completes (collectEvents would hang otherwise) and the partial
      // text is still flushed. Whether a cancelled run *should* report
      // RUN_FINISHED at all is #2417, out of scope here.
      expect(
        events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK).length,
      ).toBeGreaterThan(0);
      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    });
  });

  describe("overlapping runs", () => {
    it("isolates teardown per run and abortRun() reaches every in-flight run", async () => {
      const gates = [deferred(), deferred(), deferred()];
      const signals: AbortSignal[] = [];

      const agent = wrap(
        localFake({
          async stream(_messages: any, opts: any) {
            const gate = gates[signals.length];
            signals.push(opts.abortSignal);
            return { fullStream: countingStream(gate.promise).stream };
          },
        }),
      );

      /** Subscribes and resolves once the run is actually streaming. */
      const start = async () => {
        const first = deferred();
        const sub = agent.run(STREAM_INPUT).subscribe({
          next: (e) => {
            if (e.type === EventType.TEXT_MESSAGE_CHUNK) first.release();
          },
          error: () => first.release(),
          complete: () => first.release(),
        });
        await first.promise;
        return sub;
      };

      const subA = await start();
      const subB = await start();
      expect(signals).toHaveLength(2);

      // Tearing down the OLDER run must abort only its own controller.
      subA.unsubscribe();
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
      // ...and must retire it, so the set only tracks what is still live.
      expect((agent as any).abortControllers.size).toBe(1);

      const subC = await start();
      expect(signals).toHaveLength(3);
      expect((agent as any).abortControllers.size).toBe(2);

      // abortRun() must reach BOTH still-live runs, not just the newest. With
      // a single instance-level controller field, starting C would have
      // orphaned B and left it generating.
      agent.abortRun();
      expect(signals[1].aborted).toBe(true);
      expect(signals[2].aborted).toBe(true);

      gates.forEach((g) => g.release());
      subB.unsubscribe();
      subC.unsubscribe();
      await tick();
      expect((agent as any).abortControllers.size).toBe(0);
    });
  });

  describe("abortRun()", () => {
    it("aborts the in-flight run's signal", async () => {
      const gate = deferred();
      const { stream } = countingStream(gate.promise);
      let capturedOpts: any = null;

      const agent = wrap(
        localFake({
          async stream(_messages: any, opts: any) {
            capturedOpts = opts;
            return { fullStream: stream };
          },
        }),
      );

      const firstChunk = deferred();
      const subscription = agent.run(STREAM_INPUT).subscribe({
        next: (event) => {
          if (event.type === EventType.TEXT_MESSAGE_CHUNK) firstChunk.release();
        },
        error: () => firstChunk.release(),
        complete: () => firstChunk.release(),
      });

      await firstChunk.promise;
      agent.abortRun();

      expect(capturedOpts?.abortSignal?.aborted).toBe(true);

      gate.release();
      subscription.unsubscribe();
      await tick();
    });

    // abortRun() has no subscription to close, so it has to settle the
    // Observable itself. These two assert that without the second unsubscribe
    // the tests above lean on — a caller that only calls abortRun() must not be
    // left waiting on a run that never ends.
    it("settles the run() Observable on its own, with no unsubscribe", async () => {
      const gate = deferred();
      const { stream } = countingStream(gate.promise);

      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: stream };
          },
        }),
      );

      const firstChunk = deferred();
      const settled = deferred();
      let outcome: "complete" | "error" | null = null;

      agent.run(STREAM_INPUT).subscribe({
        next: (event) => {
          if (event.type === EventType.TEXT_MESSAGE_CHUNK) firstChunk.release();
        },
        error: () => {
          outcome = "error";
          settled.release();
        },
        complete: () => {
          outcome = "complete";
          settled.release();
        },
      });

      await firstChunk.promise;
      agent.abortRun();

      await Promise.race([
        settled.promise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("run() never settled")), 1000),
        ),
      ]);

      expect(outcome).toBe("complete");
    });

    it("settles runAgent() on its own, with no unsubscribe", async () => {
      const gate = deferred();
      const { stream } = countingStream(gate.promise);

      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: stream };
          },
        }),
      );

      const firstChunk = deferred();
      const finished = agent.runAgent(
        { forwardedProps: {} },
        {
          onTextMessageContentEvent: () => {
            firstChunk.release();
          },
        },
      );

      await firstChunk.promise;
      agent.abortRun();

      await expect(
        Promise.race([
          finished,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("runAgent() never settled")),
              1000,
            ),
          ),
        ]),
      ).resolves.toBeDefined();
    });
  });

  // The teardown fires on normal completion too (RxJS closes the subscription
  // either way). This proves the abort that fires there is harmless: the run
  // still finishes and both messages are persisted.
  describe("normal completion is unaffected", () => {
    it("a run that completes still emits RUN_FINISHED and persists messages", async () => {
      const memory = new MockMemory();
      const agent = new Agent({
        id: "test-agent",
        name: "test-agent",
        instructions: "Test",
        memory,
        model: new MastraLanguageModelV2Mock({
          doStream: async () => ({
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: "text-delta" as const,
                  id: "t1",
                  delta: "Hello back",
                });
                controller.enqueue({
                  type: "finish" as const,
                  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                  finishReason: "stop" as const,
                });
                controller.close();
              },
            }),
            request: { body: {} },
            response: undefined,
          }),
        }) as any,
      });

      const events = await collectEvents(
        new MastraAgent({
          agentId: "test-agent",
          agent,
          resourceId: "resource-1",
        }),
        makeInput({
          threadId: "thread-complete",
          messages: [{ id: "1", role: "user", content: "Hi there" }] as any,
        }),
      );

      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);

      const { messages } = await memory.recall({
        threadId: "thread-complete",
        resourceId: "resource-1",
        selectBy: { last: 50 },
      } as any);

      const texts = messages.map((m: any) =>
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? ""),
      );
      expect(texts.some((t: string) => t.includes("Hi there"))).toBe(true);
      expect(texts.some((t: string) => t.includes("Hello back"))).toBe(true);
    });
  });
});
