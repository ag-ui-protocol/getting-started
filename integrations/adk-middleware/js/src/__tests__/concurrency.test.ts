import { EventType } from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import { InMemorySessionService, Runner } from "@google/adk";
import { from, lastValueFrom, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

import { ADKAgent } from "../index";
import { ScriptedAgent, collect, runInput, textEvent } from "./helpers";

describe("ADKAgent concurrency", () => {
  it("globally serializes runs that share one Runner", async () => {
    let active = 0;
    let maximumActive = 0;
    const root = new ScriptedAgent(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return [textEvent({ id: crypto.randomUUID(), text: "done" })];
    });
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        agent: root,
        sessionService: new InMemorySessionService(),
      }),
      userId: "user-1",
    });

    await Promise.all([
      collect(bridge, runInput({ threadId: "thread-a", runId: "run-a" })),
      collect(bridge, runInput({ threadId: "thread-b", runId: "run-b" })),
    ]);
    expect(maximumActive).toBe(1);
  });

  it("fails fast instead of queueing overlapping runs on the same user and thread", async () => {
    let executions = 0;
    let signalStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sessionService = new InMemorySessionService();
    const bridge = new ADKAgent({
      userId: "user-1",
      runnerFactory: () =>
        new Runner({
          appName: "test-app",
          sessionService,
          agent: new ScriptedAgent(async () => {
            executions += 1;
            if (executions === 1) {
              signalStarted();
              await firstMayFinish;
            }
            return [textEvent({ id: crypto.randomUUID(), text: "completed" })];
          }),
        }),
    });

    const first = collect(
      bridge.clone(),
      runInput({ threadId: "same-thread", runId: "run-1" }),
    );
    await started;

    const rejected = await collect(
      bridge.clone(),
      runInput({ threadId: "same-thread", runId: "run-2" }),
    );

    expect(rejected.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.RUN_ERROR,
    ]);
    expect(rejected.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "THREAD_BUSY",
    });
    await expect(
      lastValueFrom(from(rejected).pipe(verifyEvents(false), toArray())),
    ).resolves.toHaveLength(rejected.length);
    expect(executions).toBe(1);

    releaseFirst();
    await expect(first).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: EventType.RUN_FINISHED }),
      ]),
    );

    const afterRelease = await collect(
      bridge.clone(),
      runInput({
        threadId: "same-thread",
        runId: "run-3",
        messages: [
          { id: "user-2", role: "user", content: "Run after release" },
        ],
      }),
    );
    expect(afterRelease.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    expect(executions).toBe(2);
  });

  it("lets factory-created runners execute different threads concurrently", async () => {
    let active = 0;
    let maximumActive = 0;
    const sessionService = new InMemorySessionService();
    const bridge = new ADKAgent({
      userId: "user-1",
      runnerFactory: () =>
        new Runner({
          appName: "test-app",
          sessionService,
          agent: new ScriptedAgent(async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return [textEvent({ id: crypto.randomUUID(), text: "done" })];
          }),
        }),
    });

    await Promise.all([
      collect(bridge, runInput({ threadId: "thread-a", runId: "run-a" })),
      collect(bridge, runInput({ threadId: "thread-b", runId: "run-b" })),
    ]);
    expect(maximumActive).toBe(2);
  });
});
