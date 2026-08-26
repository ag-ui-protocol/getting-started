/**
 * Abnormal stop reasons on the orchestrator path (Graph/Swarm).
 *
 * The orchestrator counterpart of `stop-reasons.test.ts`, for the ONE thing the
 * two paths genuinely share: the `AgentStopped` hint. A node that stops
 * abnormally must announce it the same way a lone `Agent` does, so a client
 * matches one payload rather than one per wiring.
 *
 * The hint arrives differently here. A `Graph` never puts a stop reason on its
 * own terminal `MultiAgentResult`; the per-node stop reason rides an
 * `agentResultEvent` nested inside `nodeStreamUpdateEvent.inner`, because
 * `AgentNode.handle` forwards every event the wrapped `Agent.stream()` yields.
 * Every assertion here pins the wire payload rather than the branch that
 * produced it.
 *
 * Terminal FAILURE is deliberately not shared. `Node.stream`
 * (`multiagent/nodes.js`) turns any throw out of a node into a FAILED
 * `NodeResult` and returns normally, so a provider failure inside a Graph node
 * never reaches the adapter at all; the only exceptions that escape a real
 * `Graph` or `Swarm` are orchestration budget violations, which the outer
 * handler reports as `STRANDS_ERROR`. The scripted stub below therefore throws
 * only budget-shaped failures. `orchestrator-real-graph.test.ts` drives both
 * facts against real SDK objects rather than a stub.
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentResult,
  AgentResultEvent,
  Message,
  TextBlock,
} from "@strands-agents/sdk";
import type { StopReason } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput } from "./helpers";

type RunError = { type: string; code?: string; message?: string };
type CustomEvent = { type: string; name?: string; value?: unknown };

/**
 * Orchestrator stub: exposes `.stream()` but no `.model` accessor, which is how
 * the adapter discriminates a Graph/Swarm from an Agent. Yields `events`, then
 * throws the failure if one was passed.
 *
 * A stub is what lets one script drive every row of the stop-reason table,
 * including provider spellings and inherited object keys a real model would
 * have to be coerced into producing. The failures it is handed are always
 * budget-shaped, because those are the only ones a real orchestrator throws.
 */
function orchestratorThrowingAfter(
  events: unknown[],
  ...failure: [] | [unknown]
) {
  const throws = failure.length > 0;
  const error = failure[0];
  const stub = {
    id: "test-graph",
    async *stream(_input: string) {
      for (const e of events) yield e;
      if (throws) throw error;
    },
  };
  return new StrandsAgent({
    agent: stub as unknown as import("@strands-agents/sdk").Agent,
    name: "orch",
  });
}

/**
 * Orchestrator stub whose stream ends by RETURNING `result`.
 *
 * `Graph.stream()` and `Swarm.stream()` return the aggregate `MultiAgentResult`
 * on `{ done: true }` (`multiagent/graph.js`, `multiagent/swarm.js`), which is
 * where the run's terminal status lives.
 */
function orchestratorReturning(events: unknown[], result: unknown) {
  const stub = {
    id: "test-graph",
    async *stream(_input: string) {
      for (const e of events) yield e;
      return result;
    },
  };
  return new StrandsAgent({
    agent: stub as unknown as import("@strands-agents/sdk").Agent,
    name: "orch",
  });
}

/**
 * An aggregate `MultiAgentResult`, in the shape `multiagent/state.d.ts` gives
 * it. `Graph` and `Swarm` never pass `status` themselves; it is derived from
 * the node results, so a stub states the derived value directly.
 */
function multiAgentResult(
  status: string,
  results: Array<Record<string, unknown>> = [],
  aggregateError?: unknown,
) {
  return {
    type: "multiAgentResult",
    status,
    results,
    content: [],
    duration: 3,
    usage: {},
    ...(aggregateError !== undefined ? { error: aggregateError } : {}),
  };
}

