/**
 * Seed building for one thread with slow multimodal URL fetches must not
 * serialize cold-cache inits for OTHER threads behind the global
 * _threadInitLock.
 *
 * The property is an ordering one, so it is asserted as ordering: thread A is
 * held open inside its seed fetch by a latch, and thread B must run to
 * completion before that latch is released.
 *
 * The release timer is the discriminator, so this is a time bound rather than
 * a pure ordering check. It sits orders of magnitude above B's observed cost
 * (single-digit ms) to keep the margin wide, and under vitest's default 5000ms
 * timeout so a serialised B fails on the assertion below rather than aborting
 * as a bare timeout. A machine that cannot run B inside it reports the
 * serialisation message misleadingly.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { BaseEvent } from "@ag-ui/core";
import {
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
} from "./helpers";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("seed build is outside _threadInitLock", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("concurrent cold-inits on different threads don't serialise on a slow seed", async () => {
    const firstFetch = deferred();
    const release = deferred();

    // A's seed fetch parks until the test releases it, so A provably holds
    // whatever it is going to hold for as long as the test needs.
    globalThis.fetch = (async (): Promise<Response> => {
      firstFetch.resolve();
      await release.promise;
      // No Content-Type on the response, so the converter logs "No MIME type
      // provided" and drops the block harmlessly. The body is incidental.
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, {
        status: 200,
      }) as Response;
    }) as typeof fetch;

    // One script cursor is shared across both threads, so the turns are
    // consumed in whatever order the threads reach the model. Nothing here
    // depends on which thread got which, so both turns are identical.
    const { agent, model } = realStrandsAgent([
      modelTurn.text("ok"),
      modelTurn.text("ok"),
    ]);

    const inputA = minimalRunInput({
      threadId: "a",
      messages: [
        {
          id: "u-a1",
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                value: "https://example.invalid/slow.png",
              },
            },
          ],
        } as never,
        { id: "u-a2", role: "user", content: "hi" } as never,
      ],
    });
    const inputB = minimalRunInput({
      threadId: "b",
      messages: [{ id: "u-b1", role: "user", content: "hi" } as never],
    });

    const eventsA: BaseEvent[] = [];
    const eventsB: BaseEvent[] = [];
    const order: string[] = [];

    // Drain A in the background. `run()` is a lazy generator: pulling a single
    // event only parks it on RUN_STARTED, which is emitted before the agent is
    // built, so A has to be actively consumed to reach the seed fetch at all.
    let aFinished = false;
    const drainedA = (async () => {
      for await (const e of agent.run(inputA)) eventsA.push(e);
      aFinished = true;
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A is now inside the seed fetch and cannot proceed until released.
      // If A fails before fetching, surface that instead of hanging here.
      await Promise.race([
        firstFetch.promise,
        drainedA.then(() => {
          throw new Error(
            `thread A finished without fetching its remote image; events: ${eventsA
              .map((e) => e.type)
              .join(", ")}`,
          );
        }),
      ]);

      const drainedB = (async () => {
        for await (const e of agent.run(inputB)) eventsB.push(e);
        order.push("b-finished");
      })();

      // Watchdog only: releases A so a serialised B reports the assertion
      // below rather than hanging. B costs single-digit ms in practice.
      timer = setTimeout(() => {
        order.push("a-released");
        release.resolve();
      }, 1500);
      await drainedB;

      // A must still be parked in its fetch: that is what makes B's completion
      // evidence about the lock rather than about ordering luck.
      expect(aFinished, "thread A completed before thread B started").toBe(
        false,
      );
      expect(
        order[0],
        "thread B did not finish while thread A held its seed fetch. Usually that means B serialised behind _threadInitLock; on a heavily loaded machine it can also mean B simply exceeded the release timer",
      ).toBe("b-finished");
    } finally {
      if (timer) clearTimeout(timer);
      release.resolve();
      // A's own failure must not replace an assertion error raised above; the
      // completed-run check below is what reports it.
      await drainedA.catch(() => {});
    }

    // Both runs must actually have run: the ordering above holds just as well
    // when the adapter fails internally and the failure is swallowed.
    expectCompletedRun(eventsA, "thread a");
    expectCompletedRun(eventsB, "thread b");
    expect(model.calls).toBe(2);
  });
});
