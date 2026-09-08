/**
 * The orchestrator path driven by a REAL `Graph` from `@strands-agents/sdk`.
 *
 * The rest of the orchestrator suite scripts a stub that yields node events and
 * throws on demand. A stub is the only way to drive every row of the
 * stop-reason table, but it cannot answer the question that decides what this
 * path owes a client: which of those shapes a real `Graph` can actually
 * produce. So this file builds one. The only thing faked is the `Model`, which
 * is the SDK's own extension point for standing in for a provider; the `Agent`,
 * the `AgentNode` wrapping it and the `Graph` scheduling it are the SDK's.
 *
 * Two facts are pinned here, and they pull in opposite directions:
 *
 *  1. The `AgentStopped` hint IS at parity with the single-agent path. A node
 *     whose terminal `AgentResult` carries an abnormal stop reason puts the
 *     same CUSTOM event on the wire, with Python's spelling, and the run still
 *     finishes.
 *
 *  2. A provider failure inside a node is NOT reported at all. `Node.stream`
 *     (`multiagent/nodes.js`) wraps `handle()` in a try/catch and converts any
 *     throw into a FAILED `NodeResult`, then returns normally, so nothing
 *     reaches the adapter's outer handler. The run finishes with no error. That
 *     is a real gap; it is pinned so that closing it is a visible change rather
 *     than a silent one. See `ARCHITECTURE.md`.
 *
 * What DOES escape a real `Graph` is an orchestration budget violation, which
 * is not a model stop reason and is reported as `STRANDS_ERROR`.
 */

import { describe, it, expect, vi } from "vitest";
import {
  Agent,
  Graph,
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  type ModelStreamEvent,
  type StopReason,
} from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";
import type { BaseEvent } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect } from "./helpers";

type CustomEvent = { type: string; name?: string; value?: unknown };
type RunError = { type: string; code?: string; message?: string };

/**
 * A `Model` that answers with one text block and the stop reason it was built
 * with.
 *
 * Subclassing the abstract `Model` is the SDK's supported way to stand in for a
 * provider, and it is the lowest layer this file fakes: everything between here
 * and the adapter is real. `stopReason` is widened because `StopReason` is a
 * union in the type system but a plain string at runtime, which is exactly why
 * the adapter's lookup table is keyed defensively.
 */
class StopReasonModel extends Model {
  constructor(private readonly stopReason: string) {
    super();
  }

  getConfig() {
    return { modelId: "real-graph-test" };
  }

  updateConfig() {}

  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield new ModelMessageStartEvent({
      type: "modelMessageStartEvent",
      role: "assistant",
    });
    yield new ModelContentBlockDeltaEvent({
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: "short answer" },
    });
    yield new ModelContentBlockStopEvent({
      type: "modelContentBlockStopEvent",
    });
    yield new ModelMessageStopEvent({
      type: "modelMessageStopEvent",
      stopReason: this.stopReason as StopReason,
    });
  }
}

/**
 * A `Model` whose call fails, standing in for a provider outage.
 *
 * A plain `Error` rather than `ModelThrottledError`: the SDK retries a throttle
 * with backoff, which would make the test wait on a real timer to observe a
 * failure that arrives identically either way.
 */
class FailingModel extends Model {
  getConfig() {
    return { modelId: "real-graph-test" };
  }

  updateConfig() {}

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<ModelStreamEvent> {
    throw new Error("provider exploded");
  }
}

/** A real `Graph` with one real `Agent` node, wrapped by the adapter. */
function realGraphAgent(model: Model): StrandsAgent {
  const node = new Agent({ id: "writer", model, printer: false });
  const graph = new Graph({ nodes: [node], edges: [] });
  return new StrandsAgent({
    // `Graph` is not an `Agent`; the adapter discriminates the two structurally
    // (a Graph has no `.model`) and the option type spells the narrower one.
    agent: graph as never,
    name: "real-graph",
    // An injected logger, so an expected `warn` for an abnormal stop does not
    // print to the suite's stderr.
    config: { logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } },
  });
}

/**
 * A real two-node `Graph` whose second node cannot run within `maxSteps`.
 *
 * `Graph._checkSteps` throws before scheduling the node that would exceed the
 * budget, and the constructor rejects `maxSteps < 1`, so tripping it takes two
 * nodes and a budget of one.
 */
function budgetExceededGraphAgent(): StrandsAgent {
  const first = new Agent({
    id: "writer",
    model: new StopReasonModel("contentFiltered"),
    printer: false,
  });
  const second = new Agent({
    id: "editor",
    model: new StopReasonModel("endTurn"),
    printer: false,
  });
  const graph = new Graph({
    nodes: [first, second],
    edges: [["writer", "editor"]],
    maxSteps: 1,
  });
  return new StrandsAgent({
    agent: graph as never,
    name: "real-graph",
    config: { logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } },
  });
}

function agentStoppedEvents(events: BaseEvent[]): CustomEvent[] {
  return (events as unknown as CustomEvent[]).filter(
    (e) => e.type === EventType.CUSTOM && e.name === "AgentStopped",
  );
}

