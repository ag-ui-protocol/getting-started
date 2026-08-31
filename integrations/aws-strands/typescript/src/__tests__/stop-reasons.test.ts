/**
 * Abnormal terminal stop reasons.
 *
 * A forced stop is a failed run carrying the underlying reason; a truncated
 * response, a guardrail intervention and filtered content are non-normal stops
 * that still finish, each announced by an `AgentStopped` hint. Both shapes are
 * matched literally by clients and by mock harnesses against the Python
 * adapter, so every assertion here pins the wire payload rather than the branch
 * that produced it.
 *
 * The reasons split by how the TS SDK reports them. `guardrailIntervened` and
 * `contentFiltered` reach the terminal `AgentResult`, so a real run announces
 * them. No SDK stream can carry `maxTokens` that far: `Model.streamAggregated`
 * throws `MaxTokensError` the moment the aggregated stop reason is `maxTokens`,
 * and that throw is reported as a plain stream error with no hint, exactly as
 * Python reports its own `MaxTokensReachedException`.
 *
 * `maxTokens` is nonetheless kept in `ABNORMAL_STOP_REASONS`, as a literal
 * mirror of Python's tuple, and a custom `Model` that produced the reason
 * instead of throwing would be hinted. That is the case the `maxTokens` rows
 * below drive: they pin the table entry, not a stream the shipped SDK can
 * produce.
 *
 * That the entry is unreachable through a real model is not something any test
 * here can pin, because it is a property of the SDK rather than of the adapter:
 * no adapter test can observe what a `Model` implementation the adapter never
 * calls would have done. It was verified by reading the SDK instead
 * (`dist/src/models/model.js` throws `MaxTokensError` the moment the aggregated
 * stop reason is `maxTokens`, and no shipped provider overrides
 * `streamAggregated`). What the tests below do pin is the consequence a client
 * sees: a thrown `MaxTokensError` reports `STRANDS_ERROR` and announces
 * nothing.
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentResult,
  AgentResultEvent,
  ContextWindowOverflowError,
  MaxTokensError,
  Message,
  ModelError,
  ModelThrottledError,
  StructuredOutputError,
  TextBlock,
  ToolUseBlock,
} from "@strands-agents/sdk";
import type { Agent, AgentStreamEvent, StopReason } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";

import {
  collect,
  minimalRunInput,
  scriptedStrandsAgent,
  stream,
} from "./helpers";

const FORCE_STOP_FALLBACK = "The Strands agent stopped unexpectedly.";

type RunError = { type: string; code?: string; message?: string };
type CustomEvent = { type: string; name?: string; value?: unknown };

/**
 * Terminal `AgentResultEvent` carrying `stopReason`, as `Agent.stream()` yields
 * it.
 *
 * The SDK's own class, so `type`, the `result` nesting and the `agent` /
 * `invocationState` siblings are the SDK's rather than this file's opinion of
 * them. `agent` is a `LocalAgent` the adapter never dereferences, so a stub
 * stands in for one; everything the adapter does read is real.
 *
 * `stopReason` is widened deliberately. `StopReason` is a union in the type
 * system but `string` at runtime, and half the rows below drive provider
 * spellings and inherited object keys that the union does not carry.
 *
 * The class carries a `toJSON` that returns `{ type, result }`, but that does
 * not blunt the RAW-leak assertion below: `sanitizeRawEvent` copies the event's
 * own keys into a fresh object before serializing, so `agent` and
 * `invocationState` are stringified as ordinary data and the assertion still
 * fails when the adapter stops holding them back. Verified by removing both
 * defences and watching it go red.
 */
function agentResult(stopReason: string): AgentStreamEvent {
  return new AgentResultEvent({
    agent: { name: "test", model: { modelId: "stub-model" } } as never,
    result: new AgentResult({
      stopReason: stopReason as StopReason,
      lastMessage: new Message({
        role: "assistant",
        content: [new TextBlock("done")],
      }),
      invocationState: { userId: "u-1" },
    }),
    invocationState: { userId: "u-1" },
  }) as unknown as AgentStreamEvent;
}

