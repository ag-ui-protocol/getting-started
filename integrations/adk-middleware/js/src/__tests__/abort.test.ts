import { EventType } from "@ag-ui/core";
import { InMemorySessionService, Runner, createEvent } from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKJSAgent } from "../index";
import {
  ScriptedAgent,
  collect,
  runInput,
  textEvent,
  verified,
} from "./helpers";

describe("ADKJSAgent abort", () => {
  it("turns abortRun into one ABORTED terminal event", async () => {
    const bridge = new ADKJSAgent({
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

  it("propagates stream unsubscription as an ADK abort and releases the thread", async () => {
    let execution = 0;
    let signalStarted!: () => void;
    let abortObserved!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });
    const bridge = new ADKJSAgent({
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
    // Unsubscribing gives no completion signal; the release is what is under test.
    const { activeThreads } = bridge as unknown as {
      activeThreads: Set<string>;
    };
    await expect.poll(() => activeThreads.size, { timeout: 1000 }).toBe(0);

    // The same user and thread: THREAD_BUSY here would mean the gate leaked.
    const next = await collect(
      bridge,
      runInput({
        runId: "run-2",
        messages: [{ id: "user-2", role: "user", content: "Again" }],
      }),
    );
    expect(next.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("does not report a sub-agent as finished when the run is aborted", async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const child = new ScriptedAgent(() => [], { name: "child" });
    const root = new ScriptedAgent(
      async function* (context) {
        yield createEvent({
          id: "child-partial",
          author: "child",
          partial: true,
          content: { role: "model", parts: [{ text: "working" }] },
        });
        signalStarted();
        await new Promise<void>((resolve) => {
          context.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
      { name: "root", subAgents: [child] },
    );
    const bridge = new ADKJSAgent({
      userId: "user-1",
      subagents: "attributed",
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: root,
      }),
    });

    const result = collect(bridge, runInput());
    await started;
    bridge.abortRun();
    const events = await result;

    const types = events.map((event) => event.type);
    expect(types).toContain(EventType.SUBAGENT_STARTED);
    expect(types).not.toContain(EventType.SUBAGENT_FINISHED);
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "ABORTED",
    });
    await verified(events);
  });
});
