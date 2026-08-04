import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";
import { ManagedAgentsAgent } from "../agent";
import { reportSwallowedFailure } from "../report";
import type { ManagedAgentsErrorContext } from "../types";
import { createFakeClient } from "./fake-client";

const baseInput = () =>
  ({
    threadId: "thread_1",
    runId: "run_1",
    state: null,
    messages: [{ id: "u1", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
  }) as never;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait until `predicate` holds, for work that lands after the run is gone. */
const until = async (predicate: () => boolean, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const collect = async (agent: ManagedAgentsAgent): Promise<BaseEvent[]> => {
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve) =>
    agent.run(baseInput()).subscribe({ next: (event) => events.push(event), complete: () => resolve() }),
  );
  return events;
};

describe("onError", () => {
  it("reports an interrupt that could not be posted", async () => {
    const reported: { error: unknown; context: ManagedAgentsErrorContext }[] = [];
    // The stream hangs so the run is still open when the client leaves; the
    // interrupt is then the send that fails.
    const fake = createFakeClient({
      streams: [[new Promise<void>(() => {})]],
      sendResults: [undefined, new Error("interrupt rejected")],
    });
    const agent = new ManagedAgentsAgent({
      managedAgentId: "agent_1",
      environmentId: "env_1",
      client: fake.client,
      onError: (error, context) => void reported.push({ error, context }),
    });

    const subscription = agent.run(baseInput()).subscribe({ next: () => {} });
    await settle();
    subscription.unsubscribe();
    await settle();

    // The abandoned run is reported too (see below); the interrupt failure is
    // the one this test is about.
    const interrupt = reported.find((entry) => entry.context.operation === "interrupt");
    expect(interrupt).toBeDefined();
    expect((interrupt!.error as Error).message).toBe("interrupt rejected");
    expect(interrupt!.context.sessionId).toBe("sesn_1");
  });

  it("reports a backend tool that fails after the run walked away", async () => {
    // The handler is abandoned when the client leaves; its later rejection has
    // nowhere to go, and consuming it silently is the only reason a failing
    // backend tool could go unnoticed entirely.
    const reported: ManagedAgentsErrorContext[] = [];
    let rejectHandler!: (error: Error) => void;
    const fake = createFakeClient({ streams: [[{ type: "agent.custom_tool_use", id: "ctu_1", name: "slow_tool", input: {} }, new Promise<void>(() => {})]] });
    const agent = new ManagedAgentsAgent({
      managedAgentId: "agent_1",
      environmentId: "env_1",
      client: fake.client,
      backendTools: [
        {
          name: "slow_tool",
          description: "",
          parameters: {},
          handler: () => new Promise<string>((_resolve, reject) => (rejectHandler = reject)),
        },
      ],
      onError: (_error, context) => void reported.push(context),
    });

    const subscription = agent.run(baseInput()).subscribe({ next: () => {} });
    await settle();
    subscription.unsubscribe();
    await settle();

    // The handler only fails after the run is gone.
    rejectHandler(new Error("tool blew up late"));
    await settle();

    expect(reported.map((context) => context.operation)).toContain("abandoned_backend_tool");
  });

  it("reports a run that failed after the client disconnected", async () => {
    // Nothing can be emitted to a client that left, so the hook is the only
    // place this failure can show up.
    const reported: { error: unknown; context: ManagedAgentsErrorContext }[] = [];
    const fake = createFakeClient({ streams: [[new Promise<void>(() => {})]] });
    // Fail the session-create so the run rejects the moment it is abandoned.
    const originalStream = fake.client.beta.sessions.events.stream;
    fake.client.beta.sessions.events.stream = (async (...args: unknown[]) => {
      const stream = await (originalStream as (...a: unknown[]) => Promise<{ [Symbol.asyncIterator]: unknown }>)(...args);
      return {
        ...stream,
        async *[Symbol.asyncIterator]() {
          await settle();
          throw new Error("stream died");
        },
      };
    }) as typeof originalStream;
    const agent = new ManagedAgentsAgent({
      managedAgentId: "agent_1",
      environmentId: "env_1",
      client: fake.client,
      onError: (error, context) => void reported.push({ error, context }),
    });

    const subscription = agent.run(baseInput()).subscribe({ next: () => {} });
    await settle();
    subscription.unsubscribe();
    await settle();
    await settle();

    expect(reported.map((entry) => entry.context.operation)).toContain("run_after_disconnect");
  });

  it("awaits an async hook, so its telemetry is not left racing the run", async () => {
    // Regression: TypeScript accepts an async function wherever a void-returning
    // callback is expected, and the hook was called without awaiting or
    // absorbing it — so telemetry raced the end of the run and a rejection
    // became an unhandled rejection, which by Node's default kills the process.
    const reported: string[] = [];
    const fake = createFakeClient({
      // The stream hangs so the turn times out; the interrupt is then the send
      // that fails and gets reported.
      streams: [[new Promise<void>(() => {})]],
      sendResults: [undefined, new Error("interrupt rejected")],
    });
    const agent = new ManagedAgentsAgent({
      managedAgentId: "agent_1",
      environmentId: "env_1",
      client: fake.client,
      turnTimeoutMs: 30,
      onError: async (_error, context) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        reported.push(context.operation);
      },
    });

    const events = await collect(agent);

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "turn_timeout" });
    // No polling: the run cannot reach its terminal event before an awaited
    // hook has finished, so this only holds if the hook really is awaited.
    expect(reported).toContain("interrupt");
  });

  it("an async hook that rejects does not break the run", async () => {
    // The rejection has no caller to reach, so it must be absorbed rather than
    // left to terminate the process.
    const fake = createFakeClient({
      streams: [[{ type: "session.status_idle", id: "idle_1", stop_reason: { type: "end_turn" } }]],
    });
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const agent = new ManagedAgentsAgent({
        managedAgentId: "agent_1",
        environmentId: "env_1",
        client: fake.client,
        onError: async () => {
          throw new Error("telemetry backend is down");
        },
      });

      const events = await collect(agent);
      // Let any unhandled rejection surface before asserting there was none.
      await settle();

      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("absorbs an async hook rejection on the detached report path", async () => {
    // The abandoned-handler report fires from a callback that cannot await, so
    // its rejection is the one most likely to escape.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectHandler!: (error: Error) => void;
      const fake = createFakeClient({
        streams: [[{ type: "agent.custom_tool_use", id: "ctu_1", name: "slow_tool", input: {} }, new Promise<void>(() => {})]],
      });
      const reported: string[] = [];
      const agent = new ManagedAgentsAgent({
        managedAgentId: "agent_1",
        environmentId: "env_1",
        client: fake.client,
        backendTools: [
          {
            name: "slow_tool",
            description: "",
            parameters: {},
            handler: () => new Promise<string>((_resolve, reject) => (rejectHandler = reject)),
          },
        ],
        onError: async (_error, context) => {
          reported.push(context.operation);
          throw new Error("telemetry backend is down");
        },
      });

      const subscription = agent.run(baseInput()).subscribe({ next: () => {} });
      await settle();
      subscription.unsubscribe();
      await settle();
      // The handler only fails once the run is gone, so this report is the one
      // that fires from a frame with nothing left to await it.
      rejectHandler(new Error("tool blew up late"));
      await until(() => reported.includes("abandoned_backend_tool"));

      expect(reported).toContain("abandoned_backend_tool");
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a throwing hook does not break the run", async () => {
    const fake = createFakeClient({
      streams: [[{ type: "session.status_idle", id: "idle_1", stop_reason: { type: "end_turn" } }]],
    });
    const agent = new ManagedAgentsAgent({
      managedAgentId: "agent_1",
      environmentId: "env_1",
      client: fake.client,
      onError: () => {
        throw new Error("hook is broken");
      },
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) =>
      agent.run(baseInput()).subscribe({ next: (event) => events.push(event), complete: () => resolve() }),
    );
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it("logs the cause to stderr when no hook is configured", async () => {
    // RUN_ERROR deliberately carries no third-party text, so with no hook the
    // cause used to be discarded outright: a rotated API key showed the user
    // "The run failed." and left the server log empty.
    const seen: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void seen.push(args);
    try {
      await reportSwallowedFailure(undefined, "interrupt", new Error("boom"), { sessionId: "sesn_1" });
    } finally {
      console.error = original;
    }
    expect(seen).toHaveLength(1);
    expect(String(seen[0]?.[0])).toContain("interrupt");
    expect(seen[0]?.[2]).toBeInstanceOf(Error);
  });

  it("abandons a hook that never settles instead of holding its caller", async () => {
    // The shape of `await fetch(...)` against a host that blackholes the
    // connection. Callers await this report before emitting the run's terminal
    // event, so without a bound the run never terminates, the stream never
    // completes, and the thread's run gate is never released — every later run
    // on that thread is refused for the process's lifetime. If the bound is
    // removed this never resolves and the test fails on vitest's own timeout.
    let called = false;
    await reportSwallowedFailure(
      () => {
        called = true;
        return new Promise<void>(() => {}); // never settles
      },
      "interrupt",
      new Error("boom"),
      { sessionId: "sesn_1" },
      20,
    );
    expect(called).toBe(true);
  });
});