/** A stub whose stream yields `events` and then throws `error`. */
function throwingAfter(events: AgentStreamEvent[], error: unknown) {
  return {
    stream: async function* () {
      for (const event of events) yield event;
      throw error;
    } as unknown as Agent["stream"],
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
 * Located by name, never by event type: the adapter emits other CUSTOM events
 * (`PredictState`, `MultiAgentHandoff`), so an index taken from the type alone
 * is satisfied by an unrelated custom event.
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
  agent: ReturnType<typeof scriptedStrandsAgent>,
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

/** Run with `console.error` silenced, returning the events and the logged lines. */
async function collectQuietly(
  agent: ReturnType<typeof scriptedStrandsAgent>,
): Promise<{ events: BaseEvent[]; logged: string[] }> {
  const { events, logs } = await collectWithLogs(agent);
  return {
    events,
    logged: logs
      .filter((line) => line.level === "error")
      .map((line) => line.args.map((a) => String(a)).join(" ")),
  };
}

/** The line whose arguments include `value` by identity, if any. */
function lineCarrying(logs: LogLine[], value: unknown): LogLine | undefined {
  return logs.find((line) => line.args.some((arg) => arg === value));
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

describe("forced stop", () => {
  it("reports the underlying reason as a run error and logs it", async () => {
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter([], new Error("Too many requests")),
    });

    const { events, logged } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
    expect(kinds).not.toContain(EventType.RUN_FINISHED);
    expect(kinds).not.toContain(EventType.TEXT_MESSAGE_START);
    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Too many requests",
    });
    expect(logged.some((line) => line.includes("Too many requests"))).toBe(
      true,
    );
  });

  it("falls back to Python's message when the failure carries no reason", async () => {
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter([], new Error("   ")),
    });

    const { events } = await collectQuietly(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: FORCE_STOP_FALLBACK,
    });
  });

  it("closes a text message that was still open when the failure arrived", async () => {
    // Python closes an open text message before reporting the error, and a
    // client that saw TEXT_MESSAGE_START must not be left holding it open on
    // either bridge. Nothing but a text delta is scripted, so the only thing
    // that can close the message is the closeout after the stream teardown:
    // the tool-call case below rotates the message id mid-stream and would
    // supply a TEXT_MESSAGE_END whether or not the closeout ran.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter(
        [stream.textDelta("partial answ")],
        new Error("provider throttled"),
      ),
    });

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const startAt = kinds.indexOf(EventType.TEXT_MESSAGE_START);
    const messageEndAt = kinds.indexOf(EventType.TEXT_MESSAGE_END);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    // Present, not merely "not after". indexOf returns -1 for an event that
    // never reached the wire, which would satisfy an ordering check alone.
    expect(startAt).toBeGreaterThan(-1);
    expect(messageEndAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(-1);
    expect(messageEndAt).toBeLessThan(errorAt);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
    expect(runError(events)?.code).toBe("STRANDS_FORCE_STOP");
  });

  it("closes a reasoning message that was still open when the failure arrived", async () => {
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter(
        [stream.reasoningDelta("thinking abo")],
        new Error("provider throttled"),
      ),
    });

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const startAt = kinds.indexOf(EventType.REASONING_MESSAGE_START);
    const messageEndAt = kinds.indexOf(EventType.REASONING_MESSAGE_END);
    const reasoningEndAt = kinds.indexOf(EventType.REASONING_END);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    expect(startAt).toBeGreaterThan(-1);
    expect(messageEndAt).toBeGreaterThan(-1);
    expect(reasoningEndAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(-1);
    expect(messageEndAt).toBeLessThan(errorAt);
    expect(reasoningEndAt).toBeLessThan(errorAt);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
    expect(runError(events)?.code).toBe("STRANDS_FORCE_STOP");
  });

  it("flushes an open tool call before the error", async () => {
    // A client that saw TOOL_CALL_START is not left holding it open.
    //
    // This is a deliberate divergence from Python, not a match. Python's
    // `deferred_frontend_tool_ends` flush sits INSIDE the `try` that consumes
    // the stream (`agent.py`), so the throw that ends the run skips it and no
    // TOOL_CALL_END reaches the client; the closeout it falls through to closes
    // messages only. `_drainPendingToolCalls` runs in the closeout that always
    // executes, so TypeScript emits ends Python does not. Matching Python's
    // omission would leave an AG-UI client holding an open tool call and trip
    // its "tool calls still active" verifier, so the divergence stays.
    //
    // The TEXT_MESSAGE_END here says nothing about the closeout: streaming
    // tool args rotates the assistant message id, which closes the open text
    // turn mid-stream. TOOL_CALL_END is the event only the drain can produce,
    // because no scripted event completes the call.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter(
        [
          stream.textDelta("partial answ"),
          stream.toolUseStart("tool-1", "get_weather"),
          stream.toolUseDelta('{"city":'),
        ],
        new Error("provider throttled"),
      ),
    });

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    const messageEndAt = kinds.indexOf(EventType.TEXT_MESSAGE_END);
    const toolEndAt = kinds.indexOf(EventType.TOOL_CALL_END);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_START);
    expect(kinds).toContain(EventType.TOOL_CALL_START);
    // Present, not merely "not after". indexOf returns -1 for an event that
    // never reached the wire, which would satisfy an ordering check alone.
    expect(messageEndAt).toBeGreaterThan(-1);
    expect(toolEndAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(-1);
    expect(messageEndAt).toBeLessThan(errorAt);
    expect(toolEndAt).toBeLessThan(errorAt);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
    expect(runError(events)?.code).toBe("STRANDS_FORCE_STOP");
  });

  it("reports the failure exactly once and never twice", async () => {
    // One failure is one RUN_ERROR. A second report, from the outer handler or
    // from a rethrow, would leave a client unable to tell one failed run from
    // two.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter(
        [stream.textDelta("partial")],
        new Error("provider throttled"),
      ),
    });

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    expect(kinds.filter((k) => k === EventType.RUN_ERROR)).toEqual([
      EventType.RUN_ERROR,
    ]);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    expect(errorAt).toBeGreaterThan(-1);
    expect(kinds.slice(errorAt)).toEqual([EventType.RUN_ERROR]);
  });

  it("skips the final state snapshot a successful run ends with", async () => {
    // A forced stop is a failed run, not a short success, so the closing
    // STATE_SNAPSHOT never arrives. Compared against the same script finishing
    // normally, so the count is pinned by the contrast and not by a comment
    // about which snapshot the initial one is.
    const script = [stream.textDelta("partial"), agentResult("endTurn")];
    const failing = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter(
        [stream.textDelta("partial")],
        new Error("provider throttled"),
      ),
    });
    const succeeding = scriptedStrandsAgent(script);

    const { events: failedEvents } = await collectQuietly(failing);
    const okEvents = await collect(succeeding);

    const snapshotsIn = (events: BaseEvent[]) =>
      events.filter((e) => e.type === EventType.STATE_SNAPSHOT).length;
    expect(snapshotsIn(okEvents)).toBe(2);
    expect(snapshotsIn(failedEvents)).toBe(1);
    // And the one that survived is the opening snapshot, not a closing one
    // that moved.
    const failedKinds = failedEvents.map((e) => e.type);
    const snapshotAt = failedKinds.indexOf(EventType.STATE_SNAPSHOT);
    const errorAt = failedKinds.indexOf(EventType.RUN_ERROR);
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(-1);
    expect(snapshotAt).toBeLessThan(errorAt);
  });

  it("announces the hint before the terminal error when both happen", async () => {
    // A node can report an abnormal stop and the stream can fail afterwards.
    // The hint describes work that already happened, so it precedes the error.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter(
        [stream.textDelta("short"), agentResult("contentFiltered")],
        new Error("provider throttled"),
      ),
    });

    const { events } = await collectQuietly(agent);

    const hintAt = agentStoppedIndex(events);
    const errorAt = events.map((e) => e.type).indexOf(EventType.RUN_ERROR);
    expect(hintAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(-1);
    expect(hintAt).toBeLessThan(errorAt);
    expect(runError(events)?.code).toBe("STRANDS_FORCE_STOP");
  });

  it("keeps an adapter code defect out of the forced-stop code", async () => {
    // TypeError/ReferenceError mean the adapter is broken, not that the
    // provider failed, so they keep their own classification.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter([], new TypeError("cannot read 'x'")),
    });

    const { events } = await collectQuietly(agent);

    expect(runError(events)?.code).toBe("ADAPTER_BUG");
    expect(agentStoppedEvents(events)).toEqual([]);
  });

  it("keeps a ReferenceError out of the forced-stop code", async () => {
    // The second half of that classification. Driven on this path as well as
    // on the orchestrator's, because the two paths reach `ADAPTER_BUG` through
    // different code: the shared reporter rethrows, and it is each path's own
    // outer handler that decides the code from there.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter([], new ReferenceError("x is not defined")),
    });

    const { events } = await collectQuietly(agent);

    expect(runError(events)?.code).toBe("ADAPTER_BUG");
    expect(agentStoppedEvents(events)).toEqual([]);
  });

  it("commits the partial assistant text to a snapshot before the error", async () => {
    // Splice point 4 of 4 runs on a forced stop too, because it sits inside
    // the same `messageStarted` closeout as TEXT_MESSAGE_END. A frontend that
    // rebuilds history from MESSAGES_SNAPSHOT therefore keeps the partial turn
    // the run died in, rather than ending with a snapshot that never saw it.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter(
        [stream.textDelta("partial answ")],
        new Error("provider throttled"),
      ),
    });

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const snapshotAt = kinds.lastIndexOf(EventType.MESSAGES_SNAPSHOT);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(-1);
    expect(snapshotAt).toBeLessThan(errorAt);
    const snapshot = events[snapshotAt] as unknown as {
      messages: Array<{ role?: string; content?: string }>;
    };
    expect(snapshot.messages[snapshot.messages.length - 1]).toMatchObject({
      role: "assistant",
      content: "partial answ",
    });
  });
});

