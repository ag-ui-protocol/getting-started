import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LangGraphAgent, LangGraphAgentConfig } from "../agent";

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Minimal mock assistant returned by assistants.search */
const MOCK_ASSISTANT = {
  assistant_id: "asst-1",
  graph_id: "test-graph",
  config: { configurable: {} },
};

/** Minimal mock graph info returned by assistants.getGraph */
const MOCK_GRAPH_INFO = { nodes: [], edges: [] };

/**
 * Build a LangGraphAgent with mocked LangGraphClient internals so that
 * prepareStream can execute without hitting a real LangGraph server.
 *
 * The returned `capturedPayload` will hold the payload passed to runs.stream
 * after prepareStream runs.
 */
function buildMockedAgent(
  configOverrides: Partial<LangGraphAgentConfig> = {},
  schemaKeysOverride?: {
    config?: string[] | null;
    input?: string[] | null;
    output?: string[] | null;
    context?: string[] | null;
  },
) {
  const capturedPayload: { value: Record<string, unknown> | null } = {
    value: null,
  };

  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
    ...configOverrides,
  });

  // Initialize activeRun (normally set by runAgentStream before prepareStream is called)
  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
  };

  // Mock the client methods that prepareStream calls
  (agent as any).client = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      getState: vi
        .fn()
        .mockResolvedValue({ values: { messages: [] }, tasks: [] }),
      getHistory: vi.fn().mockResolvedValue([]),
      updateState: vi.fn().mockResolvedValue({}),
    },
    assistants: {
      search: vi.fn().mockResolvedValue([MOCK_ASSISTANT]),
      getGraph: vi.fn().mockResolvedValue(MOCK_GRAPH_INFO),
      getSchemas: vi.fn().mockResolvedValue({
        config_schema: schemaKeysOverride?.config
          ? {
              properties: Object.fromEntries(
                schemaKeysOverride.config.map((k) => [k, {}]),
              ),
            }
          : undefined,
        input_schema: schemaKeysOverride?.input
          ? {
              properties: Object.fromEntries(
                schemaKeysOverride.input.map((k) => [k, {}]),
              ),
            }
          : { properties: { messages: {}, tools: {} } },
        output_schema: schemaKeysOverride?.output
          ? {
              properties: Object.fromEntries(
                schemaKeysOverride.output.map((k) => [k, {}]),
              ),
            }
          : { properties: { messages: {}, tools: {} } },
        ...(schemaKeysOverride?.context
          ? {
              context_schema: {
                properties: Object.fromEntries(
                  schemaKeysOverride.context.map((k) => [k, {}]),
                ),
              },
            }
          : {}),
      }),
    },
    runs: {
      stream: vi
        .fn()
        .mockImplementation(
          (_threadId: string, _assistantId: string, payload: any) => {
            capturedPayload.value = payload;
            // Return an async iterable that yields nothing (stream is not tested here)
            return {
              [Symbol.asyncIterator]() {
                return { next: async () => ({ done: true, value: undefined }) };
              },
            };
          },
        ),
    },
  };

  // Mock subscriber
  const events: any[] = [];
  (agent as any).subscriber = {
    next: (e: any) => events.push(e),
    error: vi.fn(),
    complete: vi.fn(),
    closed: false,
  };

  return { agent, capturedPayload, events };
}

/**
 * Helper to run prepareStream on a mocked agent and return the captured payload.
 */
async function runPrepareStream(
  agent: LangGraphAgent,
  inputOverrides: Record<string, any> = {},
) {
  const defaultInput = {
    runId: "run-1",
    threadId: "thread-1",
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
    ...inputOverrides,
  };

  return agent.prepareStream(defaultInput as any, [
    "events",
    "values",
    "updates",
    "messages-tuple",
  ]);
}

async function runPrepareRegenerateStream(
  agent: LangGraphAgent,
  forwardedConfig: Record<string, unknown>,
) {
  (agent as any).assistant = MOCK_ASSISTANT;
  (agent as any).getCheckpointByMessage = vi.fn().mockResolvedValue({
    values: { messages: [] },
    checkpoint: { checkpoint_id: "checkpoint-1" },
    next: [],
  });
  (agent as any).client.threads.updateState.mockResolvedValue({
    checkpoint: { checkpoint_id: "fork-1" },
  });

  return agent.prepareRegenerateStream(
    {
      threadId: "thread-1",
      messageCheckpoint: { id: "message-1", type: "human", content: "hi" },
      forwardedProps: { config: forwardedConfig },
    } as any,
    ["values"],
  );
}

