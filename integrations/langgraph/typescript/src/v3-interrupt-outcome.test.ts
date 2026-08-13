/**
 * Findings 6 & 7 — v3 run-end interrupt handling.
 *
 * Finding 6: the v3 handler's run-end interrupt must route through
 * dispatchInterruptFinish (like v2) so the interrupt-outcome contract
 * (emitInterruptOutcome / enableLegacyOnInterruptEvent) is honored on v3 —
 * previously it emitted a plain RUN_FINISHED with no structured outcome.
 *
 * Finding 7: in transformer mode the compiled-in transformer already
 * surfaces the interrupt as a CUSTOM OnInterrupt (tasks→OnInterrupt); the
 * post-run path must NOT emit it a second time.
 */

import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

const INTERRUPT = { id: "int-1", value: "approve?" };

const STATE_WITH_INTERRUPT = {
  values: { messages: [] },
  tasks: [{ interrupts: [INTERRUPT] }],
  next: ["node"],
  metadata: { writes: {} },
};

function makeConfig(overrides: Partial<LangGraphAgentConfig> = {}): LangGraphAgentConfig {
  return {
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
    client: {
      threads: { getState: vi.fn().mockResolvedValue(STATE_WITH_INTERRUPT) },
      runs: { cancel: vi.fn() },
    } as any,
    ...overrides,
  };
}

function makeChunk(method: string, data: any) {
  return { type: "event", seq: 0, method, params: { namespace: [], timestamp: 0, data } };
}

async function* makeStream(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

async function runV3(chunks: any[], configOverrides: Partial<LangGraphAgentConfig> = {}) {
  const agent = new LangGraphAgent(makeConfig(configOverrides));
  const dispatched: any[] = [];
  agent.dispatchEvent = (event: any) => {
    dispatched.push(event);
    return true as any;
  };
  (agent as any).activeRun = {
    id: "run1",
    threadId: "thread1",
    nodeName: "chat",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
    textBlockMessageIds: new Map(),
    toolBlocks: new Map(),
    reasoningBlocks: new Map(),
  };
  await (agent as any).handleStreamEventsV3(
    { streamResponse: makeStream(chunks), state: { ...STATE_WITH_INTERRUPT } },
    "thread1",
    { next: (e: any) => dispatched.push(e), error: () => {}, complete: () => {} },
    { runId: "run1", threadId: "thread1", messages: [], state: {}, tools: [], context: [], forwardedProps: { nodeName: "chat" } },
    [],
  );
  return dispatched;
}

const onInterrupts = (d: any[]) =>
  d.filter((e) => e.type === EventType.CUSTOM && e.name === "on_interrupt");
const runFinished = (d: any[]) => d.filter((e) => e.type === EventType.RUN_FINISHED);

// ---------------------------------------------------------------------------
// Finding 6: run-end interrupt honors the outcome contract on v3
// ---------------------------------------------------------------------------

describe("v3 run-end interrupt → dispatchInterruptFinish", () => {
  it("emits the structured RUN_FINISHED.outcome when emitInterruptOutcome is on", async () => {
    const dispatched = await runV3([], { emitInterruptOutcome: true });
    const finished = runFinished(dispatched);
    expect(finished).toHaveLength(1);
    expect((finished[0] as any).outcome).toEqual({
      type: "interrupt",
      interrupts: expect.any(Array),
    });
    // Still exactly one legacy OnInterrupt (default legacy on).
    expect(onInterrupts(dispatched)).toHaveLength(1);
  });

  it("forces the outcome on when the legacy on_interrupt event is disabled", async () => {
    const dispatched = await runV3([], { enableLegacyOnInterruptEvent: false });
    const finished = runFinished(dispatched);
    expect((finished[0] as any).outcome?.type).toBe("interrupt");
    // Legacy channel off → no CUSTOM OnInterrupt.
    expect(onInterrupts(dispatched)).toHaveLength(0);
  });

  it("defaults to a plain RUN_FINISHED (no outcome) with one legacy OnInterrupt", async () => {
    const dispatched = await runV3([]);
    const finished = runFinished(dispatched);
    expect(finished).toHaveLength(1);
    expect((finished[0] as any).outcome).toBeUndefined();
    expect(onInterrupts(dispatched)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Finding 7: transformer mode does not double-render the interrupt
// ---------------------------------------------------------------------------

describe("transformer-mode interrupt (no double render)", () => {
  it("emits the interrupt exactly once when the transformer already surfaced it", async () => {
    const dispatched = await runV3(
      [
        // Transformer passthrough already surfaced the interrupt...
        makeChunk("agui", {
          type: EventType.CUSTOM,
          name: "on_interrupt",
          value: "approve?",
        }),
      ],
      { emitInterruptOutcome: true },
    );
    // ...and the post-run getState scan also sees it — but it must NOT be
    // emitted a second time.
    expect(onInterrupts(dispatched)).toHaveLength(1);
    // RUN_FINISHED still carries the structured outcome (agent owns it).
    expect((runFinished(dispatched)[0] as any).outcome?.type).toBe("interrupt");
  });
});