describe("abnormal stop reasons", () => {
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
    "announces %s on the terminal result and still finishes the run",
    async (stopReason, expected) => {
      const agent = scriptedStrandsAgent([
        stream.textDelta("short"),
        agentResult(stopReason),
      ]);

      // An abnormal stop warns by design; the warn itself is asserted under
      // "diagnostics", so it is captured here rather than left on stderr.
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
      const agent = scriptedStrandsAgent([
        stream.textDelta("done"),
        agentResult(stopReason),
      ]);

      const events = await collect(agent);

      expect(agentStoppedEvents(events)).toEqual([]);
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
    },
  );

  it("stays silent when the terminal result carries no stop reason", async () => {
    const agent = scriptedStrandsAgent([
      { type: "agentResultEvent" } as unknown as AgentStreamEvent,
    ]);

    const events = await collect(agent);

    expect(agentStoppedEvents(events)).toEqual([]);
    const kinds = events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("does not forward the terminal result itself as a RAW event", async () => {
    // The hint is additive: the result's own payload already streamed, so it
    // must stay off the wire exactly as it did before the hint existed.
    const agent = scriptedStrandsAgent([
      stream.textDelta("short"),
      agentResult("contentFiltered"),
    ]);

    const { events } = await collectWithLogs(agent);

    // Agent context first: the sanitizer strips `agent` and `invocationState`
    // by key, so this stays true even if the skip above it is lost, and it
    // fails only when both defences are gone.
    const wire = JSON.stringify(events);
    expect(wire).not.toContain("invocationState");
    expect(wire).not.toContain("stub-model");
    expect(events.filter((e) => e.type === EventType.RAW)).toEqual([]);
  });
});

describe("inherited object keys are not stop reasons", () => {
  it.each([
    "toString",
    "constructor",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ])(
    "stays silent when the terminal stop reason is the inherited key %s",
    async (stopReason) => {
      // `StopReason` widens to `string`, so a provider value reaches the
      // abnormal-reason table verbatim. A table looked up through the
      // prototype chain answers these keys with an inherited function or
      // object, which passes a truthiness guard and puts a `stop_reason`
      // that is not a stop reason on the wire.
      const agent = scriptedStrandsAgent([
        stream.textDelta("hi"),
        agentResult(stopReason),
      ]);

      const events = await collect(agent);

      expect(agentStoppedEvents(events)).toEqual([]);
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
    },
  );
});

/**
 * A `MaxTokensError` raised by a SECOND copy of the SDK in the dependency tree.
 *
 * Carries the `name` the SDK's own constructor sets, and is not an
 * `instanceof` the class this file imports. That combination is the whole
 * reason the bypass matches on `Error.name`: a peer dependency resolved twice,
 * from two version ranges or from a workspace link sitting next to a registry
 * install, produces two unrelated classes for one error, and `instanceof`
 * answers false for the copy the adapter did not import. A test built only
 * from real SDK instances cannot tell the two matching strategies apart.
 */
class DuplicatedSdkMaxTokensError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaxTokensError";
  }
}