describe("prepareRegenerateStream payload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves context-schema values when regenerating", async () => {
    const { agent, capturedPayload } = buildMockedAgent();
    (agent as any).activeRun.schemaKeys = {
      config: ["model"],
      context: ["model"],
    };

    await runPrepareRegenerateStream(agent, {
      configurable: { model: "gpt-5" },
    });

    expect(capturedPayload.value?.context).toEqual({ model: "gpt-5" });
  });

  it("warns when mixed configurable keys are dropped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent, capturedPayload } = buildMockedAgent();
    (agent as any).activeRun.schemaKeys = {
      config: ["model", "thread_scoped"],
      context: ["model"],
    };

    await runPrepareRegenerateStream(agent, {
      configurable: { model: "gpt-5", thread_scoped: "value" },
    });

    expect(capturedPayload.value?.context).toEqual({ model: "gpt-5" });
    expect(
      (capturedPayload.value?.config as any)?.configurable,
    ).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("thread_scoped"),
    );
  });

  it("preserves forwarded x-* headers after context partitioning", async () => {
    const { agent, capturedPayload } = buildMockedAgent();
    agent.headers = {
      "X-Trace-Id": "trace-1",
      Authorization: "Bearer secret",
    };
    (agent as any).activeRun.schemaKeys = {
      config: ["model"],
      context: ["model"],
    };

    await runPrepareRegenerateStream(agent, {
      configurable: { model: "gpt-5" },
    });

    expect((capturedPayload.value?.config as any)?.configurable).toEqual({
      copilotkit_forwarded_headers: { "X-Trace-Id": "trace-1" },
    });
    expect(
      (capturedPayload.value?.config as any)?.configurable,
    ).not.toHaveProperty("model");
  });
});

// ─── Part A: prepareStream payload shape ─────────────────────────────────────

