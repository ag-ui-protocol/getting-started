/**
 * Seed building for one thread with slow multimodal URL fetches must not
 * serialize cold-cache inits for OTHER threads behind the global
 * _threadInitLock.
 *
 * The property is an ordering one, so it is asserted as ordering: thread A is
 * held open inside its seed fetch by a latch, and thread B must run to
 * completion before that latch is released.
 *
 * The release timer is a watchdog, not the discriminator: its only job is to
 * turn a serialised B (which would otherwise deadlock) into a readable
 * assertion. It is therefore set far above B's steady-state cost rather than
 * close to it. An earlier 1500ms timer against vitest's default 5000ms was
 * observed losing to a cold-cache B and failing the run, so the test now pays
 * the module-load and JIT cost up front with a warm-up run, and gives both the
 * watchdog and the test generous headroom above what B actually needs.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import type { BaseEvent } from "@ag-ui/core";
import {
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
} from "./helpers";
import { urlFetchTransport } from "../utils";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("seed build is outside _threadInitLock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "concurrent cold-inits on different threads don't serialise on a slow seed",
    { timeout: 30_000 },
    async () => {
      const firstFetch = deferred();
      const release = deferred();

      // The fetch policy resolves the host before connecting, so the fixture
      // host has to answer with a public address.
      vi.spyOn(dns.promises, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as never);

      // A's seed fetch parks until the test releases it, so A provably holds
      // whatever it is going to hold for as long as the test needs.
      vi.spyOn(urlFetchTransport, "request").mockImplementation(async () => {
        firstFetch.resolve();
        await release.promise;
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      // One script cursor is shared across both threads, so the turns are
      // consumed in whatever order the threads reach the model. Nothing here
      // depends on which thread got which, so both turns are identical. The
      // warm-up below runs first and consumes one of the three.
      const { agent, model } = realStrandsAgent([
        modelTurn.text("ok"),
        modelTurn.text("ok"),
        modelTurn.text("ok"),
      ]);

      // A cold first run through this path costs module loading and JIT, which
      // is what beat the watchdog before. Paying it here means the B measured
      // below is a steady-state B.
      const warmup: BaseEvent[] = [];
      for await (const e of agent.run(
        minimalRunInput({
          threadId: "warmup",
          messages: [{ id: "u-w1", role: "user", content: "hi" } as never],
        }),
      )) {
        warmup.push(e);
      }
      expectCompletedRun(warmup, "warm-up");

      const inputA = minimalRunInput({
        threadId: "a",
        messages: [
          {
            id: "u-a1",
            role: "user",
            content: [
              // The declared type is what makes the fetch reachable: the
              // converter checks it before spending any egress, so an
              // attachment typed as something it cannot deliver never gets as
              // far as the latch below.
              {
                type: "image",
                source: {
                  type: "url",
                  value: "https://example.invalid/slow.png",
                  mimeType: "image/png",
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
        // Held in a variable so its rejection is always handled. Left inline,
        // this derived promise rejects unhandled once A completes after the
        // release below, and surfaces as a stray failure in whichever test
        // happens to be running then.
        const aFinishedEarly = drainedA.then(() => {
          throw new Error(
            `thread A finished without fetching its remote image; events: ${eventsA
              .map((e) => e.type)
              .join(", ")}`,
          );
        });
        aFinishedEarly.catch(() => {});
        await Promise.race([firstFetch.promise, aFinishedEarly]);

        const drainedB = (async () => {
          for await (const e of agent.run(inputB)) eventsB.push(e);
          order.push("b-finished");
        })();

        // Watchdog only: releases A so a serialised B reports the assertion
        // below rather than hanging. Warmed up, B costs single-digit ms, so this
        // is three orders of magnitude of headroom.
        timer = setTimeout(() => {
          order.push("a-released");
          release.resolve();
        }, 10_000);
        await drainedB;

        // Order matters here. The watchdog is the only thing that can release A
        // early, so if it fired, that is the fact worth reporting: asserting on
        // `aFinished` first would blame A for finishing when the real cause was
        // B outrunning the timer, and the message written for that case would
        // never print.
        expect(
          order[0],
          "thread B did not finish while thread A held its seed fetch. Usually that means B serialised behind _threadInitLock; on a heavily loaded machine it can also mean B simply exceeded the release timer",
        ).toBe("b-finished");
        // A must still be parked in its fetch: that is what makes B's completion
        // evidence about the lock rather than about ordering luck.
        expect(aFinished, "thread A completed before thread B finished").toBe(
          false,
        );
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
      expect(model.calls).toBe(3);
    },
  );
});
