import { EventType } from "@ag-ui/core";
import { InMemorySessionService, Runner } from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKAgent } from "../index";
import { ScriptedAgent, collect, runInput, textEvent } from "./helpers";

describe("ADKAgent abort", () => {
  it("turns abortRun into one ABORTED terminal event", async () => {
    const bridge = new ADKAgent({
      userId: "user-1",
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(async (context) => {
          await new Promise<void>((resolve) => {
            context.abortSignal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return [];
        }),
      }),
    });

    const result = collect(bridge, runInput());
    await new Promise((resolve) => setTimeout(resolve, 5));
    bridge.abortRun();
    const events = await result;

    expect(
      events.filter((event) => event.type === EventType.RUN_ERROR),
    ).toEqual([
      expect.objectContaining({ type: EventType.RUN_ERROR, code: "ABORTED" }),
    ]);
    expect(
      events.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(0);
  });

  it("propagates stream unsubscription as an ADK abort and releases the runner", async () => {
    let execution = 0;
    let signalStarted!: () => void;
    let abortObserved!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });
    const bridge = new ADKAgent({
      userId: "user-1",
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(async (context) => {
          execution += 1;
          if (execution > 1) {
            return [textEvent({ id: "after-disconnect", text: "available" })];
          }
          signalStarted();
          await new Promise<void>((resolve) => {
            context.abortSignal?.addEventListener(
              "abort",
              () => {
                abortObserved();
                resolve();
              },
              { once: true },
            );
          });
          return [];
        }),
      }),
    });

    const subscription = bridge.run(runInput()).subscribe();
    await started;
    subscription.unsubscribe();
    await aborted;

    const next = await collect(
      bridge,
      runInput({ threadId: "thread-2", runId: "run-2" }),
    );
    expect(next.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });
});