describe("prepareStream payload partitioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test 1: configurable-only payload when no context_schema keys match", async () => {
    // No context_schema declared — all configurable stays in config.configurable
    const { agent, capturedPayload } = buildMockedAgent(
      {
        assistantConfig: {
          configurable: { thread_scoped: "val1", app_key: "val2" },
        },
      },
      { config: ["thread_scoped", "app_key"], context: [] },
    );

    await runPrepareStream(agent, {
      context: [{ description: "foo", value: "bar" }],
    });

    const payload = capturedPayload.value!;
    // ag-ui context array must NOT leak into payload-level context
    expect(payload).not.toHaveProperty("context");
    // configurable should be preserved
    expect(payload.config).toBeDefined();
    expect((payload.config as any).configurable).toBeDefined();
    expect((payload.config as any).configurable.thread_scoped).toBe("val1");
    expect((payload.config as any).configurable.app_key).toBe("val2");
  });

  it("test 2: context-only payload when context_schema keys exist", async () => {
    const { agent, capturedPayload } = buildMockedAgent(
      {
        assistantConfig: {
          configurable: { my_app_key: "val", thread_scoped: "other" },
        },
      },
      { config: ["thread_scoped", "my_app_key"], context: ["my_app_key"] },
    );

    await runPrepareStream(agent);

    const payload = capturedPayload.value!;
    // context should contain the context_schema key
    expect(payload.context).toEqual({ my_app_key: "val" });
    // configurable should be absent (stripped because context wins)
    expect((payload.config as any)?.configurable).toBeUndefined();
  });

  it("test 3: context-wins data-loss scenario with warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { agent, capturedPayload } = buildMockedAgent(
      {
        assistantConfig: {
          configurable: { my_app_key: "val", thread_scoped: "other" },
        },
      },
      { config: ["thread_scoped", "my_app_key"], context: ["my_app_key"] },
    );

    await runPrepareStream(agent);

    const payload = capturedPayload.value!;
    // (a) context equals only the context_schema key
    expect(payload.context).toEqual({ my_app_key: "val" });
    // (b) configurable absent from payload
    expect((payload.config as any)?.configurable).toBeUndefined();
    // (c) console.warn was called with dropped key name
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("thread_scoped"),
    );
    // (d) warning prefix appears
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[@ag-ui/langgraph]"),
    );
  });

  it("test 4: no double-population (no key in both configurable and context)", async () => {
    const { agent, capturedPayload } = buildMockedAgent(
      {
        assistantConfig: {
          configurable: { ctx_key: "a", cfg_key: "b" },
        },
      },
      { config: ["ctx_key", "cfg_key"], context: ["ctx_key"] },
    );

    await runPrepareStream(agent);

    const payload = capturedPayload.value!;
    const contextKeys = payload.context
      ? Object.keys(payload.context as object)
      : [];
    const configurableKeys = (payload.config as any)?.configurable
      ? Object.keys((payload.config as any).configurable)
      : [];

    // No key should appear in both
    const overlap = contextKeys.filter((k) => configurableKeys.includes(k));
    expect(overlap).toHaveLength(0);
  });

  it("test 5: warning logged when non-context_schema configurable keys are dropped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { agent } = buildMockedAgent(
      {
        assistantConfig: {
          configurable: { ctx_key: "a", orphan_key: "b" },
        },
      },
      { config: ["ctx_key", "orphan_key"], context: ["ctx_key"] },
    );

    await runPrepareStream(agent);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("orphan_key"));
  });

  it("test 6: RunAgentInput.context array is NOT spread into payload context", async () => {
    const { agent, capturedPayload } = buildMockedAgent(
      {},
      { config: [], context: [] },
    );

    await runPrepareStream(agent, {
      context: [{ description: "foo", value: "bar" }],
    });

    const payload = capturedPayload.value!;
    // No context_schema keys match, so context should be absent
    expect(payload).not.toHaveProperty("context");
    // Verify the ag-ui array did NOT produce {0: {...}} in the payload
    expect(payload.context).toBeUndefined();
  });

  it("test 7: mergeConfigs preserves context_schema keys in allowlist", async () => {
    const { agent } = buildMockedAgent(
      {},
      { config: ["config_key"], context: ["ctx_key"] },
    );

    // Pre-populate assistant so mergeConfigs can run
    (agent as any).assistant = MOCK_ASSISTANT;

    const schemaKeys = {
      config: ["config_key"],
      context: ["ctx_key"],
      input: null,
      output: null,
    };

    const result = await (agent as any).mergeConfigs({
      configs: [
        {
          configurable: { config_key: "a", ctx_key: "b", unknown_key: "c" },
        },
      ],
      assistant: MOCK_ASSISTANT,
      schemaKeys,
    });

    expect(result.configurable).toHaveProperty("config_key", "a");
    expect(result.configurable).toHaveProperty("ctx_key", "b");
    expect(result.configurable).not.toHaveProperty("unknown_key");
  });
});

// ─── Part B: header forwarding ───────────────────────────────────────────────
//
// The LangGraphClient stores onRequest as a `protected` property on BaseClient.
// At runtime it's a regular JS property, but the Client class is a wrapper that
// creates sub-clients (runs, threads, etc.) as separate objects. We test header
// forwarding by intercepting global fetch, since onRequest runs inside fetch calls.
//