/**
 * The failures Python raises AFTER its model call returned normally.
 *
 * `event_loop_cycle` re-raises `MaxTokensReachedException` and
 * `StructuredOutputException` without yielding a `ForceStopEvent`, so its
 * adapter reports them from the outer handler as STRANDS_ERROR. These are the
 * TS analogues and must land on the same code, whichever copy of the SDK
 * raised them.
 */
const bypassingFailures: [string, Error][] = [
  [
    "MaxTokensError",
    new MaxTokensError(
      "Model reached maximum token limit. This is an unrecoverable state that requires intervention.",
      new Message({ role: "assistant", content: [new TextBlock("partial")] }),
    ),
  ],
  [
    "StructuredOutputError",
    new StructuredOutputError(
      "The model failed to invoke the structured output tool even after it was forced.",
    ),
  ],
  [
    "MaxTokensError from a duplicated SDK copy",
    new DuplicatedSdkMaxTokensError(
      "Model reached maximum token limit. This is an unrecoverable state that requires intervention.",
    ),
  ],
];

/**
 * Failures raised from INSIDE the model call.
 *
 * Python's `_handle_model_execution` yields `ForceStopEvent` for anything that
 * escapes the model call once no hook asked for a retry, so these report as the
 * forced stop even though `ContextWindowOverflowException` also appears in the
 * post-model-call re-raise tuple. Both TS counterparts are raised by the
 * provider while it translates a model-call failure.
 */