/** One entry of `MultiAgentResult.results`. */
function nodeResult(
  nodeId: string,
  status: string,
  error?: unknown,
): Record<string, unknown> {
  return {
    type: "nodeResult",
    nodeId,
    status,
    duration: 1,
    content: [],
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * A node's `BeforeNodeCallEvent`, carrying the fields the real event carries.
 *
 * Neither `BeforeNodeCallEvent` nor `AfterNodeCallEvent` has a `nodeType`
 * (`@strands-agents/sdk`, `dist/src/multiagent/events.js`): they carry
 * `orchestrator`, `state`, `nodeId`, `invocationState` and, respectively,
 * `cancel` and `error`. `_stepName`'s `nodeType` fallback is therefore the arm
 * production always takes, and a stub that supplied one would pin a step name
 * no real run can emit.
 */
function beforeNodeCall(nodeId: string) {
  return {
    type: "beforeNodeCallEvent",
    orchestrator: { id: "test-graph" },
    state: {},
    nodeId,
    invocationState: { userId: "u-1" },
    cancel: false,
  };
}

/** A node's `AfterNodeCallEvent`, which closes the node's step envelope. */
function afterNodeCall(nodeId: string) {
  return {
    type: "afterNodeCallEvent",
    orchestrator: { id: "test-graph" },
    state: {},
    nodeId,
    invocationState: { userId: "u-1" },
  };
}

/** A node-level text delta, as `AgentNode` wraps it on the orchestrator path. */
function nodeTextDelta(text: string, nodeId = "writer") {
  return {
    type: "nodeStreamUpdateEvent",
    nodeId,
    nodeType: "agentNode",
    inner: {
      source: "agent",
      event: {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text },
      },
    },
  };
}

/**
 * A node's terminal `AgentResultEvent`, as `AgentNode.handle` forwards it:
 * `Agent.stream()` yields the event, and the node wraps every yielded event in
 * a `NodeStreamUpdateEvent` tagged `source: 'agent'`.
 *
 * The inner event is the SDK's own class, so the `result` nesting the adapter
 * reaches through is the SDK's shape rather than this file's opinion of it.
 * `agent` is a `LocalAgent` nothing on this path dereferences, so a stub stands
 * in for one. `stopReason` is widened deliberately: `StopReason` is a union in
 * the type system but `string` at runtime, and the rows below drive provider
 * spellings and inherited object keys the union does not carry.
 */
function nodeAgentResult(stopReason: string, nodeId = "writer") {
  return {
    type: "nodeStreamUpdateEvent",
    nodeId,
    nodeType: "agentNode",
    inner: {
      source: "agent",
      event: new AgentResultEvent({
        agent: { name: nodeId, model: { modelId: "stub-model" } } as never,
        result: new AgentResult({
          stopReason: stopReason as StopReason,
          lastMessage: new Message({
            role: "assistant",
            content: [new TextBlock("done")],
          }),
          invocationState: { userId: "u-1" },
        }),
        invocationState: { userId: "u-1" },
      }),
    },
  };
}

function agentStoppedEvents(events: BaseEvent[]): CustomEvent[] {
  return (events as unknown as CustomEvent[]).filter(
    (e) => e.type === EventType.CUSTOM && e.name === "AgentStopped",
  );
}

/**
 * Position of the `AgentStopped` hint on the wire, or -1 when it never arrived.
 *
 * Located by name, never by event type: this path also emits `MultiAgentHandoff`
 * as a CUSTOM event and the single-agent path emits `PredictState`, so an index
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

/** One captured default-logger line, with the arguments it was handed intact. */
type LogLine = { level: "warn" | "error"; args: unknown[] };

/**
 * Run with the default logger's console sinks captured.
 *
 * `DEFAULT_LOGGER.debug` is a no-op, so a trace that only reaches `debug`
 * produces no line here. That is the point: these tests assert what an
 * operator running the adapter with no injected logger actually sees.
 *
 * The arguments are kept unstringified so a test can assert that the failure
 * OBJECT reached the log, not merely its message text.
 */
async function collectWithLogs(
  agent: StrandsAgent,
  input?: RunAgentInput,
): Promise<{ events: BaseEvent[]; logs: LogLine[] }> {
  const logs: LogLine[] = [];
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      logs.push({ level: "warn", args });
    });
  const error = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      logs.push({ level: "error", args });
    });
  try {
    return { events: await collect(agent, input ?? minimalRunInput()), logs };
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
}