describe("header forwarding via onRequest hook", () => {
  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("test 8: default headerFactory reads agent.headers", async () => {
    const agent = new LangGraphAgent({
      graphId: "test-graph",
      deploymentUrl: "http://localhost:8000",
    });

    agent.headers = { "X-Test": "123" };

    // Trigger a real fetch through the client (assistants.search is simplest)
    try {
      await agent.client.assistants.search({ graphId: "test-graph" });
    } catch {
      // May fail due to mock response shape, that's fine
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, fetchInit] = fetchSpy.mock.calls[0];
    const headers = fetchInit!.headers;
    expect(headers).toHaveProperty("X-Test", "123");
  });

  it("test 9: custom headerFactory overrides default", async () => {
    const agent = new LangGraphAgent({
      graphId: "test-graph",
      deploymentUrl: "http://localhost:8000",
      headerFactory: () => ({ "X-Custom": "abc" }),
    });

    // Set agent.headers — should be ignored because custom factory overrides
    agent.headers = { "X-Ignored": "nope" };

    try {
      await agent.client.assistants.search({ graphId: "test-graph" });
    } catch {
      // May fail due to mock response shape
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, fetchInit] = fetchSpy.mock.calls[0];
    const headers = fetchInit!.headers;
    expect(headers).toHaveProperty("X-Custom", "abc");
    expect(headers).not.toHaveProperty("X-Ignored");
  });

  it("test 10: clone() creates independent header context (concurrent isolation)", async () => {
    const agent = new LangGraphAgent({
      graphId: "test-graph",
      deploymentUrl: "http://localhost:8000",
    });

    const cloned = agent.clone() as LangGraphAgent;

    // Set DIFFERENT headers on each at the same time
    agent.headers = { "X-Source": "original" };
    cloned.headers = { "X-Source": "cloned" };

    // Fire both requests; do NOT clear mock between — proves concurrent isolation
    try {
      await agent.client.assistants.search({ graphId: "test-graph" });
    } catch {
      // May fail due to mock response shape
    }
    try {
      await cloned.client.assistants.search({ graphId: "test-graph" });
    } catch {
      // May fail due to mock response shape
    }

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // First call carries original headers
    const [, origInit] = fetchSpy.mock.calls[0];
    expect(origInit!.headers).toHaveProperty("X-Source", "original");
    // Second call carries clone headers
    const [, cloneInit] = fetchSpy.mock.calls[1];
    expect(cloneInit!.headers).toHaveProperty("X-Source", "cloned");
  });

  it("test 11: propertyHeaders and dynamic headers coexist", async () => {
    const agent = new LangGraphAgent({
      graphId: "test-graph",
      deploymentUrl: "http://localhost:8000",
      propertyHeaders: { "X-Static": "s" },
    });
    agent.headers = { "X-Dynamic": "d" };

    try {
      await agent.client.assistants.search({ graphId: "test-graph" });
    } catch {
      // May fail due to mock response shape
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, fetchInit] = fetchSpy.mock.calls[0];
    const headers = fetchInit!.headers;
    // The SDK's mergeHeaders lowercases header names (uses `new Headers()` internally).
    // propertyHeaders go through mergeHeaders → lowercase. Dynamic headers from onRequest
    // keep their original casing since they are spread directly.
    expect(headers).toHaveProperty("x-static", "s");
    expect(headers).toHaveProperty("X-Dynamic", "d");
  });

  it("test 12: empty headers produce no extra headers (no-op)", async () => {
    const agent = new LangGraphAgent({
      graphId: "test-graph",
      deploymentUrl: "http://localhost:8000",
    });
    // headers is default {} — empty

    try {
      await agent.client.assistants.search({ graphId: "test-graph" });
    } catch {
      // May fail due to mock response shape
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, fetchInit] = fetchSpy.mock.calls[0];
    const headers = fetchInit!.headers as Record<string, string>;
    // Should NOT have any extra X- headers from our hook
    const xHeaders = Object.keys(headers).filter((k) => k.startsWith("X-"));
    expect(xHeaders).toHaveLength(0);
  });
});

// ─── Part C: forwarded-headers payload injection ─────────────────────────────
//
// CopilotKit Runtime writes per-request x-* headers (correlation IDs, x-aimock-context,
// etc.) onto `agent.headers`. The Python LangGraph middleware reads them out of
// payload.config.configurable.copilotkit_forwarded_headers (see
// _extract_forwarded_headers_from_config in copilotkit_lg_middleware.py). The TS
// adapter must serialize agent.headers into that exact path or downstream
// extraction returns {}.
//