const forcedStopFailures: [string, Error][] = [
  ["ModelThrottledError", new ModelThrottledError("Too many requests")],
  [
    "ContextWindowOverflowError",
    new ContextWindowOverflowError("Input is too long for requested model."),
  ],
];

describe("where the failure was raised decides the code", () => {
  it.each(bypassingFailures)(
    "reports a thrown %s as a stream error, not a forced stop",
    async (_name, failure) => {
      const agent = scriptedStrandsAgent([], {
        stubOverrides: throwingAfter([stream.textDelta("partial")], failure),
      });

      const { events } = await collectQuietly(agent);

      expect(runError(events)).toMatchObject({
        code: "STRANDS_ERROR",
        message: failure.message,
      });
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
      expect(kinds).not.toContain(EventType.RUN_FINISHED);
    },
  );

  it.each(forcedStopFailures)(
    "reports a thrown %s as the forced stop",
    async (_name, failure) => {
      const agent = scriptedStrandsAgent([], {
        stubOverrides: throwingAfter([stream.textDelta("partial")], failure),
      });

      const { events } = await collectQuietly(agent);

      expect(runError(events)).toMatchObject({
        code: "STRANDS_FORCE_STOP",
        message: failure.message,
      });
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
      expect(kinds).not.toContain(EventType.RUN_FINISHED);
    },
  );

  it.each(bypassingFailures)(
    "leaves an open text message open ahead of a thrown %s",
    async (_name, failure) => {
      // The deliberate divergence, and the twin of the orchestrator assertion
      // that pins the opposite. A bypassed failure rethrows out of the consume
      // loop and skips this path's closeout, so no TEXT_MESSAGE_END reaches the
      // client before RUN_ERROR. Python's bare `raise` leaves its own closeout
      // the same way, so both bridges put the same events on the wire; the
      // orchestrator path has no Python counterpart and closes its messages
      // instead. Asserted rather than assumed, because "we match Python here"
      // is only true while nothing quietly adds a closeout to this branch.
      const agent = scriptedStrandsAgent([], {
        stubOverrides: throwingAfter(
          [stream.textDelta("partial answ")],
          failure,
        ),
      });

      const { events } = await collectQuietly(agent);

      const kinds = events.map((e) => e.type);
      expect(kinds).toContain(EventType.TEXT_MESSAGE_START);
      expect(kinds).not.toContain(EventType.TEXT_MESSAGE_END);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
      expect(runError(events)?.code).toBe("STRANDS_ERROR");
    },
  );

  it.each([...bypassingFailures, ...forcedStopFailures])(
    "invents no stop-reason hint for a thrown %s",
    async (_name, failure) => {
      // Python emits AgentStopped only off a terminal result, and its
      // max_tokens branch there is unreachable because the event loop raises
      // first. Mirroring it means staying silent, not synthesising a hint the
      // other bridge never sends.
      const agent = scriptedStrandsAgent([], {
        stubOverrides: throwingAfter([], failure),
      });

      const { events } = await collectQuietly(agent);

      expect(agentStoppedEvents(events)).toEqual([]);
    },
  );
});

