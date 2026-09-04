/**
 * `detachActiveRun()` across CONCURRENT runs.
 *
 * The agent supports more than one run in flight at a time (see
 * agent-concurrent.test.ts). The detach handle used to be a single field, so a
 * second run overwrote the first one's — leaving the first run with nothing
 * that could ever tear it down.
 */
import { Observable, Subscriber } from "rxjs";
import { AbstractAgent } from "@/agent";
import { BaseEvent, EventType, RunAgentInput, RunStartedEvent } from "@ag-ui/core";

/** Emits RUN_STARTED and then hangs, until the test decides otherwise. */
class HangingAgent extends AbstractAgent {
  public open: Array<Subscriber<BaseEvent>> = [];
  public teardowns = 0;

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.open.push(subscriber);
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as RunStartedEvent);
      return () => {
        this.teardowns += 1;
      };
    });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForRuns(agent: HangingAgent, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && agent.open.length < count; attempt++) {
    await tick();
  }
  expect(agent.open.length).toBe(count);
}

/** Whether every promise settled before the deadline. */
async function settledWithin(promises: Promise<unknown>[], ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    const outcome = await Promise.race([
      Promise.allSettled(promises).then(() => "settled" as const),
      deadline,
    ]);
    return outcome === "settled";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("detachActiveRun with more than one run in flight", () => {
  it("tears down every in-flight run, not only the most recent", async () => {
    const agent = new HangingAgent();

    const first = agent.runAgent({ runId: "detach-r1" });
    await waitForRuns(agent, 1);
    const second = agent.runAgent({ runId: "detach-r2" });
    await waitForRuns(agent, 2);

    await agent.detachActiveRun();

    expect(await settledWithin([first, second], 500)).toBe(true);
    expect(agent.teardowns).toBe(2);
  });

  it("leaves a still-running sibling alone when one run finishes on its own", async () => {
    // The mirror of the bug: each run's finalize must clear only ITS OWN
    // handle, or a run that ends normally disarms detach for the others.
    const agent = new HangingAgent();

    const first = agent.runAgent({ runId: "detach-r3" });
    await waitForRuns(agent, 1);
    const second = agent.runAgent({ runId: "detach-r4" });
    await waitForRuns(agent, 2);

    agent.open[1].complete();
    await second;

    await agent.detachActiveRun();
    expect(await settledWithin([first], 500)).toBe(true);
  });

  it("is a no-op when nothing is running", async () => {
    // "Resolves with undefined" is what an early return and a full teardown of
    // nothing both look like. What "no-op" actually claims is that it touched
    // no run and awaited no completion, so assert that: no subscription was
    // ever opened, nothing was torn down, and a run started AFTERWARDS is
    // unaffected by the call.
    const agent = new HangingAgent();

    await agent.detachActiveRun();

    expect(agent.open).toHaveLength(0);
    expect(agent.teardowns).toBe(0);

    const later = agent.runAgent({ runId: "detach-r5" });
    await waitForRuns(agent, 1);
    expect(agent.teardowns).toBe(0);

    await agent.detachActiveRun();
    expect(await settledWithin([later], 500)).toBe(true);
    expect(agent.teardowns).toBe(1);
  });
});
