import { EventType } from "@ag-ui/core";
import { InMemorySessionService, Runner } from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKJSAgent, type ADKJSAgentConfig } from "../index";
import {
  ScriptedAgent,
  collect,
  runInput,
  textEvent,
  verified,
} from "./helpers";

describe("ADKJSAgent concurrency", () => {
  const sharedRunner = (root: () => ScriptedAgent): ADKJSAgentConfig => ({
    userId: "user-1",
    runner: new Runner({
      appName: "test-app",
      agent: root(),
      sessionService: new InMemorySessionService(),
    }),
  });
  const factoryRoot = (root: () => ScriptedAgent): ADKJSAgentConfig => ({
    userId: "user-1",
    appName: "test-app",
    sessionService: new InMemorySessionService(),
    agent: root,
  });

  it.each([
    ["one shared runner", sharedRunner],
    ["factory-built roots", factoryRoot],
  ])("runs different threads concurrently on %s", async (_label, configure) => {
    let active = 0;
    let maximumActive = 0;
    const bridge = new ADKJSAgent(
      configure(
        () =>
          new ScriptedAgent(async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return [textEvent({ id: crypto.randomUUID(), text: "done" })];
          }),
      ),
    );

    await Promise.all([
      collect(bridge, runInput({ threadId: "thread-a", runId: "run-a" })),
      collect(bridge, runInput({ threadId: "thread-b", runId: "run-b" })),
    ]);
    expect(maximumActive).toBe(2);
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
    const bridge = new ADKJSAgent({
      userId: "user-1",
      appName: "test-app",
      sessionService: new InMemorySessionService(),
      agent: () =>
        new ScriptedAgent(async () => {
          executions += 1;
          if (executions === 1) {
            signalStarted();
            await firstMayFinish;
          }
          return [textEvent({ id: crypto.randomUUID(), text: "completed" })];
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
    await verified(rejected);
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
});