/**
 * A run that halts on a frontend tool call, which is the window in which
 * Strands raises its "stream ended" sentinel as expected flow.
 */
function frontendHaltInput(): RunAgentInput {
  return minimalRunInput({
    messages: [{ id: "u1", role: "user", content: "do a thing" }],
    tools: [
      {
        name: "set_color",
        description: "Sets a UI color.",
        parameters: {
          type: "object",
          properties: { color: { type: "string" } },
          required: ["color"],
        },
      },
    ],
  });
}

/**
 * The frontend tool call that arms the halt, and nothing after it.
 *
 * Emitting the call sets `pendingHalt`; the `afterToolCallEvent` that would
 * normally follow breaks the consume loop outright, so a throw scripted after
 * it is never reached. The window this suite is about is the one in between:
 * halt armed, and the SDK raises before its after-call event arrives, which is
 * exactly how a halted Strands cycle behaves.
 */
function frontendHaltPrelude(): AgentStreamEvent[] {
  return [
    new ToolUseBlock({
      name: "set_color",
      toolUseId: "fe-1",
      input: { color: "red" },
    }) as unknown as AgentStreamEvent,
  ];
}

async function collectHalting(
  failure: unknown,
): Promise<{ events: BaseEvent[]; logs: LogLine[] }> {
  const agent = scriptedStrandsAgent([], {
    stubOverrides: throwingAfter(frontendHaltPrelude(), failure),
  });
  return collectWithLogs(agent, frontendHaltInput());
}

describe("failures inside the frontend-halt window", () => {
  it("still swallows the SDK's stream-ended sentinel", async () => {
    // The sentinel is a bare `ModelError` with no `cause`: Strands raises it
    // when a frontend tool call halts the agent before the model produced a
    // final assistant message. That throw is expected flow and must keep
    // finishing the run.
    const { events } = await collectHalting(
      new ModelError("Stream ended without completing a message"),
    );

    const kinds = events.map((e) => e.type);
    expect(kinds).toContain(EventType.TOOL_CALL_END);
    expect(kinds).not.toContain(EventType.RUN_ERROR);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("surfaces a throttle instead of reporting the run as finished", async () => {
    const { events } = await collectHalting(
      new ModelThrottledError("Too many requests"),
    );

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Too many requests",
    });
    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_FINISHED);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
  });

  it("surfaces a wrapped provider failure instead of reporting the run as finished", async () => {
    // `Model.streamAggregated` re-raises anything that is not already a
    // ModelError as `ModelError(message, { cause })`. The sentinel carries no
    // cause, so the wrapper is distinguishable without reading the message.
    const { events } = await collectHalting(
      new ModelError("Bedrock upstream 500: internal server error", {
        cause: new Error("500"),
      }),
    );

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Bedrock upstream 500: internal server error",
    });
    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_FINISHED);
  });

  it("surfaces a token-limit failure under the stream-error code", async () => {
    const { events } = await collectHalting(
      new MaxTokensError(
        "Model reached maximum token limit. This is an unrecoverable state that requires intervention.",
        new Message({ role: "assistant", content: [new TextBlock("partial")] }),
      ),
    );

    expect(runError(events)?.code).toBe("STRANDS_ERROR");
    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_FINISHED);
  });

  it("keeps an adapter code defect out of the halt swallow", async () => {
    const { events } = await collectHalting(new TypeError("cannot read 'x'"));

    expect(runError(events)?.code).toBe("ADAPTER_BUG");
  });

  it("keeps a ReferenceError shaped like the sentinel out of the halt swallow", async () => {
    // The sentinel check accepts a bare `Error` carrying no `cause`, so a code
    // defect whose `name` reads "Error" matches it by shape and nothing else.
    // The `instanceof` classification runs BEFORE the swallow for exactly this
    // reason: a defect must not be able to finish a run by looking like
    // expected flow. Reading `name` off the thrown value is what makes this
    // reachable at all, so this is the case that arm exists for.
    const failure = new ReferenceError("x is not defined");
    Object.defineProperty(failure, "name", { value: "Error" });

    const { events } = await collectHalting(failure);

    expect(runError(events)?.code).toBe("ADAPTER_BUG");
    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_FINISHED);
  });

  it("still reports a wrapped failure whose message reads like the sentinel", async () => {
    // The swallow is a check on taxonomy, not on text, and this is the
    // direction a naive `message.includes(...)` match gets dangerously wrong.
    // `Model.streamAggregated` re-raises a provider failure as
    // `ModelError(message, { cause })`, and nothing stops that message from
    // being the sentinel's own words: the provider chose the wording, not the
    // SDK. Matching on the text would swallow a real failure into a finished
    // run.
    const { events } = await collectHalting(
      new ModelError("Stream ended without completing a message", {
        cause: new Error("Bedrock upstream 500"),
      }),
    );

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Stream ended without completing a message",
    });
    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_FINISHED);
  });

  it("still swallows a sentinel whose wording the SDK changed", async () => {
    // The other direction. The sentinel is identified by carrying no `cause`,
    // so an SDK release that rephrases the string keeps finishing a halted run
    // instead of turning ordinary flow into a failed run. Between this and the
    // case above, a text match cannot pass.
    const { events } = await collectHalting(
      new ModelError("stream closed before the model completed a message"),
    );

    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_ERROR);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("reports a failure whose cause cannot be read rather than swallowing it", async () => {
    // Reading `cause` can throw, from a getter that raises or a `Proxy` whose
    // `get` trap does, and an absent `cause` is what identifies the sentinel.
    // "Cannot tell" must not read as "absent", which would finish a run on a
    // provider failure, and the throw must not escape either, which would
    // report that failure as `ADAPTER_BUG` and skip the closeout.
    const failure = new ModelError("Bedrock upstream 500");
    Object.defineProperty(failure, "cause", {
      get() {
        throw new TypeError("cause accessor exploded");
      },
    });

    const { events } = await collectHalting(failure);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Bedrock upstream 500",
    });
    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_FINISHED);
  });
});

