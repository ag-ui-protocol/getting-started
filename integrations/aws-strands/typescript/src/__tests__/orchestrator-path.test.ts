/**
 * StrandsAgent, when given a multi-agent orchestrator (Graph/Swarm)
 * instead of an Agent, drives `.stream()` and translates the real TS SDK
 * multi-agent event classes into AG-UI STEP_* / MultiAgentHandoff /
 * nested TEXT_MESSAGE events.
 */

import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/core";
import { StrandsAgent } from "../agent";
import { collect } from "./helpers";

/**
 * Fake orchestrator shape: exposes `.stream()` but no `.model` accessor,
 * which is how the adapter's constructor discriminates between an Agent
 * and a Graph/Swarm.
 */
function fakeOrchestrator(events: unknown[]) {
  return {
    id: "test-graph",
    // No `model` field — triggers the orchestrator code path.
    async *stream(_input: string) {
      for (const e of events) yield e;
    },
  };
}

describe("Orchestrator path", () => {
  it("drives a fake Graph through the adapter and emits STEP_* / MultiAgentHandoff", async () => {
    const stream = fakeOrchestrator([
      { type: "beforeNodeCallEvent", nodeId: "researcher" },
      // Inner agent-level text delta wrapped in a node stream update
      {
        type: "nodeStreamUpdateEvent",
        nodeId: "researcher",
        inner: {
          source: "agent",
          event: {
            type: "modelContentBlockDeltaEvent",
            delta: { type: "textDelta", text: "Found it." },
          },
        },
      },
      { type: "afterNodeCallEvent", nodeId: "researcher", nodeType: "agent" },
      {
        type: "multiAgentHandoffEvent",
        source: "researcher",
        targets: ["writer"],
      },
      { type: "beforeNodeCallEvent", nodeId: "writer" },
      {
        type: "nodeStreamUpdateEvent",
        nodeId: "writer",
        inner: {
          source: "agent",
          event: {
            type: "modelContentBlockDeltaEvent",
            delta: { type: "textDelta", text: "Final answer." },
          },
        },
      },
      { type: "afterNodeCallEvent", nodeId: "writer", nodeType: "agent" },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sa = new StrandsAgent({ agent: stream as any, name: "t" });
    const events = await collect(sa);
    const kinds = events.map((e) => e.type);

    // Run lifecycle
    expect(kinds[0]).toBe(EventType.RUN_STARTED);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);

    // Two STEP_STARTED and two STEP_FINISHED
    expect(kinds.filter((k) => k === EventType.STEP_STARTED)).toHaveLength(2);
    expect(kinds.filter((k) => k === EventType.STEP_FINISHED)).toHaveLength(2);

    // One handoff
    const customs = events.filter((e) => e.type === EventType.CUSTOM);
    expect(customs).toHaveLength(1);
    expect((customs[0] as unknown as { name: string }).name).toBe(
      "MultiAgentHandoff",
    );
    expect(
      (customs[0] as unknown as { value: Record<string, unknown> }).value,
    ).toEqual({
      from_nodes: ["researcher"],
      to_nodes: ["writer"],
    });

    // Both nodes streamed text
    const textContent = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("|");
    expect(textContent).toContain("Found it.");
    expect(textContent).toContain("Final answer.");

    // Each node's text envelope closes on afterNodeCallEvent
    expect(
      kinds.filter((k) => k === EventType.TEXT_MESSAGE_START).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      kinds.filter((k) => k === EventType.TEXT_MESSAGE_END).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("orchestrator path is chosen when the agent has no .model accessor", async () => {
    const noModel = fakeOrchestrator([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sa = new StrandsAgent({ agent: noModel as any, name: "t" });
    // If the adapter took the Agent path, it would try to clone the
    // template and fail on the missing model/tools. Orchestrator path
    // skips cloning entirely.
    const events = await collect(sa);
    const kinds = events.map((e) => e.type);
    expect(kinds[0]).toBe(EventType.RUN_STARTED);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
    expect(kinds).not.toContain(EventType.RUN_ERROR);
  });

  it("failed node emits STEP_FINISHED and surfaces no error event", async () => {
    // Py control in /tmp/py-control/test_multiagent_error_parity.py proved
    // the Py adapter does NOT branch on node failure: a node_stop with
    // status=FAILED still yields STEP_FINISHED, no error surfaced. TS
    // matches on the wire. The TS SDK's AfterNodeCallEvent has an optional
    // `error` field that no AG-UI event carries, and the adapter neither
    // translates nor logs it, so a node failure leaves no trace at all.
    // orchestrator-real-graph.test.ts drives the same outcome through a real
    // `Graph` whose node model throws.
    const stream = fakeOrchestrator([
      { type: "beforeNodeCallEvent", nodeId: "flaky" },
      {
        type: "afterNodeCallEvent",
        nodeId: "flaky",
        nodeType: "agent",
        error: new Error("boom from node"),
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sa = new StrandsAgent({ agent: stream as any, name: "t" });
    // No `console.error` spy: the adapter logs nothing for a node failure, so
    // a spy here would silence real error output rather than an expected line.
    const events = await collect(sa);
    const kinds = events.map((e) => e.type);
    expect(kinds.filter((k) => k === EventType.STEP_STARTED)).toHaveLength(1);
    // STEP_FINISHED fires even though the node errored — Py parity.
    expect(kinds.filter((k) => k === EventType.STEP_FINISHED)).toHaveLength(1);
    // No RUN_ERROR surfaced from the node-level failure.
    expect(kinds).not.toContain(EventType.RUN_ERROR);
    // The stream still ends cleanly with RUN_FINISHED.
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("orchestrator STEP_STARTED/FINISHED stepNames match when nodeType is set", async () => {
    // Spec (events.mdx §StepFinished): STEP_FINISHED stepName must match its
    // paired STEP_STARTED. The orchestrator path must honour nodeType on
    // START just like the single-agent path.
    const stream = fakeOrchestrator([
      { type: "beforeNodeCallEvent", nodeId: "writer", nodeType: "multiAgent" },
      { type: "afterNodeCallEvent", nodeId: "writer", nodeType: "multiAgent" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sa = new StrandsAgent({ agent: stream as any, name: "t" });
    const events = await collect(sa);
    const starts = events.filter(
      (e) => e.type === EventType.STEP_STARTED,
    ) as unknown as Array<{ stepName: string }>;
    const stops = events.filter(
      (e) => e.type === EventType.STEP_FINISHED,
    ) as unknown as Array<{ stepName: string }>;
    expect(starts).toHaveLength(1);
    expect(stops).toHaveLength(1);
    expect(starts[0].stepName).toBe("multiAgent:writer");
    expect(starts[0].stepName).toBe(stops[0].stepName);
  });

  it("orchestrator multiAgentHandoffEvent forwards the message field (Py parity)", async () => {
    const stream = fakeOrchestrator([
      {
        type: "multiAgentHandoffEvent",
        source: "a",
        targets: ["b"],
        message: "passing the baton",
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sa = new StrandsAgent({ agent: stream as any, name: "t" });
    const events = await collect(sa);
    const customs = events.filter(
      (e) => e.type === EventType.CUSTOM,
    ) as unknown as Array<{ value: Record<string, unknown> }>;
    expect(customs).toHaveLength(1);
    expect(customs[0].value.message).toBe("passing the baton");
  });

  it("tears down the underlying orchestrator stream when the consumer bails", async () => {
    // The orchestrator interface doesn't accept a cancelSignal (unlike single-
    // agent Agent.stream()), so the only way to stop a long-running
    // orchestrator on client disconnect is to call `.return()` on its
    // iterator. This test pins that teardown behavior.
    let tornDown = false;
    let yieldControl: (() => void) | null = null;
    const orchestrator = {
      id: "test-graph",
      async *stream(_input: string) {
        try {
          // Wrap text in nodeStreamUpdateEvent so the orchestrator path
          // produces a TEXT_MESSAGE_CONTENT we can wait on.
          yield {
            type: "nodeStreamUpdateEvent",
            inner: {
              source: "agent",
              event: {
                type: "modelContentBlockDeltaEvent",
                delta: { type: "textDelta", text: "hi" },
              },
            },
          };
          // Park here until the test signals release; this simulates a
          // long-running orchestrator that hasn't completed when the consumer
          // abandons the iterator.
          await new Promise<void>((resolve) => {
            yieldControl = resolve;
          });
        } finally {
          tornDown = true;
        }
      },
    };

    const agent = new StrandsAgent({
      agent: orchestrator as never,
      name: "t",
    });
    const iter = agent.run({
      threadId: "t",
      runId: "r",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    });
    // Consume events until we see text content (the orchestrator is now
    // parked at the await above).
    for (let i = 0; i < 10; i++) {
      const step = await iter.next();
      if (step.done) break;
      if (
        (step.value as { type: string }).type === EventType.TEXT_MESSAGE_CONTENT
      )
        break;
    }
    // Bail: emulates the SSE writer detecting client disconnect.
    await iter.return?.();
    // Release the parked orchestrator so its finally can run.
    (yieldControl as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(tornDown).toBe(true);
  });

  it("nodeCancelEvent is silently dropped (Py has no handler; TS matches)", async () => {
    // Py's SDK emits `multiagent_node_cancel` when a node is cancelled via
    // BeforeNodeCallEvent.cancel. The Py adapter has no elif branch for
    // this event type — it falls through and crashes in its generic
    // message-dict handler (which mis-types the `message` string). The
    // TS SDK emits `NodeCancelEvent` with a different shape; we match the
    // safer part of Py's intent by silently dropping it.
    const stream = fakeOrchestrator([
      { type: "beforeNodeCallEvent", nodeId: "n1" },
      { type: "nodeCancelEvent", nodeId: "n1", message: "cancelled" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sa = new StrandsAgent({ agent: stream as any, name: "t" });
    const events = await collect(sa);
    const kinds = events.map((e) => e.type);
    // Started fires; cancelled node doesn't emit STEP_FINISHED (no
    // afterNodeCallEvent). No crash, no RUN_ERROR.
    expect(kinds.filter((k) => k === EventType.STEP_STARTED)).toHaveLength(1);
    expect(kinds.filter((k) => k === EventType.STEP_FINISHED)).toHaveLength(0);
    expect(kinds).not.toContain(EventType.RUN_ERROR);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });
});
