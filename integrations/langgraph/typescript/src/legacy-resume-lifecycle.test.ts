import { describe, it, expect, vi, afterEach } from "vitest";
import { LangGraphAgent } from "./agent";
import { LangGraphHttpAgent } from "./index";

/**
 * Regression: legacy clients (e.g. CopilotKit's `useLangGraphInterrupt`) resume
 * a LangGraph interrupt via `forwardedProps.command.resume` and never populate
 * the canonical `RunAgentInput.resume[]`.
 *
 * Once the integration started terminating interrupted runs with
 * `RUN_FINISHED.outcome=interrupt`, `AbstractAgent.apply()` began recording
 * `pendingInterrupts`, and the base `onInitialize()` guard rejected the legacy
 * resume run with "pending interrupt(s) not addressed by resume". That broke
 * every dojo HITL / subgraphs interrupt-resume e2e for the langgraph platform
 * suites. These tests lock in the back-compat bridge.
 */
function buildPlatformAgent() {
  const capturedPayload: { value: Record<string, unknown> | null } = {
    value: null,
  };
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
    // The legacy-resume bridge only matters once interrupted runs terminate with
    // the structured outcome (which records pendingInterrupts). Opt in here.
    emitInterruptOutcome: true,
  });

  const interruptState = {
    values: { messages: [] },
    tasks: [{ interrupts: [{ value: { reason: "confirm" }, id: "int-1" }] }],
    next: ["process_steps_node"],
    metadata: {},
  };

  (agent as any).client = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      getState: vi.fn().mockResolvedValue(interruptState),
      getHistory: vi.fn().mockResolvedValue([]),
      updateState: vi.fn().mockResolvedValue({}),
    },
    assistants: {
      search: vi.fn().mockResolvedValue([
        {
          assistant_id: "asst-1",
          graph_id: "test-graph",
          config: { configurable: {} },
        },
      ]),
      getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getSchemas: vi.fn().mockResolvedValue({
        input_schema: { properties: { messages: {}, tools: {} } },
        output_schema: { properties: { messages: {}, tools: {} } },
      }),
    },
    runs: {
      stream: vi.fn().mockImplementation((_t: string, _a: string, payload: any) => {
        capturedPayload.value = payload;
        return {
          [Symbol.asyncIterator]() {
            return { next: async () => ({ done: true, value: undefined }) };
          },
        };
      }),
    },
  };

  return { agent, capturedPayload };
}

describe("legacy command.resume after interrupt-outcome run", () => {
  afterEach(() => vi.restoreAllMocks());

  it("first run records pendingInterrupts (new structured-interrupt behavior)", async () => {
    const { agent } = buildPlatformAgent();
    await agent.runAgent({ runId: "run-1" } as any);
    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["int-1"]);
  });

  it("legacy resume run is NOT rejected and forwards command.resume to the graph", async () => {
    const { agent, capturedPayload } = buildPlatformAgent();

    // 1st run: pending interrupt -> RUN_FINISHED outcome=interrupt
    await agent.runAgent({ runId: "run-1" } as any);
    expect(agent.pendingInterrupts.length).toBe(1);

    // 2nd run: legacy resume only (no input.resume[]). Must not throw.
    await expect(
      agent.runAgent({
        runId: "run-2",
        forwardedProps: { command: { resume: "user picked: a, b" } },
      } as any),
    ).resolves.toBeDefined();

    // The legacy resume must reach the graph as Command(resume=...).
    expect((capturedPayload.value as any)?.command?.resume).toBe(
      "user picked: a, b",
    );
  });

  it("LangGraphHttpAgent also tolerates legacy resume with pending interrupts", async () => {
    const agent = new LangGraphHttpAgent({ url: "http://localhost:8000" });
    (agent as any).pendingInterrupts = [{ id: "int-1", reason: "confirm" }];

    // onInitialize is invoked by runAgent before run(); call it directly to
    // assert the guard does not throw for a legacy resume.
    await expect(
      (agent as any).onInitialize(
        {
          runId: "run-2",
          threadId: "t1",
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { command: { resume: "yes" } },
        },
        [],
      ),
    ).resolves.not.toThrow();
    expect(agent.pendingInterrupts.length).toBe(0);
  });

  it("still rejects a normal (non-resume) run while interrupts are pending", async () => {
    const agent = new LangGraphHttpAgent({ url: "http://localhost:8000" });
    (agent as any).pendingInterrupts = [{ id: "int-1", reason: "confirm" }];

    await expect(
      (agent as any).onInitialize(
        {
          runId: "run-2",
          threadId: "t1",
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        [],
      ),
    ).rejects.toThrow(/pending interrupt/i);
  });
});