describe("diagnostics", () => {
  it("logs an abnormal terminal stop where the default logger emits it", async () => {
    // `DEFAULT_LOGGER.debug` is a no-op, so a guardrail stop logged at debug
    // leaves no server trace at all. Python logs the terminal result at INFO.
    const agent = scriptedStrandsAgent([
      stream.textDelta("blocked"),
      agentResult("guardrailIntervened"),
    ]);

    const { events, logs } = await collectWithLogs(agent);

    expect(agentStoppedEvents(events)).toHaveLength(1);
    const lines = linesMentioning(logs, "guardrailIntervened");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.level === "warn")).toBe(true);
  });

  it("stays quiet on a normal terminal stop", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("done"),
      agentResult("endTurn"),
    ]);

    const { logs } = await collectWithLogs(agent);

    expect(logs).toEqual([]);
  });

  it("resolves the thread id the log prints the way the adapter does", async () => {
    // `run()` resolves an empty thread id to "default" and every per-thread
    // lookup uses that value. Printing the raw input instead put a thread id
    // on the terminal-result line that no other line in the adapter agrees
    // with, including the forced-stop line right next to it.
    const agent = scriptedStrandsAgent([
      stream.textDelta("blocked"),
      agentResult("guardrailIntervened"),
    ]);

    const { logs } = await collectWithLogs(
      agent,
      minimalRunInput({ threadId: "" }),
    );

    expect(linesMentioning(logs, "agent_result:")).toHaveLength(1);
    expect(linesMentioning(logs, "threadId=default")).toHaveLength(1);
    expect(linesMentioning(logs, "threadId=,")).toEqual([]);
  });

  it("resolves the thread id on the normal terminal-result trace too", async () => {
    // The normal stop only reaches `debug`, which `DEFAULT_LOGGER` drops, so
    // an injected logger is the only way to see the line an operator running
    // with debug wired up reads. Both arms print the same thread id.
    const debug = vi.fn();
    const agent = scriptedStrandsAgent(
      [stream.textDelta("done"), agentResult("endTurn")],
      { config: { logger: { debug, warn: vi.fn(), error: vi.fn() } } },
    );

    await collect(agent, minimalRunInput({ threadId: "" }));

    const lines = debug.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("agent_result:"));
    expect(lines).toEqual([
      "[@ag-ui/aws-strands] agent_result: threadId=default, stopReason=endTurn",
    ]);
  });

  it("still reports the failure when the logger itself throws", async () => {
    // A caller-supplied `Logger` is arbitrary code, and a sink that stringifies
    // what it is handed throws on a circular `cause` without anything being
    // wrong with the run. On this path a throw escaping the report skips the
    // closeout AND the outer handler's own log throws in turn, so `run()`
    // rejects with no terminal event at all: the client sees a truncated
    // stream rather than a failed run. The recorded reason has to outlive a
    // broken logger.
    const failure = new ModelThrottledError("Too many requests");
    const agent = scriptedStrandsAgent([], {
      config: {
        logger: {
          debug: vi.fn(),
          warn: vi.fn(),
          error: () => {
            throw new TypeError("logger exploded");
          },
        },
      },
      stubOverrides: throwingAfter([stream.textDelta("partial answ")], failure),
    });

    const events = await collect(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Too many requests",
    });
    const kinds = events.map((e) => e.type);
    // The closeout ran too, so the message the client saw open is closed.
    expect(kinds).toContain(EventType.TEXT_MESSAGE_END);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
  });

  it("hands the failure object to the forced-stop log, not just its text", async () => {
    // The outer handler this path diverts traffic away from logs
    // `error(prefix, e)`, which is what gives an operator the stack, the name
    // and the `cause`. Dropping to a template string loses all three.
    const failure = new ModelThrottledError("Too many requests", {
      cause: new Error("HTTP 429"),
    });
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter([], failure),
    });

    const { logs } = await collectWithLogs(agent);

    const line = lineCarrying(logs, failure);
    expect(line).toBeDefined();
    expect(line?.level).toBe("error");
  });
});

