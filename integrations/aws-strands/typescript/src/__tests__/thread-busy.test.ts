/**
 * Concurrent runs on the same thread must be rejected with a
 * protocol-shaped RUN_ERROR/THREAD_BUSY, not the internal Strands error
 * message. The refusal only holds if the slot is also released, so the
 * release and the per-thread scoping are pinned here alongside it.
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { minimalRunInput, scriptedAgent } from "./helpers";

function blockableAgent(): {
  stub: import("@strands-agents/sdk").Agent;
  release: () => void;
} {
  let resolveGate!: () => void;
  const gate = new Promise<void>((r) => {
    resolveGate = r;
  });
  const stub = scriptedAgent([], {
    stream: async function* () {
      // Parked before the first yield, so the adapter is blocked on the
      // opening `next()` of this stream while holding the thread's slot.
      await gate;
      // Returning without yielding ends the stream with no agent events; the
      // adapter still closes the run out with its own terminal events.
      return;
    } as unknown as import("@strands-agents/sdk").Agent["stream"],
  });
  return { stub, release: resolveGate };
}

/**
 * Drain a run into an array, bounded. Without the bound, a missing guard turns
 * the refusal assertions below into a hang on the gate instead of a failure.
 */
async function collectEvents(
  gen: AsyncGenerator<BaseEvent, void, void>,
  timeoutMs = 2000,
): Promise<BaseEvent[]> {
  const out: BaseEvent[] = [];
  const drain = (async () => {
    for await (const e of gen) out.push(e);
  })();
  drain.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`stream did not end within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([drain, bound]);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

function expectCleanRun(events: BaseEvent[]): void {
  expect(events.map((e) => e.type)).not.toContain(EventType.RUN_ERROR);
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
}

describe("Concurrent runs on same thread → THREAD_BUSY", () => {
  it("rejects second invocation with RUN_ERROR/THREAD_BUSY and leaves first alone", async () => {
    const { stub, release } = blockableAgent();
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);

    // Same thread, since that collision is the point, but distinct run ids so
    // the refusal's own correlation is distinguishable from the incumbent's.
    const held: RunAgentInput = minimalRunInput({
      threadId: "thread-1",
      runId: "run-held",
    });
    const refused: RunAgentInput = minimalRunInput({
      threadId: "thread-1",
      runId: "run-refused",
    });

    // Kick off the first run and pull its first event so we know it has
    // registered itself as active before we start the second.
    const firstIter = agent.run(held);
    const firstStarted = (await firstIter.next()).value as
      | BaseEvent
      | undefined;
    expect(firstStarted?.type).toBe(EventType.RUN_STARTED);

    // Now the second run on the same thread should short-circuit.
    const secondEvents = await collectEvents(agent.run(refused));
    expect(secondEvents.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    // Correlation ids belong to the REFUSED request, not to the run holding
    // the thread: a client can only match the error to what it just sent.
    const started = secondEvents[0] as unknown as {
      threadId: string;
      runId: string;
    };
    expect(started.threadId).toBe("thread-1");
    expect(started.runId).toBe("run-refused");
    const err = secondEvents[1] as unknown as { code: string; message: string };
    expect(err.code).toBe("THREAD_BUSY");
    // Pinned in full: the Python adapter emits this string verbatim, and a
    // reword here would silently break that parity.
    expect(err.message).toBe(
      'Another run is already in progress on thread "thread-1". Wait for ' +
        "RUN_FINISHED before starting another.",
    );

    // The refusal must not have disturbed the incumbent: released, it runs to
    // a normal completion.
    release();
    const firstEvents = await collectEvents(firstIter);
    expect(firstStarted).toBeDefined();
    expectCleanRun([firstStarted as BaseEvent, ...firstEvents]);
  });

  it("separate threads can run concurrently without collision", async () => {
    const { stub: stub1, release: release1 } = blockableAgent();
    const { stub: stub2, release: release2 } = blockableAgent();
    const agent = new StrandsAgent({ agent: stub1, name: "t" });
    const internal = (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread;
    internal.set("a", stub1);
    internal.set("b", stub2);

    const inA = minimalRunInput({ threadId: "a", runId: "r-a" });
    const inB = minimalRunInput({ threadId: "b", runId: "r-b" });
    const itA = agent.run(inA);
    const itB = agent.run(inB);
    // Both runs are in flight before either is released, so the guard sees the
    // overlap it would refuse if it were keyed on anything coarser than the
    // thread.
    const firstA = (await itA.next()).value as BaseEvent;
    const firstB = (await itB.next()).value as BaseEvent;
    release1();
    release2();
    const [restA, restB] = await Promise.all([
      collectEvents(itA),
      collectEvents(itB),
    ]);
    expectCleanRun([firstA, ...restA]);
    expectCleanRun([firstB, ...restB]);
  });

  it("accepts a new run on a thread once the previous one has finished", async () => {
    const stub = scriptedAgent([]);
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);

    const first = await collectEvents(
      agent.run(minimalRunInput({ threadId: "thread-1", runId: "r-1" })),
    );
    expectCleanRun(first);

    const second = await collectEvents(
      agent.run(minimalRunInput({ threadId: "thread-1", runId: "r-2" })),
    );
    expectCleanRun(second);
  });
});