/** Run with the console sinks silenced, returning only the events. */
async function collectQuietly(
  agent: StrandsAgent,
): Promise<{ events: BaseEvent[] }> {
  const { events } = await collectWithLogs(agent);
  return { events };
}

/** Every line whose stringified arguments mention `needle`. */
function linesMentioning(logs: LogLine[], needle: string): LogLine[] {
  return logs.filter((line) =>
    line.args
      .map((a) => String(a))
      .join(" ")
      .includes(needle),
  );
}

/**
 * Every string reachable from `value`, including the ones `JSON.stringify`
 * cannot see.
 *
 * `Error.name`, `Error.message` and `Error.stack` are all non-enumerable, so an
 * event carrying a live `Error` serializes to `{}` and a `not.toContain` check
 * over `JSON.stringify(events)` can never fail however completely the adapter
 * leaks it. This walks the object graph itself and reads those three off any
 * `Error` it meets, plus the `cause` chain, so a leaked failure is observable.
 */
function reachableStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  if (value instanceof Error) {
    out.push(value.name, value.message);
    if (typeof value.stack === "string") out.push(value.stack);
    out.push(...reachableStrings(value.cause, seen));
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    out.push(...reachableStrings(entry, seen));
  }
  return out;
}

/** True when any string reachable from `value` mentions `needle`. */
function mentions(value: unknown, needle: string): boolean {
  return reachableStrings(value).some((s) => s.includes(needle));
}

/** The `stepName` of every event of `kind`, in wire order. */
function stepNames(events: BaseEvent[], kind: EventType): string[] {
  return (events as unknown as Array<{ type: string; stepName?: string }>)
    .filter((e) => e.type === kind)
    .map((e) => e.stepName as string);
}