/**
 * Position of the `AgentStopped` hint, or -1. Located by name, never by event
 * type: this path also emits `MultiAgentHandoff` as a CUSTOM event, so an index
 * taken from the type alone is satisfied by an unrelated custom event.
 */
function agentStoppedIndex(events: BaseEvent[]): number {
  return (events as unknown as CustomEvent[]).findIndex(
    (e) => e.type === EventType.CUSTOM && e.name === "AgentStopped",
  );
}

function runError(events: BaseEvent[]): RunError | undefined {
  return (events as unknown as RunError[]).find(
    (e) => e.type === EventType.RUN_ERROR,
  );
}

describe("real Graph: the abnormal-stop hint reaches the wire", () => {
  it.each([
    ["contentFiltered", "content_filtered"],
    ["guardrailIntervened", "guardrail_intervened"],
  ])(
    "announces %s from a real node's terminal result",
    async (stopReason, expected) => {
      const events = await collect(
        realGraphAgent(new StopReasonModel(stopReason)),
      );

      expect(agentStoppedEvents(events)).toEqual([
        {
          type: EventType.CUSTOM,
          name: "AgentStopped",
          value: { stop_reason: expected },
        },
      ]);
    },
  );

  it("puts the hint inside the node's own message and step envelopes", async () => {
    // Position, not merely presence: the hint describes the answer the client
    // is reading, so it has to arrive while that message is still open and
    // before the node's step closes. A hint that landed after RUN_FINISHED
    // would satisfy a presence check and tell a client nothing.
    const events = await collect(
      realGraphAgent(new StopReasonModel("contentFiltered")),
    );

    const kinds = events.map((e) => e.type);
    const hintAt = agentStoppedIndex(events);
    const textStartAt = kinds.indexOf(EventType.TEXT_MESSAGE_START);
    const textEndAt = kinds.indexOf(EventType.TEXT_MESSAGE_END);
    const stepFinishedAt = kinds.indexOf(EventType.STEP_FINISHED);
    expect(textStartAt).toBeGreaterThan(-1);
    expect(hintAt).toBeGreaterThan(textStartAt);
    expect(hintAt).toBeLessThan(textEndAt);
    expect(textEndAt).toBeLessThan(stepFinishedAt);
  });

  it("still finishes the run an abnormal node stop happened in", async () => {
    // An abnormal stop is a short answer, not a failed run.
    const events = await collect(
      realGraphAgent(new StopReasonModel("guardrailIntervened")),
    );

    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_ERROR);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("stays silent when a real node stops normally", async () => {
    const events = await collect(
      realGraphAgent(new StopReasonModel("endTurn")),
    );

    expect(agentStoppedEvents(events)).toEqual([]);
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });
});

describe("real Graph: a node's provider failure never reaches the adapter", () => {
  it("reports a failed node as a finished run with no error", async () => {
    // `Node.stream` converts the throw into a FAILED `NodeResult` and returns
    // normally, so the adapter sees a node that opened and closed its step and
    // said nothing. This is the gap; the exact event list is pinned so closing
    // it cannot happen silently.
    const events = await collect(realGraphAgent(new FailingModel()));

    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.STEP_STARTED,
      EventType.STEP_FINISHED,
      EventType.STATE_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
  });

  it("invents no abnormal-stop hint for a node that failed", async () => {
    // The node produced no terminal `AgentResult` at all, so there is no stop
    // reason to report and none may be fabricated from the failure.
    const events = await collect(realGraphAgent(new FailingModel()));

    expect(agentStoppedEvents(events)).toEqual([]);
  });
});

describe("real Graph: an orchestration budget violation is not a forced stop", () => {
  it("reports a maxSteps violation under the stream-error code", async () => {
    // `maxSteps` is one of the few things that DOES throw out of a real
    // `Graph.stream()`. It is the orchestrator's own budget and not something
    // the model decided, so it must not borrow the single-agent path's
    // forced-stop code.
    const events = await collect(budgetExceededGraphAgent());

    expect(runError(events)).toMatchObject({
      code: "STRANDS_ERROR",
      message: expect.stringContaining("max steps reached"),
    });
    const kinds = events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
    expect(kinds).not.toContain(EventType.RUN_FINISHED);
  });

  it("still announces the first node's abnormal stop before that error", async () => {
    // The hint and the terminal error are independent signals, and a run can
    // carry both: the first node was content-filtered, then the budget ran out.
    const events = await collect(budgetExceededGraphAgent());

    const hintAt = agentStoppedIndex(events);
    const errorAt = events.map((e) => e.type).indexOf(EventType.RUN_ERROR);
    expect(agentStoppedEvents(events)).toEqual([
      {
        type: EventType.CUSTOM,
        name: "AgentStopped",
        value: { stop_reason: "content_filtered" },
      },
    ]);
    expect(errorAt).toBeGreaterThan(-1);
    expect(hintAt).toBeLessThan(errorAt);
  });
});