describe("forwarded headers injected into payload.config.configurable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test 15: x-* headers from agent.headers land in config.configurable.copilotkit_forwarded_headers", async () => {
    const { agent, capturedPayload } = buildMockedAgent();
    agent.headers = {
      "x-aimock-context": "langgraph-typescript",
      "x-correlation-id": "abc-123",
      "x-request-id": "req-xyz",
    };

    await runPrepareStream(agent);

    const payload = capturedPayload.value!;
    expect(payload.config).toBeDefined();
    const configurable = (payload.config as any)?.configurable;
    expect(configurable).toBeDefined();
    expect(configurable.copilotkit_forwarded_headers).toEqual({
      "x-aimock-context": "langgraph-typescript",
      "x-correlation-id": "abc-123",
      "x-request-id": "req-xyz",
    });
  });

  it("test 16: non-x-* headers are filtered out of copilotkit_forwarded_headers", async () => {
    const { agent, capturedPayload } = buildMockedAgent();
    agent.headers = {
      "x-aimock-context": "langgraph-typescript",
      authorization: "Bearer secret",
      "content-type": "application/json",
    };

    await runPrepareStream(agent);

    const payload = capturedPayload.value!;
    const forwarded = (payload.config as any)?.configurable
      ?.copilotkit_forwarded_headers;
    expect(forwarded).toEqual({
      "x-aimock-context": "langgraph-typescript",
    });
    expect(forwarded).not.toHaveProperty("authorization");
    expect(forwarded).not.toHaveProperty("content-type");
  });

  it("test 17: empty agent.headers does not add copilotkit_forwarded_headers", async () => {
    const { agent, capturedPayload } = buildMockedAgent();
    agent.headers = {};

    await runPrepareStream(agent);

    const payload = capturedPayload.value!;
    const configurable = (payload.config as any)?.configurable;
    if (configurable) {
      expect(configurable).not.toHaveProperty("copilotkit_forwarded_headers");
    }
  });

  it("test 18: forwarded headers survive context-wins path (configurable stripped)", async () => {
    // Scenario: context_schema present and assistantConfig populates a context
    // key. The partition strips configurable in favor of context. The forwarded
    // headers MUST still ride along — they are infrastructure metadata, not
    // graph-context, and the Python middleware reads them from config.configurable.
    const { agent, capturedPayload } = buildMockedAgent(
      {
        assistantConfig: {
          configurable: { my_app_key: "val" },
        },
      },
      { config: ["my_app_key"], context: ["my_app_key"] },
    );
    agent.headers = {
      "x-aimock-context": "langgraph-typescript",
    };

    // Silence the data-loss warning that fires when context wins
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await runPrepareStream(agent);

    const payload = capturedPayload.value!;
    expect(payload.context).toEqual({ my_app_key: "val" });
    // configurable should still exist solely to carry forwarded headers
    const configurable = (payload.config as any)?.configurable;
    expect(configurable).toBeDefined();
    expect(configurable.copilotkit_forwarded_headers).toEqual({
      "x-aimock-context": "langgraph-typescript",
    });
    // The graph-context key must NOT leak back into configurable
    expect(configurable).not.toHaveProperty("my_app_key");
  });
});

// ─── Integration tests (skipped without LANGGRAPH_API_URL) ───────────────────

describe("langGraphDefaultMergeState forwards props into ag-ui state", () => {
  // Forwarded props that must surface into ag-ui state, keyed by the
  // forwardedProps key mapped to [ag-ui state key, sample value]. To wire a new
  // forwarded prop into ag-ui state, add it here AND in
  // langGraphDefaultMergeState — both assertions below then cover it.
  const FORWARDED_PROPS_TO_AGUI: Record<string, [string, unknown]> = {
    injectA2UITool: ["inject_a2ui_tool", "render_a2ui"],
  };

  function mergeWith(forwardedProps: Record<string, unknown>) {
    const { agent } = buildMockedAgent();
    const input = {
      threadId: "t1",
      runId: "r1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps,
    } as any;
    return (agent as any).langGraphDefaultMergeState({ messages: [] }, [], input);
  }

  it("surfaces each configured forwarded prop under its ag-ui state key", () => {
    const forwarded = Object.fromEntries(
      Object.entries(FORWARDED_PROPS_TO_AGUI).map(([fp, [, sample]]) => [fp, sample]),
    );
    const result = mergeWith(forwarded);
    for (const [aguiKey, sample] of Object.values(FORWARDED_PROPS_TO_AGUI)) {
      expect(result["ag-ui"][aguiKey]).toEqual(sample);
    }
  });

  it("omits the ag-ui keys when no forwarded props are present", () => {
    const result = mergeWith({});
    for (const [aguiKey] of Object.values(FORWARDED_PROPS_TO_AGUI)) {
      expect(result["ag-ui"]).not.toHaveProperty(aguiKey);
    }
  });
});

describe("integration tests (require LANGGRAPH_API_URL)", () => {
  it.todo(
    "test 13: successful stream against langgraph-api >= 0.7.x — integration test (gated on LANGGRAPH_API_URL)",
  );

  it.todo(
    "test 14: headers arrive at the langgraph-api server — integration test (gated on LANGGRAPH_API_URL)",
  );
});

// ─── Part D: interrupt finish + input.resume protocol tests ──────────────────

