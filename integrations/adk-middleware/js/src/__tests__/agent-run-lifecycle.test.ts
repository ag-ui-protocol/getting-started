import { EventType, type BaseEvent } from "@ag-ui/core";
import {
  InMemorySessionService,
  IntentMismatchError,
  LlmAgent,
  Runner,
  StreamingMode,
  Workflow,
  createEvent,
} from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKJSAgent, AGUIClientToolset } from "../index";
import {
  ScriptedAgent,
  collect,
  runInput,
  textEvent,
  verified,
} from "./helpers";

describe("ADKJSAgent run lifecycle and configuration", () => {
  it("preserves ADK configuration across CopilotKit request clones", async () => {
    const runner = new Runner({
      appName: "test-app",
      agent: new ScriptedAgent(() => [
        textEvent({ id: "clone-answer", text: "cloned" }),
      ]),
      sessionService: new InMemorySessionService(),
    });
    const original = new ADKJSAgent({ runner, userId: "user-1" });
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

    expect(cloned).toBeInstanceOf(ADKJSAgent);
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
    const conservative = await new ADKJSAgent({
      runner,
      userId: "user-1",
    }).getCapabilities();

    expect(conservative.tools).toMatchObject({
      supported: true,
      parallelCalls: false,
    });
    expect(conservative.reasoning).toBeUndefined();
    expect(conservative.multimodal).toBeUndefined();

    const declared = await new ADKJSAgent({
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

    // A root without a tools list (this scripted BaseAgent) cannot receive
    // frontend tools, and sessions always persist through the session service.
    const factoryCapabilities = await new ADKJSAgent({
      appName: "test-app",
      sessionService: new InMemorySessionService(),
      agent: () => runner.agent,
      userId: "user-1",
    }).getCapabilities();
    expect(factoryCapabilities.tools).toHaveProperty("clientProvided", false);
    expect(factoryCapabilities.state).toEqual({
      snapshots: true,
      deltas: true,
    });

    const explicitEmptyToolsets = await new ADKJSAgent({
      runner,
      clientToolsets: [],
      userId: "user-1",
    }).getCapabilities();
    expect(explicitEmptyToolsets.tools).toHaveProperty("clientProvided", false);
  });

  it("surfaces unsupported instruction history as a protocol error", async () => {
    const bridge = new ADKJSAgent({
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

  it("passes AG-UI state into the ADK session and emits exactly one run lifecycle", async () => {
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
    const bridge = new ADKJSAgent({ runner, userId: "user-1" });

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
    const bridge = new ADKJSAgent({
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
    const bridge = new ADKJSAgent({
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
    const bridge = new ADKJSAgent({
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
    const bridge = new ADKJSAgent({
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

  it("closes a message still streaming after the last ADK event before RUN_FINISHED", async () => {
    // A run whose final ADK event is a partial chunk must not leave a
    // TEXT_MESSAGE_START open: the protocol verifier rejects RUN_FINISHED
    // with an active message.
    const runner = new Runner({
      appName: "test-app",
      agent: new ScriptedAgent(() => [
        textEvent({ id: "open", text: "still stre", partial: true }),
      ]),
      sessionService: new InMemorySessionService(),
    });
    const events = await collect(
      new ADKJSAgent({ runner, userId: "user-1" }),
      runInput(),
    );

    const types = events.map((event) => event.type);
    expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeGreaterThan(
      types.indexOf(EventType.TEXT_MESSAGE_CONTENT),
    );
    expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(
      types.indexOf(EventType.RUN_FINISHED),
    );
    await verified(events);
  });

  it("fails the run when the userId resolver returns an empty string", async () => {
    // An empty ADK userId would silently share one session across users.
    const runner = new Runner({
      appName: "test-app",
      agent: new ScriptedAgent(() => [textEvent({ id: "x", text: "never" })]),
      sessionService: new InMemorySessionService(),
    });
    const events = await collect(
      new ADKJSAgent({ runner, userId: async () => "" }),
      runInput(),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: expect.stringMatching(
        /userId must resolve to a non-empty string/,
      ),
    });
    expect(
      events.some((event) => event.type === EventType.TEXT_MESSAGE_START),
    ).toBe(false);
  });

  it("reports ADK's confirmation-binding refusal as a coded INTENT_MISMATCH run error", async () => {
    const runner = new Runner({
      appName: "test-app",
      agent: new ScriptedAgent(() => {
        throw new IntentMismatchError({
          reason: "arguments_mismatch",
          functionCallId: "delete-1",
        });
      }),
      sessionService: new InMemorySessionService(),
    });
    const events = await collect(
      new ADKJSAgent({ runner, userId: "user-1" }),
      runInput(),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "INTENT_MISMATCH",
      message: expect.stringContaining("arguments_mismatch"),
    });
  });

  it("refuses StreamingMode.BIDI with a coded error before the run starts", async () => {
    let started = false;
    const runner = new Runner({
      appName: "test-app",
      agent: new ScriptedAgent(() => {
        started = true;
        return [textEvent({ id: "x", text: "never" })];
      }),
      sessionService: new InMemorySessionService(),
    });
    const events = await collect(
      new ADKJSAgent({
        runner,
        userId: "user-1",
        runConfig: { streamingMode: StreamingMode.BIDI },
      }),
      runInput(),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "STREAMING_MODE_UNSUPPORTED",
    });
    expect(started).toBe(false);
  });

  it("refuses frontend tools for a Workflow root with a coded error", async () => {
    const runner = new Runner({
      appName: "test-app",
      agent: new Workflow({
        name: "wf",
        edges: [
          ["START", new LlmAgent({ name: "node", model: "gemini-2.5-flash" })],
        ],
      }),
      sessionService: new InMemorySessionService(),
    });
    const events = await collect(
      new ADKJSAgent({ runner, userId: "user-1" }),
      runInput({
        tools: [
          {
            name: "client_action",
            description: "x",
            parameters: { type: "object" },
          },
        ],
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "CLIENT_TOOLS_UNSUPPORTED",
    });
  });

  it("refuses a clientToolsets entry that no agent in the tree carries", async () => {
    const bridge = new ADKJSAgent({
      userId: "user-1",
      appName: "test-app",
      sessionService: new InMemorySessionService(),
      agent: new ScriptedAgent(() => [textEvent({ id: "t", text: "hi" })]),
      clientToolsets: [new AGUIClientToolset()],
    });
    const events = await collect(bridge, runInput());
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "CLIENT_TOOLSET_NOT_PLACED",
    });
  });
});
