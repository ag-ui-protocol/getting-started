import { EventType, type BaseEvent } from "@ag-ui/core";
import { InMemorySessionService, Runner, createEvent } from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKAgent } from "../index";
import { ScriptedAgent, collect, runInput, textEvent } from "./helpers";

describe("ADKAgent run lifecycle and configuration", () => {
  it("preserves ADK configuration across CopilotKit request clones", async () => {
    const runner = new Runner({
      appName: "test-app",
      agent: new ScriptedAgent(() => [
        textEvent({ id: "clone-answer", text: "cloned" }),
      ]),
      sessionService: new InMemorySessionService(),
    });
    const original = new ADKAgent({ runner, userId: "user-1" });
    const cloned = original.clone();
    cloned.threadId = "clone-thread";
    cloned.messages = [{ id: "clone-user", role: "user", content: "Hello" }];
    cloned.state = { source: "clone" };
    // AbstractAgent.runAgent exposes its subscriber at the base protocol type.
    const events: BaseEvent[] = [];

    await cloned.runAgent(
      { runId: "clone-run" },
      { onEvent: ({ event }) => void events.push(event) },
    );

    expect(cloned).toBeInstanceOf(ADKAgent);
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("advertises only bridge-known capabilities unless explicitly configured", async () => {
    const runner = new Runner({
      appName: "test-app",
      agent: new ScriptedAgent(() => []),
      sessionService: new InMemorySessionService(),
    });
    const conservative = await new ADKAgent({
      runner,
      userId: "user-1",
    }).getCapabilities();

    expect(conservative.tools).toMatchObject({
      supported: true,
      parallelCalls: false,
    });
    expect(conservative.reasoning).toBeUndefined();
    expect(conservative.multimodal).toBeUndefined();

    const declared = await new ADKAgent({
      runner,
      userId: "user-1",
      capabilities: {
        tools: { parallelCalls: true },
        reasoning: { supported: true, streaming: true },
        multimodal: { input: { image: true } },
      },
    }).getCapabilities();
    expect(declared.tools).toMatchObject({
      supported: true,
      parallelCalls: true,
    });
    expect(declared.reasoning).toEqual({ supported: true, streaming: true });
    expect(declared.multimodal).toEqual({ input: { image: true } });

    const factoryCapabilities = await new ADKAgent({
      runnerFactory: () => runner,
      userId: "user-1",
    }).getCapabilities();
    expect(factoryCapabilities.tools).not.toHaveProperty("clientProvided");
    expect(factoryCapabilities.state).not.toHaveProperty("persistentState");

    const explicitEmptyToolsets = await new ADKAgent({
      runnerFactory: () => runner,
      clientToolsets: [],
      userId: "user-1",
    }).getCapabilities();
    expect(explicitEmptyToolsets.tools).toHaveProperty("clientProvided", false);
  });

  it("surfaces unsupported instruction history as a protocol error", async () => {
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        agent: new ScriptedAgent(() => []),
        sessionService: new InMemorySessionService(),
      }),
      userId: "user-1",
    });
    const events = await collect(
      bridge,
      runInput({
        messages: [
          { id: "system-1", role: "system", content: "Dynamic instruction" },
          { id: "user-1", role: "user", content: "Hello" },
        ],
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "UNSUPPORTED_MESSAGE_ROLE",
    });
  });

  it("runs an ADK Runner, exposes AG-UI state to ADK, and emits one lifecycle", async () => {
    let observedState: Record<string, unknown> | undefined;
    const root = new ScriptedAgent((context) => {
      observedState = structuredClone(context.session.state);
      const stateEvent = textEvent({ id: "answer", text: "Hello back" });
      stateEvent.actions.stateDelta = { count: 2 };
      return [stateEvent];
    });
    const runner = new Runner({
      appName: "test-app",
      agent: root,
      sessionService: new InMemorySessionService(),
    });
    const bridge = new ADKAgent({ runner, userId: "user-1" });

    const events = await collect(
      bridge,
      runInput({
        state: { count: 1 },
        context: [{ description: "tenant", value: "acme" }],
      }),
    );

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1]).toEqual({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { count: 1 },
    });
    expect(observedState).toMatchObject({ count: 1 });
    expect(
      events.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === EventType.RUN_ERROR),
    ).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("preserves usage collected before an ADK run error", async () => {
    const usage = createEvent({
      id: "usage-before-error",
      author: "scripted_agent",
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 1,
        totalTokenCount: 5,
      },
    });
    usage.modelVersion = "local-test-model";
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => [
          usage,
          createEvent({
            id: "model-error",
            author: "scripted_agent",
            errorCode: "MODEL_ERROR",
            errorMessage: "model failed",
          }),
        ]),
      }),
      userId: "user-1",
      usageProvider: "openai-compatible",
    });

    const events = await collect(bridge, runInput());

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "MODEL_ERROR",
      usage: [
        {
          provider: "openai-compatible",
          model: "local-test-model",
          inputTokens: 4,
          outputTokens: 1,
          totalTokens: 5,
        },
      ],
    });
  });

  it("clears stale ADK values when a later AG-UI snapshot removes a key", async () => {
    const observedStates: Record<string, unknown>[] = [];
    const sessionService = new InMemorySessionService();
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService,
        agent: new ScriptedAgent((context) => {
          observedStates.push(structuredClone(context.session.state));
          return [
            textEvent({ id: crypto.randomUUID(), text: "state observed" }),
          ];
        }),
      }),
      userId: "user-1",
    });

    const firstMessage = {
      id: "user-1",
      role: "user" as const,
      content: "First",
    };
    await collect(
      bridge,
      runInput({
        state: { keep: 1, removed: "stale" },
        messages: [firstMessage],
      }),
    );
    const second = await collect(
      bridge,
      runInput({
        runId: "run-2",
        state: { keep: 2 },
        messages: [
          firstMessage,
          { id: "user-2", role: "user", content: "Second" },
        ],
      }),
    );

    expect(observedStates[1]).toMatchObject({ keep: 2, removed: null });
    expect(
      second.filter((event) => event.type === EventType.STATE_SNAPSHOT).at(-1),
    ).toEqual({ type: EventType.STATE_SNAPSHOT, snapshot: { keep: 2 } });
    const session = await sessionService.getSession({
      appName: "test-app",
      userId: "user-1",
      sessionId: "thread-1",
    });
    expect(session?.state.removed).toBeNull();
  });

  it("rejects client writes to ADK app, user, and temporary state scopes", async () => {
    let executions = 0;
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => {
          executions += 1;
          return [];
        }),
      }),
      userId: "user-1",
    });

    for (const key of ["app:shared", "user:profile", "temp:working"]) {
      const events = await collect(
        bridge.clone(),
        runInput({
          threadId: `thread-${key}`,
          runId: `run-${key}`,
          state: { [key]: "not-allowed" },
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        code: "RESERVED_STATE_SCOPE",
      });
    }
    expect(executions).toBe(0);
  });

  it("does not duplicate full-history user messages in the ADK session", async () => {
    const sessionService = new InMemorySessionService();
    const bridge = new ADKAgent({
      userId: "user-1",
      runner: new Runner({
        appName: "test-app",
        sessionService,
        agent: new ScriptedAgent(() => [
          textEvent({ id: crypto.randomUUID(), text: "done" }),
        ]),
      }),
    });

    const firstMessage = {
      id: "user-1",
      role: "user" as const,
      content: "first",
    };
    await collect(bridge, runInput({ messages: [firstMessage] }));
    await collect(
      bridge,
      runInput({
        runId: "run-2",
        messages: [
          firstMessage,
          { id: "user-2", role: "user", content: "second" },
        ],
      }),
    );

    const session = await sessionService.getSession({
      appName: "test-app",
      userId: "user-1",
      sessionId: "thread-1",
    });
    const userTexts = session?.events
      .filter((event) => event.author === "user")
      .flatMap((event) => event.content?.parts ?? [])
      .map((part) => part.text)
      .filter(Boolean);
    expect(userTexts).toEqual(["first", "second"]);
  });
});