describe("dispatchInterruptFinish produces correct AG-UI protocol events", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits RUN_FINISHED with outcome.type=interrupt when emitInterruptOutcome is enabled", () => {
    const { agent, events } = buildMockedAgent({ emitInterruptOutcome: true });

    (agent as any).dispatchInterruptFinish({
      threadId: "t1",
      runId: "run-1",
      lgInterrupts: [{ value: { reason: "confirm" }, id: "int-1" }],
    });

    const finished = events.find(
      (e: any) => e.type === "RUN_FINISHED",
    );
    expect(finished).toBeDefined();
    expect(finished.outcome.type).toBe("interrupt");
    expect(finished.outcome.interrupts).toHaveLength(1);
    expect(finished.outcome.interrupts[0].id).toBe("int-1");
    expect(finished.outcome.interrupts[0].reason).toBe("confirm");
  });

  it("by default emits a plain RUN_FINISHED with NO outcome (legacy-client safe)", () => {
    const { agent, events } = buildMockedAgent();

    (agent as any).dispatchInterruptFinish({
      threadId: "t1",
      runId: "run-1",
      lgInterrupts: [{ value: { reason: "confirm" }, id: "int-1" }],
    });

    const finished = events.find((e: any) => e.type === "RUN_FINISHED");
    expect(finished).toBeDefined();
    expect(finished.outcome).toBeUndefined();
    // The interrupt is still surfaced via the legacy on_interrupt event.
    const customEvents = events.filter(
      (e: any) => e.type === "CUSTOM" && e.name === "on_interrupt",
    );
    expect(customEvents).toHaveLength(1);
  });

  it("emits legacy CustomEvent(on_interrupt) by default", () => {
    const { agent, events } = buildMockedAgent();

    (agent as any).dispatchInterruptFinish({
      threadId: "t1",
      runId: "run-1",
      lgInterrupts: [{ value: "confirm?", id: "int-1" }],
    });

    const customEvents = events.filter(
      (e: any) => e.type === "CUSTOM" && e.name === "on_interrupt",
    );
    expect(customEvents).toHaveLength(1);
  });

  it("suppresses CustomEvent(on_interrupt) when enableLegacyOnInterruptEvent=false", () => {
    const { agent, events } = buildMockedAgent({
      enableLegacyOnInterruptEvent: false,
      emitInterruptOutcome: true,
    });

    (agent as any).dispatchInterruptFinish({
      threadId: "t1",
      runId: "run-1",
      lgInterrupts: [{ value: "confirm?", id: "int-1" }],
    });

    const customEvents = events.filter(
      (e: any) => e.type === "CUSTOM" && e.name === "on_interrupt",
    );
    expect(customEvents).toHaveLength(0);

    const finished = events.find(
      (e: any) => e.type === "RUN_FINISHED",
    );
    expect(finished.outcome.type).toBe("interrupt");
  });

  it("still emits RUN_FINISHED(outcome=interrupt) even with legacy off", () => {
    const { agent, events } = buildMockedAgent({
      enableLegacyOnInterruptEvent: false,
      emitInterruptOutcome: true,
    });

    (agent as any).dispatchInterruptFinish({
      threadId: "t1",
      runId: "run-1",
      lgInterrupts: [{ value: { reason: "r" }, id: "int-1" }],
    });

    const finished = events.find(
      (e: any) => e.type === "RUN_FINISHED",
    );
    expect(finished.outcome.type).toBe("interrupt");
    expect(finished.outcome.interrupts).toHaveLength(1);
  });

  it("forces the outcome when legacy is off even if emitInterruptOutcome is false (no silent swallow)", () => {
    // Both signals off would otherwise drop the interrupt entirely: no
    // on_interrupt, no outcome. The outcome must be forced on so the interrupt
    // is still surfaced.
    const { agent, events } = buildMockedAgent({
      enableLegacyOnInterruptEvent: false,
      // emitInterruptOutcome defaults false
    });

    (agent as any).dispatchInterruptFinish({
      threadId: "t1",
      runId: "run-1",
      lgInterrupts: [{ value: { reason: "r" }, id: "int-1" }],
    });

    const customEvents = events.filter(
      (e: any) => e.type === "CUSTOM" && e.name === "on_interrupt",
    );
    expect(customEvents).toHaveLength(0);

    const finished = events.find((e: any) => e.type === "RUN_FINISHED");
    expect(finished.outcome?.type).toBe("interrupt");
    expect(finished.outcome.interrupts).toHaveLength(1);
  });
});

describe("getCapabilities returns humanInTheLoop", () => {
  it("returns interrupts: true and approveWithEdits: true", async () => {
    const { agent } = buildMockedAgent();
    const caps = await agent.getCapabilities();
    expect(caps.humanInTheLoop).toBeDefined();
    expect(caps.humanInTheLoop!.supported).toBe(true);
    expect(caps.humanInTheLoop!.interrupts).toBe(true);
    expect(caps.humanInTheLoop!.approveWithEdits).toBe(true);
  });
});