describe("failures that are not errors", () => {
  it("reports a thrown null under Python's fallback message", async () => {
    // `String(null)` is "null", which survives a trim and would otherwise be
    // put on the wire as the reason a run failed. Python cannot reach this
    // case at all, so the fallback adds no cross-language difference.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter([], null),
    });

    const { events } = await collectQuietly(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: FORCE_STOP_FALLBACK,
    });
  });

  it("reports a thrown undefined under Python's fallback message", async () => {
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter([], undefined),
    });

    const { events } = await collectQuietly(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: FORCE_STOP_FALLBACK,
    });
  });

  it("keeps a thrown string that happens to read 'null'", async () => {
    // A message someone wrote is not the absence of a message.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter([], "null"),
    });

    const { events } = await collectQuietly(agent);

    expect(runError(events)?.message).toBe("null");
  });

  it("reports a failure whose name cannot be read as the forced stop", async () => {
    // Reading `name` can throw, from a getter that raises or a `Proxy` whose
    // `get` trap does. `_errorName` runs FIRST inside the report, ahead of the
    // classification and the message, so a throw escaping it reaches the outer
    // handler and reports a provider failure as `ADAPTER_BUG`. It is the same
    // hazard the reason derivation already guards against, and a name that
    // cannot be read is treated as an absent one.
    const failure = new ModelThrottledError("Too many requests");
    Object.defineProperty(failure, "name", {
      get() {
        throw new TypeError("name accessor exploded");
      },
    });
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter([], failure),
    });

    // `collectWithLogs`, not `collectQuietly`: `Error.prototype.toString`
    // reads `name`, so stringifying this failure throws in the helper.
    const { events } = await collectWithLogs(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Too many requests",
    });
  });

  it("falls back rather than failing on a value with no text at all", async () => {
    // `String()` on an object with a null prototype finds no `toString` and
    // throws a TypeError. Deriving the reason must not be able to fail: a
    // TypeError escaping the derivation reaches the outer handler, which
    // classifies it as an adapter code defect and reports a provider failure
    // as `ADAPTER_BUG`.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: throwingAfter([], Object.create(null)),
    });

    // `collectWithLogs`, not `collectQuietly`: the quiet helper stringifies
    // every logged argument, and this is the one value that cannot be
    // stringified.
    const { events } = await collectWithLogs(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: FORCE_STOP_FALLBACK,
    });
  });
});