describe("orchestrator abnormal stop reasons", () => {
  // Every key the adapter's table carries, both spellings of each reason. A key
  // that is never driven is a key whose value nothing pins, and the two
  // spellings do not share a code path: each is its own entry.
  it.each([
    ["guardrailIntervened", "guardrail_intervened"],
    ["contentFiltered", "content_filtered"],
    ["maxTokens", "max_tokens"],
    // `StopReason` widens to `string`, so a model that forwards the provider
    // spelling instead of the SDK's camelCase is recognised too.
    ["guardrail_intervened", "guardrail_intervened"],
    ["content_filtered", "content_filtered"],
    ["max_tokens", "max_tokens"],
  ])(
    "announces %s from a node's terminal result and still finishes the run",
    async (stopReason, expected) => {
      const agent = orchestratorThrowingAfter([
        beforeNodeCall("writer"),
        nodeTextDelta("short"),
        nodeAgentResult(stopReason),
        afterNodeCall("writer"),
      ]);

      // An abnormal stop warns by design; the warn itself is asserted under
      // "orchestrator diagnostics", so it is captured here rather than left on
      // stderr.
      const { events } = await collectWithLogs(agent);

      expect(agentStoppedEvents(events)).toEqual([
        {
          type: EventType.CUSTOM,
          name: "AgentStopped",
          value: { stop_reason: expected },
        },
      ]);
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
      expect(kinds).not.toContain(EventType.RUN_ERROR);
    },
  );

  it.each(["endTurn", "toolUse", "stopSequence", "interrupt"])(
    "stays silent for the normal stop %s",
    async (stopReason) => {
      const agent = orchestratorThrowingAfter([
        nodeTextDelta("done"),
        nodeAgentResult(stopReason),
      ]);

      const events = await collect(agent);

      expect(agentStoppedEvents(events)).toEqual([]);
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
    },
  );

  it("stays silent when a node's terminal result carries no stop reason", async () => {
    const agent = orchestratorThrowingAfter([
      {
        type: "nodeStreamUpdateEvent",
        inner: { source: "agent", event: { type: "agentResultEvent" } },
      },
    ]);

    const events = await collect(agent);

    expect(agentStoppedEvents(events)).toEqual([]);
    const kinds = events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("announces one hint per node in a multi-node run", async () => {
    // A Graph runs several nodes, each with its own terminal result. Every
    // abnormal stop gets its own hint so a client can attribute the outcome.
    //
    // Each node is bracketed by its own before/after pair, which is the only
    // shape the SDK emits: `AfterNodeCallEvent` is fired by the same call that
    // fired `BeforeNodeCallEvent`, so a script with an after and no before
    // produces a STEP_FINISHED that no real run can, and one the AG-UI client
    // verifier rejects outright.
    const agent = orchestratorThrowingAfter([
      beforeNodeCall("writer"),
      nodeTextDelta("first"),
      nodeAgentResult("contentFiltered"),
      afterNodeCall("writer"),
      beforeNodeCall("editor"),
      nodeTextDelta("second", "editor"),
      nodeAgentResult("endTurn", "editor"),
      afterNodeCall("editor"),
      beforeNodeCall("reviewer"),
      nodeTextDelta("third", "reviewer"),
      nodeAgentResult("maxTokens", "reviewer"),
      afterNodeCall("reviewer"),
    ]);

    const { events } = await collectWithLogs(agent);

    expect(
      agentStoppedEvents(events).map(
        (e) => (e.value as { stop_reason: string }).stop_reason,
      ),
    ).toEqual(["content_filtered", "max_tokens"]);
    // Every step the script opened was closed, which is what makes it a script
    // the SDK could have produced and a run the AG-UI verifier would accept.
    expect(stepNames(events, EventType.STEP_STARTED)).toEqual([
      "agent:writer",
      "agent:editor",
      "agent:reviewer",
    ]);
    expect(stepNames(events, EventType.STEP_FINISHED)).toEqual([
      "agent:writer",
      "agent:editor",
      "agent:reviewer",
    ]);
    const kinds = events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("announces one hint per abnormal terminal result, once each", async () => {
    // The same node reporting the same abnormal stop twice gets two hints, one
    // per result: the hint describes a result, not a run.
    const agent = orchestratorThrowingAfter([
      nodeTextDelta("first"),
      nodeAgentResult("contentFiltered"),
      nodeTextDelta("second"),
      nodeAgentResult("contentFiltered"),
    ]);

    const { events } = await collectWithLogs(agent);

    expect(agentStoppedEvents(events)).toEqual([
      {
        type: EventType.CUSTOM,
        name: "AgentStopped",
        value: { stop_reason: "content_filtered" },
      },
      {
        type: EventType.CUSTOM,
        name: "AgentStopped",
        value: { stop_reason: "content_filtered" },
      },
    ]);
  });

  it("announces the hint before the terminal error when both happen", async () => {
    // Reachable on a real Graph: a node can stop abnormally and a later
    // orchestration budget violation can still end the run. The budget throw
    // reaches the outer handler and is reported as STRANDS_ERROR, never as a
    // model forced stop. `orchestrator-real-graph.test.ts` drives both halves
    // against a real `Graph`.
    const agent = orchestratorThrowingAfter(
      [nodeTextDelta("short"), nodeAgentResult("contentFiltered")],
      new Error("steps=<1> | max steps reached"),
    );

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const hintAt = agentStoppedIndex(events);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    expect(hintAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(-1);
    expect(hintAt).toBeLessThan(errorAt);
    expect(runError(events)?.code).toBe("STRANDS_ERROR");
  });
});

describe("orchestrator inherited object keys are not stop reasons", () => {
  it.each([
    "toString",
    "constructor",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ])(
    "stays silent when a node's terminal stop reason is the inherited key %s",
    async (stopReason) => {
      // This path reads the same abnormal-reason table as the single-agent one,
      // so it inherits the same exposure: `StopReason` widens to `string`, a
      // provider value reaches the table verbatim, and a table looked up
      // through the prototype chain answers these keys with an inherited
      // function or object. That passes a truthiness guard and puts a
      // `stop_reason` that is not a stop reason on the wire.
      const agent = orchestratorThrowingAfter([
        nodeTextDelta("hi"),
        nodeAgentResult(stopReason),
      ]);

      const events = await collect(agent);

      expect(agentStoppedEvents(events)).toEqual([]);
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
    },
  );
});

/**
 * The aggregate `MultiAgentResult` a Graph or Swarm returns on `{ done: true }`
 * is not read, so its terminal status changes nothing on the wire.
 *
 * That leaves a fully failed Graph reporting as a finished run. It is a real
 * bug and it is deliberately not fixed here, but not because the adapter is
 * blind to node failures: `AfterNodeCallEvent.error` and
 * `NodeResultEvent.result.error` (`multiagent/events.d.ts`) both reach the
 * consume loop and are discarded as well. What was judged unusable is the
 * aggregate STATUS specifically, because `_resolveStatus`
 * (`multiagent/state.js`) marks the aggregate FAILED when ANY node failed, so a
 * Graph that lost one parallel branch and answered from another is FAILED too
 * and acting on that status would fail runs that succeeded. What a failed Graph
 * run owes a client, and which of the available signals should say it, is a
 * design question of its own. These tests pin what the adapter does today, so
 * that answering it later is a visible change rather than a silent one.
 */
describe("orchestrator terminal aggregate status", () => {
  it.each([
    ["COMPLETED", [nodeResult("writer", "COMPLETED")]],
    ["CANCELLED", [nodeResult("writer", "CANCELLED")]],
    ["FAILED", [nodeResult("flaky", "FAILED", new Error("provider exploded"))]],
  ])("finishes the run on a %s aggregate", async (status, results) => {
    const agent = orchestratorReturning(
      [nodeTextDelta("partial")],
      multiAgentResult(status, results),
    );

    const events = await collect(agent);

    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_ERROR);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("puts no error on the wire for a FAILED aggregate", async () => {
    // Not merely "the run finished": nothing about the aggregate reaches the
    // client at all, so a frontend has no failure to render either.
    //
    // Asserted over the reachable strings rather than over
    // `JSON.stringify(events)`. The failure the aggregate carries is an
    // `Error`, whose `message` is non-enumerable, so forwarding the whole
    // aggregate verbatim would serialize that error to `{}` and satisfy a JSON
    // check while putting the failed run on the wire. The node id and the
    // aggregate status are asserted alongside it, because a leak that dropped
    // the error object would still be a leak.
    const agent = orchestratorReturning(
      [],
      multiAgentResult("FAILED", [
        nodeResult("flaky", "FAILED", new Error("provider exploded")),
      ]),
    );

    const events = await collect(agent);

    expect(mentions(events, "provider exploded")).toBe(false);
    expect(mentions(events, "flaky")).toBe(false);
    expect(mentions(events, "FAILED")).toBe(false);
    expect(agentStoppedEvents(events)).toEqual([]);
  });

  it("finishes normally when the stream returns nothing at all", async () => {
    // A custom `MultiAgent` implementation need not return a result, and an
    // absent one is not a failure.
    const agent = orchestratorReturning([nodeTextDelta("hi")], undefined);

    const events = await collect(agent);

    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_ERROR);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });
});

describe("orchestrator step envelopes", () => {
  it("leaves a step the SDK never closed open on a failed run", async () => {
    // Step pairing follows the SDK's own node brackets and nothing else: a
    // `STEP_STARTED` whose `afterNodeCallEvent` never arrived stays open, on a
    // failed run exactly as on the healthy run that orchestrator-path.test.ts
    // pins for a hook-cancelled node.
    const agent = orchestratorThrowingAfter(
      [beforeNodeCall("writer")],
      new Error("steps=<1> | max steps reached"),
    );

    const { events } = await collectQuietly(agent);

    expect(stepNames(events, EventType.STEP_STARTED)).toEqual(["agent:writer"]);
    expect(stepNames(events, EventType.STEP_FINISHED)).toEqual([]);
    const kinds = events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
  });

  it("adds no step event of its own when every node reported", async () => {
    const agent = orchestratorThrowingAfter(
      [beforeNodeCall("writer"), afterNodeCall("writer")],
      new Error("steps=<1> | max steps reached"),
    );

    const { events } = await collectQuietly(agent);

    expect(stepNames(events, EventType.STEP_STARTED)).toEqual(["agent:writer"]);
    expect(stepNames(events, EventType.STEP_FINISHED)).toEqual([
      "agent:writer",
    ]);
  });
});

describe("orchestrator diagnostics", () => {
  it("resolves the thread id on the normal node-result trace too", async () => {
    // The normal stop only reaches `debug`, which `DEFAULT_LOGGER` drops, so
    // an injected logger is the only way to see the line an operator running
    // with debug wired up reads. Both arms print the same thread id.
    const debug = vi.fn();
    const stub = {
      id: "test-graph",
      async *stream(_input: string) {
        yield nodeTextDelta("done");
        yield nodeAgentResult("endTurn");
      },
    };
    const agent = new StrandsAgent({
      agent: stub as unknown as import("@strands-agents/sdk").Agent,
      name: "orch",
      config: { logger: { debug, warn: vi.fn(), error: vi.fn() } },
    });

    await collect(agent, minimalRunInput({ threadId: "" }));

    const lines = debug.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("node agent_result:"));
    expect(lines).toEqual([
      "[@ag-ui/aws-strands] node agent_result: threadId=default, " +
        "nodeId=writer, stopReason=endTurn",
    ]);
  });

  it("resolves the thread id the log prints the way the adapter does", async () => {
    // `run()` resolves an empty thread id to "default" and every per-thread
    // lookup uses that value. Printing the raw input instead put a thread id on
    // the node terminal-result line that no other line in the adapter agrees
    // with. This is the abnormal arm, which reaches `warn`; the debug arm is
    // driven above.
    const agent = orchestratorThrowingAfter([
      nodeTextDelta("blocked"),
      nodeAgentResult("guardrailIntervened"),
    ]);

    const { logs } = await collectWithLogs(
      agent,
      minimalRunInput({ threadId: "" }),
    );

    expect(linesMentioning(logs, "node agent_result:")).toHaveLength(1);
    expect(linesMentioning(logs, "threadId=default")).toHaveLength(1);
    expect(linesMentioning(logs, "threadId=,")).toEqual([]);
  });

  it("logs an abnormal node stop where the default logger emits it", async () => {
    // `DEFAULT_LOGGER.debug` is a no-op, so a guardrail stop logged at debug
    // leaves no server trace at all.
    const agent = orchestratorThrowingAfter([
      nodeTextDelta("blocked"),
      nodeAgentResult("guardrailIntervened"),
    ]);

    const { events, logs } = await collectWithLogs(agent);

    expect(agentStoppedEvents(events)).toHaveLength(1);
    const lines = linesMentioning(logs, "guardrailIntervened");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.level === "warn")).toBe(true);
  });

  it("stays quiet on a normal node stop", async () => {
    const agent = orchestratorThrowingAfter([
      nodeTextDelta("done"),
      nodeAgentResult("endTurn"),
    ]);

    const { logs } = await collectWithLogs(agent);

    expect(logs).toEqual([]);
  });
});