describe("prepareStream input.resume protocol", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("input.resume takes precedence over forwardedProps.command.resume with warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { agent, capturedPayload } = buildMockedAgent();

    const input = {
      runId: "run-1",
      threadId: "thread-1",
      messages: [],
      tools: [],
      context: [],
      forwardedProps: { command: { resume: "legacy_value" } },
      resume: [{ interruptId: "i1", status: "resolved", payload: { new: true } }],
    };

    (agent as any).client.threads.getState = vi.fn().mockResolvedValue({
      values: { messages: [] },
      tasks: [{ interrupts: [{ value: { reason: "r" }, id: "int-1" }] }],
    });

    await agent.prepareStream(input as any, [
      "events",
      "values",
      "updates",
      "messages-tuple",
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("both input.resume and forwardedProps.command.resume"),
    );

    const payload = capturedPayload.value!;
    expect(payload.command).toBeDefined();
    expect((payload.command as any).resume).toEqual({ new: true });
  });

  it("forwardedProps.command.resume alone produces deprecation warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { agent, capturedPayload } = buildMockedAgent();

    const input = {
      runId: "run-1",
      threadId: "thread-1",
      messages: [],
      tools: [],
      context: [],
      forwardedProps: { command: { resume: "yes" } },
    };

    (agent as any).client.threads.getState = vi.fn().mockResolvedValue({
      values: { messages: [] },
      tasks: [],
    });

    await agent.prepareStream(input as any, [
      "events",
      "values",
      "updates",
      "messages-tuple",
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("forwardedProps.command.resume is deprecated"),
    );
  });

  it("input.resume with single resolved entry produces payload verbatim in command.resume", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { agent, capturedPayload } = buildMockedAgent();

    const input = {
      runId: "run-1",
      threadId: "thread-1",
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
      resume: [{ interruptId: "i1", status: "resolved", payload: { approved: true } }],
    };

    (agent as any).client.threads.getState = vi.fn().mockResolvedValue({
      values: { messages: [] },
      tasks: [{ interrupts: [{ value: { reason: "r" }, id: "int-1" }] }],
    });

    await agent.prepareStream(input as any, [
      "events",
      "values",
      "updates",
      "messages-tuple",
    ]);

    const payload = capturedPayload.value!;
    expect((payload.command as any).resume).toEqual({ approved: true });
  });

  it("input.resume with single cancelled entry produces sentinel in command.resume", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { agent, capturedPayload } = buildMockedAgent();

    const input = {
      runId: "run-1",
      threadId: "thread-1",
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
      resume: [{ interruptId: "i1", status: "cancelled" }],
    };

    (agent as any).client.threads.getState = vi.fn().mockResolvedValue({
      values: { messages: [] },
      tasks: [{ interrupts: [{ value: { reason: "r" }, id: "int-1" }] }],
    });

    await agent.prepareStream(input as any, [
      "events",
      "values",
      "updates",
      "messages-tuple",
    ]);

    const payload = capturedPayload.value!;
    const resume = (payload.command as any).resume as Record<string, unknown>;
    expect(resume.__agui_cancelled__).toBe(true);
    expect(resume.interrupt_id).toBe("i1");
  });

  it("interrupt short-circuit with hasResume=false dispatches RUN_FINISHED(outcome=interrupt)", async () => {
    const { agent, events } = buildMockedAgent({ emitInterruptOutcome: true });

    const input = {
      runId: "run-1",
      threadId: "thread-1",
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    };

    (agent as any).client.threads.getState = vi.fn().mockResolvedValue({
      values: { messages: [] },
      tasks: [{ interrupts: [{ value: { reason: "confirm" }, id: "int-1" }] }],
    });

    await agent.prepareStream(input as any, [
      "events",
      "values",
      "updates",
      "messages-tuple",
    ]);

    const finished = events.find(
      (e: any) => e.type === "RUN_FINISHED",
    );
    expect(finished).toBeDefined();
    expect(finished.outcome.type).toBe("interrupt");
    expect(finished.outcome.interrupts).toHaveLength(1);
    expect(finished.outcome.interrupts[0].id).toBe("int-1");
    expect(finished.outcome.interrupts[0].reason).toBe("confirm");
  });
});
