import { describe, it, expect, vi, afterEach } from "vitest";
import { LangGraphAgent } from "./agent";
import { EventType } from "@ag-ui/core";
import type { AgentSubscriber } from "@ag-ui/client";

/**
 * End-to-end coverage for the OPT-IN structured-interrupt path
 * (`emitInterruptOutcome: true`).
 *
 * The dojo e2e suites run the langgraph agents with the DEFAULT config
 * (`emitInterruptOutcome` off), so only the legacy `on_interrupt` + plain
 * `RUN_FINISHED` channel is exercised against a browser. The canonical
 * `RUN_FINISHED.outcome={type:"interrupt"}` emission and the
 * `RunAgentInput.resume[]`-driven resume are covered only by unit tests that
 * poke individual functions, and `legacy-resume-lifecycle.test.ts` only drives
 * the deprecated `forwardedProps.command.resume` channel.
 *
 * Released CopilotKit (`@copilotkit/*` 1.60.1 in the dojo) resumes via the
 * legacy channel and breaks on the structured outcome, so a real browser e2e of
 * the canonical path is not feasible with that client. Instead this test drives
 * the real `LangGraphAgent` against a mocked langgraph platform through the
 * public `runAgent()` API and asserts the full two-run round-trip:
 *
 *   run 1 (no resume)  -> RUN_FINISHED carries outcome={type:"interrupt"},
 *                         AbstractAgent records pendingInterrupts.
 *   run 2 (resume[])   -> the canonical ResumeEntry is translated into the
 *                         graph's Command(resume=...), pendingInterrupts clear,
 *                         and the run completes (RUN_FINISHED, no interrupt
 *                         outcome).
 *
 * This FAILS if the opt-in emission regresses (run 1 outcome assertion) or if
 * the `resume[]` translation regresses (run 2 command.resume assertion).
 */
function buildPlatformAgent() {
  const capturedPayload: { value: Record<string, unknown> | null } = {
    value: null,
  };

  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
    // Opt in to the canonical structured outcome. Without this the integration
    // emits a plain RUN_FINISHED and never records pendingInterrupts, so the
    // resume[] guard would have nothing to satisfy.
    emitInterruptOutcome: true,
  });

  // The platform reports an open interrupt until the graph actually runs with
  // the resume command, at which point the interrupt clears — exactly like a
  // real platform. `runs.stream` flips `streamCalled`; the agent re-reads state
  // after streaming (agent.ts post-stream `getState`) and must then see a clean
  // thread so the resume run completes instead of re-emitting the interrupt.
  const interruptState = {
    values: { messages: [] },
    tasks: [
      {
        interrupts: [
          { value: { reason: "confirm", message: "ok?" }, id: "int-1" },
        ],
      },
    ],
    next: ["process_steps_node"],
    metadata: {},
  };
  const resolvedState = {
    values: { messages: [] },
    tasks: [],
    next: [],
    metadata: {},
  };
  let streamCalled = false;

  (agent as any).client = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      getState: vi
        .fn()
        .mockImplementation(async () =>
          streamCalled ? resolvedState : interruptState,
        ),
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
      stream: vi
        .fn()
        .mockImplementation((_t: string, _a: string, payload: any) => {
          capturedPayload.value = payload;
          streamCalled = true;
          // Resume run streams to completion with no further chunks.
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

/** Capture both the processed run-finished signal and the raw events. */
function captureSubscriber() {
  const runFinished: Array<
    | { outcome: "success" }
    | { outcome: "interrupt"; interruptIds: string[] }
  > = [];
  const rawFinished: any[] = [];
  const subscriber: AgentSubscriber = {
    onRunFinishedEvent: (params) => {
      if (params.outcome === "interrupt") {
        runFinished.push({
          outcome: "interrupt",
          interruptIds: params.interrupts.map((i) => i.id),
        });
      } else {
        runFinished.push({ outcome: "success" });
      }
    },
    onEvent: ({ event }) => {
      if (event.type === EventType.RUN_FINISHED) rawFinished.push(event);
    },
  };
  return { subscriber, runFinished, rawFinished };
}

describe("interrupt outcome + resume[] round-trip (emitInterruptOutcome on)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("run 1 terminates with RUN_FINISHED outcome=interrupt and records pendingInterrupts", async () => {
    const { agent } = buildPlatformAgent();
    const { subscriber, runFinished, rawFinished } = captureSubscriber();

    await agent.runAgent({ runId: "run-1" } as any, subscriber);

    // Processed layer surfaces the structured interrupt outcome.
    expect(runFinished).toEqual([
      { outcome: "interrupt", interruptIds: ["int-1"] },
    ]);
    // Raw RUN_FINISHED carries the canonical outcome shape.
    expect(rawFinished).toHaveLength(1);
    expect(rawFinished[0].outcome).toEqual({
      type: "interrupt",
      interrupts: [
        expect.objectContaining({ id: "int-1", reason: "confirm", message: "ok?" }),
      ],
    });
    // AbstractAgent recorded the pending interrupt for the resume guard.
    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["int-1"]);
  });

  it("run 2 resumes via canonical RunAgentInput.resume[] and completes", async () => {
    const { agent, capturedPayload } = buildPlatformAgent();

    // Run 1: produce the pending interrupt.
    await agent.runAgent({ runId: "run-1" } as any);
    expect(agent.pendingInterrupts.length).toBe(1);

    // Run 2: resolve the interrupt with the canonical resume[] mechanism (NOT
    // the legacy forwardedProps.command.resume channel).
    const { subscriber, runFinished } = captureSubscriber();
    await agent.runAgent(
      {
        runId: "run-2",
        resume: [
          { interruptId: "int-1", status: "resolved", payload: { approved: true } },
        ],
      } as any,
      subscriber,
    );

    // The ResumeEntry was translated to the graph's Command(resume=payload).
    // A single resolved entry forwards the payload verbatim (no sentinel wrap).
    expect((capturedPayload.value as any)?.command?.resume).toEqual({
      approved: true,
    });

    // The resume satisfied the guard and cleared the pending interrupt.
    expect(agent.pendingInterrupts.length).toBe(0);

    // The resume run completes — it does NOT re-emit an interrupt outcome.
    expect(runFinished).toEqual([{ outcome: "success" }]);
  });

  it("a normal (non-resume) follow-up run is rejected while the interrupt is pending", async () => {
    const { agent } = buildPlatformAgent();

    await agent.runAgent({ runId: "run-1" } as any);
    expect(agent.pendingInterrupts.length).toBe(1);

    // No resume[] -> the base lifecycle guard must reject the run rather than
    // silently dropping the pending interrupt.
    await expect(
      agent.runAgent({ runId: "run-2" } as any),
    ).rejects.toThrow(/pending interrupt/i);
  });
});
