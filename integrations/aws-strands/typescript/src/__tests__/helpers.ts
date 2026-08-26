/**
 * Shared test helpers. These mirror the Python test helpers but adapted for
 * the TS Strands SDK's streaming shape.
 */

import {
  Agent as StrandsAgentCore,
  Model,
  tool,
  type Agent,
  type AgentStreamEvent,
  type Message as StrandsMessage,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import { z } from "zod";
import { expect } from "vitest";
import {
  EventType,
  type BaseEvent,
  type Interrupt as AguiInterrupt,
  type RunAgentInput,
} from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import type { StrandsAgentConfig } from "../config";

export function minimalRunInput(
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput {
  // The spread comes FIRST so the defaults below actually win. It cannot be
  // dropped: RunAgentInput carries keys this list does not enumerate (resume,
  // parentRunId), and every resume-carrying test reaches the gate through it.
  return {
    ...overrides,
    threadId: overrides.threadId ?? "thread-1",
    runId: overrides.runId ?? "run-1",
    state: overrides.state ?? {},
    messages: overrides.messages ?? [],
    tools: overrides.tools ?? [],
    context: overrides.context ?? [],
  };
}

/**
 * Builds a fake `Tool` instance whose identity we can assert on without
 * actually driving a Strands Agent. Matches the minimal Tool contract
 * (`name`, `description`, `toolSpec`, async `stream`).
 */
export function fakeTool(name: string, description = "") {
  return {
    name,
    description,
    toolSpec: {
      name,
      description,
      inputSchema: { json: {} },
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      return { toolUseId: "x", status: "success" as const, content: [] };
    },
  };
}

/**
 * Fake Strands `Agent` stub that yields a scripted stream of events. Covers
 * the attributes the adapter reads (`model`, `tools`, `toolRegistry`, async
 * `stream()`); every other field on `Agent` is not exercised in tests and
 * stays unset. `overrides` lets an individual test swap in a custom `stream`
 * or expose extra state (e.g. to capture the args passed to `stream`).
 */
export function scriptedAgent(
  events: AgentStreamEvent[] | unknown[] = [],
  overrides: Partial<Agent> & Record<string, unknown> = {},
): Agent {
  const tools = new Map<string, unknown>();
  const registry = {
    add: (t: unknown) => {
      const name = (t as { name?: string })?.name;
      if (!name) return;
      // Match the real `@strands-agents/sdk` ToolRegistry.add(): it throws
      // ToolValidationError on a duplicate name. Overwriting silently would let
      // a double-inject regression (the F1 bug class) pass undetected.
      if (tools.has(name)) {
        throw new Error(`Tool "${name}" is already registered`);
      }
      tools.set(name, t);
    },
    get: (n: string) => tools.get(n),
    getByName: (n: string) => tools.get(n),
    remove: (t: unknown) => {
      const name = typeof t === "string" ? t : (t as { name?: string })?.name;
      if (name) tools.delete(name);
    },
    removeByName: (n: string) => tools.delete(n),
    values: () => Array.from(tools.values()),
    // Mirrors the real `@strands-agents/sdk` ToolRegistry.list().
    list: () => Array.from(tools.values()),
  };
  return {
    model: { name: "stub-model", modelId: "stub-model" },
    tools: [],
    toolRegistry: registry,
    async *stream(_args: unknown) {
      for (const e of events) yield e;
    },
    ...overrides,
  } as unknown as Agent;
}

/**
 * Build a StrandsAgent wrapping a scripted stub and seed `_agentsByThread`
 * with the stub for both `"thread-1"` and `"default"`, so the scripted stream
 * fires regardless of which threadId the test's RunAgentInput carries. This
 * is the pattern ~90% of adapter tests need; tests that want the real
 * per-thread cloning path (e.g. session-manager tests) should build the
 * StrandsAgent directly.
 */
export function scriptedStrandsAgent(
  events: AgentStreamEvent[] | unknown[] = [],
  options: {
    config?: StrandsAgentConfig;
    name?: string;
    stubOverrides?: Partial<Agent> & Record<string, unknown>;
  } = {},
): StrandsAgent {
  const stub = scriptedAgent(events, options.stubOverrides);
  const sa = new StrandsAgent({
    agent: stub,
    name: options.name ?? "test",
    config: options.config,
  });
  const byThread = (sa as unknown as { _agentsByThread: Map<string, unknown> })
    ._agentsByThread;
  byThread.set("thread-1", stub);
  byThread.set("default", stub);
  return sa;
}

/**
 * Park interrupts on both stores production keeps in step: the SDK's activated
 * checkpoint, which is what decides whether anything is open, and the adapter's
 * own record, which carries only the AG-UI metadata the SDK has nowhere for
 * (response schema, tool card, expiry).
 *
 * Seeding the record alone describes a thread whose SDK considers itself idle,
 * which production never produces, and every gate reads the SDK.
 *
 * `native` overrides the parked Strands interrupts when a test needs a specific
 * shape (a tool-approval name, or a recorded response); by default each recorded
 * id is parked as a bare unanswered generic interrupt.
 */
export function parkInterrupts(
  aguiAgent: StrandsAgent,
  threadId: string,
  recorded: AguiInterrupt[],
  native?: Map<string, unknown>,
): Map<string, AguiInterrupt> {
  const internals = aguiAgent as unknown as {
    _pendingInterruptsByThread: Map<string, Map<string, AguiInterrupt>>;
    _agentsByThread: Map<string, unknown>;
  };
  const record = new Map(
    recorded.map((interrupt) => [interrupt.id, interrupt]),
  );
  internals._pendingInterruptsByThread.set(threadId, record);

  const interrupts =
    native ??
    new Map<string, unknown>(
      recorded.map((interrupt) => [
        interrupt.id,
        { id: interrupt.id, name: "need_input" },
      ]),
    );
  const strandsAgent = internals._agentsByThread.get(threadId) ?? {};
  internals._agentsByThread.set(threadId, strandsAgent);
  (strandsAgent as { _interruptState?: unknown })._interruptState = {
    activated: interrupts.size > 0,
    interrupts,
  };
  return record;
}

/** Iterate `agent.run()` into an array. Defaults to `minimalRunInput()`. */
export async function collect(
  agent: StrandsAgent,
  input: RunAgentInput = minimalRunInput(),
): Promise<BaseEvent[]> {
  const out: BaseEvent[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

/**
 * Factories for the TS Strands SDK's AgentStreamEvent shapes the adapter
 * consumes. Centralized so SDK-shape changes update one place.
 */
export const stream = {
  textDelta: (text: string): AgentStreamEvent =>
    ({
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text },
    }) as unknown as AgentStreamEvent,

  reasoningDelta: (text: string): AgentStreamEvent =>
    ({
      type: "modelContentBlockDeltaEvent",
      delta: { type: "reasoningContentDelta", text },
    }) as unknown as AgentStreamEvent,

  reasoningRedacted: (redactedContent: Uint8Array): AgentStreamEvent =>
    ({
      type: "modelContentBlockDeltaEvent",
      delta: { type: "reasoningContentDelta", redactedContent },
    }) as unknown as AgentStreamEvent,

  toolUseStart: (toolUseId: string, name: string): AgentStreamEvent =>
    ({
      type: "modelContentBlockStartEvent",
      start: { type: "toolUseStart", toolUseId, name },
    }) as unknown as AgentStreamEvent,

  toolUseDelta: (input: string): AgentStreamEvent =>
    ({
      type: "modelContentBlockDeltaEvent",
      delta: { type: "toolUseInputDelta", input },
    }) as unknown as AgentStreamEvent,

  blockStop: (): AgentStreamEvent =>
    ({ type: "modelContentBlockStopEvent" }) as unknown as AgentStreamEvent,

  beforeNode: (nodeId: string, nodeType = "agent"): AgentStreamEvent =>
    ({
      type: "beforeNodeCallEvent",
      nodeId,
      nodeType,
    }) as unknown as AgentStreamEvent,

  afterNode: (nodeId: string, nodeType = "agent"): AgentStreamEvent =>
    ({
      type: "afterNodeCallEvent",
      nodeId,
      nodeType,
    }) as unknown as AgentStreamEvent,

  handoff: (
    source: string,
    targets: string[],
    message?: string,
  ): AgentStreamEvent =>
    ({
      type: "multiAgentHandoffEvent",
      source,
      targets,
      message,
    }) as unknown as AgentStreamEvent,
};

// ---------------------------------------------------------------------------
// Real-SDK drivers
// ---------------------------------------------------------------------------
//
// `scriptedAgent` above hands the adapter a hand-rolled literal, so the real
// Strands agent loop never runs and anything the adapter relies on the SDK to
// do (construction, tool registration, seeding, the interrupt machinery) is
// assumed rather than exercised. The drivers below instead subclass the real
// `Model` and let the real `Agent` run, mirroring the Python suite's
// `_ScriptedModel`: only the network boundary is scripted.

/**
 * Ends the turn without emitting a content block, so an under-scripted run
 * terminates without fabricating text or tool content. The SDK still records
 * an empty assistant message for the turn, so a test that cares how many turns
 * ran should assert on `ScriptedModel.calls`.
 */
const END_TURN_ONLY = [
  { type: "modelMessageStartEvent", role: "assistant" },
  { type: "modelMessageStopEvent", stopReason: "endTurn" },
] as ModelStreamEvent[];

/**
 * A real `Model` whose `stream()` replays scripted, provider-shaped chunks.
 * Because it subclasses the SDK's `Model`, the inherited `streamAggregated()`
 * does the genuine block/message aggregation the agent loop consumes.
 *
 * One instance backs every per-thread agent the adapter clones, so `calls` is
 * a single cursor over `turns` shared across threads rather than a per-thread
 * count. A multi-thread test therefore scripts one turn per expected model
 * call, in the order the threads will reach the model.
 */
export class ScriptedModel extends Model {
  /** Number of turns the agent has driven, used to index the script. */
  public calls = 0;

  private readonly config: Record<string, unknown> = {
    modelId: "scripted-model",
  };

  constructor(
    private readonly turns: ModelStreamEvent[][] = [],
    /** 1-based invocation that should fail, modelling a provider error. */
    private readonly throwOnCall?: number,
  ) {
    super();
  }

  getConfig() {
    return { ...this.config };
  }

  // Required by the abstract base. The adapter never calls it, so there is
  // nothing here for a test to observe.
  updateConfig(modelConfig: Record<string, unknown>) {
    Object.assign(this.config, modelConfig);
  }

  async *stream(_messages: StrandsMessage[]): AsyncIterable<ModelStreamEvent> {
    if (this.throwOnCall !== undefined && this.calls + 1 === this.throwOnCall) {
      this.calls += 1;
      throw new Error("scripted provider failure");
    }
    // Past the end of the script, end the turn with no content block so a run
    // whose tool results come back terminates instead of replaying the last
    // turn. See END_TURN_ONLY: this is silent by design, so assert on `calls`
    // when the number of turns is part of what a test is pinning.
    const turn = this.turns[this.calls] ?? END_TURN_ONLY;
    this.calls += 1;
    for (const event of turn) yield event;
  }
}

/**
 * Provider-shaped chunk sequences for one model turn. `stopReason` values must
 * use the SDK's camelCase spellings: the agent loop exits on
 * `stopReason !== "toolUse"`, so a snake_case `"tool_use"` silently ends the
 * turn and the tool never runs.
 */
export const modelTurn = {
  text: (text: string): ModelStreamEvent[] =>
    [
      { type: "modelMessageStartEvent", role: "assistant" },
      { type: "modelContentBlockStartEvent" },
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text },
      },
      { type: "modelContentBlockStopEvent" },
      { type: "modelMessageStopEvent", stopReason: "endTurn" },
    ] as ModelStreamEvent[],

  /** One assistant turn calling `calls` in parallel, ending with `toolUse`. */
  toolUse: (
    ...calls: { toolUseId: string; name: string; input?: unknown }[]
  ): ModelStreamEvent[] =>
    [
      { type: "modelMessageStartEvent", role: "assistant" },
      ...calls.flatMap((c) => [
        {
          type: "modelContentBlockStartEvent",
          start: { type: "toolUseStart", toolUseId: c.toolUseId, name: c.name },
        },
        {
          type: "modelContentBlockDeltaEvent",
          delta: {
            type: "toolUseInputDelta",
            input: JSON.stringify(c.input ?? {}),
          },
        },
        { type: "modelContentBlockStopEvent" },
      ]),
      { type: "modelMessageStopEvent", stopReason: "toolUse" },
    ] as ModelStreamEvent[],

  /** Assistant text followed, in the same turn, by tool calls. */
  textThenToolUse: (
    text: string,
    ...calls: { toolUseId: string; name: string; input?: unknown }[]
  ): ModelStreamEvent[] =>
    [
      { type: "modelMessageStartEvent", role: "assistant" },
      { type: "modelContentBlockStartEvent" },
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text },
      },
      { type: "modelContentBlockStopEvent" },
      ...calls.flatMap((c) => [
        {
          type: "modelContentBlockStartEvent",
          start: { type: "toolUseStart", toolUseId: c.toolUseId, name: c.name },
        },
        {
          type: "modelContentBlockDeltaEvent",
          delta: {
            type: "toolUseInputDelta",
            input: JSON.stringify(c.input ?? {}),
          },
        },
        { type: "modelContentBlockStopEvent" },
      ]),
      { type: "modelMessageStopEvent", stopReason: "toolUse" },
    ] as ModelStreamEvent[],
};

/** A real SDK tool that records every execution, so denial is observable. */
export function recordingTool(name: string, description = "d") {
  const calls: unknown[] = [];
  const instance = tool({
    name,
    description,
    inputSchema: z.object({}).passthrough(),
    callback: async (input: unknown) => {
      calls.push(input);
      // A JSON-serializable result: a bare string makes the adapter log a
      // parse failure for what is a successful call.
      return { ran: name };
    },
  });
  return { tool: instance, calls };
}

/**
 * Build a `StrandsAgent` over a real `Agent` driven by a `ScriptedModel`.
 * Deliberately does NOT pre-seed `_agentsByThread`: the per-thread agent is
 * constructed, tool-synced and seeded by the adapter itself, so those paths
 * are under test rather than skipped.
 */
export function realStrandsAgent(
  turns: ModelStreamEvent[][] = [],
  options: {
    config?: StrandsAgentConfig;
    name?: string;
    tools?: unknown[];
    systemPrompt?: string;
    /** 1-based model invocation that should fail. */
    throwOnCall?: number;
  } = {},
): { agent: StrandsAgent; model: ScriptedModel; template: StrandsAgentCore } {
  const model = new ScriptedModel(turns, options.throwOnCall);
  const template = new StrandsAgentCore({
    model,
    tools: (options.tools ?? []) as never,
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
  });
  const agent = new StrandsAgent({
    agent: template,
    name: options.name ?? "test",
    config: options.config,
  });
  return { agent, model, template };
}

/** The real per-thread `Agent` the adapter built for `threadId`, if any. */
export function threadAgent(
  agent: StrandsAgent,
  threadId = "thread-1",
): StrandsAgentCore | undefined {
  return (
    agent as unknown as { _agentsByThread: Map<string, StrandsAgentCore> }
  )._agentsByThread.get(threadId);
}

const WRAPPED = Symbol("captureStreamArgs.wrapped");

/**
 * Record the arguments the adapter passes to the real per-thread agent's
 * `stream()`, delegating to the real implementation so behaviour is unchanged.
 * Lets a test assert the Strands-facing wire shape without replacing the agent.
 * Returns the full argument list of each call plus a `restore()` that unwraps.
 */
export function captureStreamArgs(
  agent: StrandsAgent,
  threadId = "thread-1",
): { calls: unknown[][]; restore: () => void } {
  const core = threadAgent(agent, threadId);
  if (!core) throw new Error(`no per-thread agent for "${threadId}"`);
  const target = core as unknown as Record<string | symbol, unknown>;
  // Stacking wrappers would double-count every later call.
  if (target[WRAPPED]) {
    throw new Error(`stream() is already captured for thread "${threadId}"`);
  }
  const calls: unknown[][] = [];
  const original = core.stream.bind(core) as (...a: unknown[]) => unknown;
  const wrapper = (...args: unknown[]) => {
    calls.push(args);
    return original(...args);
  };
  target[WRAPPED] = true;
  target.stream = wrapper;
  return {
    calls,
    restore: () => {
      // Delete rather than reassign: leaving a bound own property would keep
      // shadowing the prototype method the agent would otherwise use.
      delete target.stream;
      delete target[WRAPPED];
    },
  };
}

// ---------------------------------------------------------------------------
// Event assertions
// ---------------------------------------------------------------------------
//
// Shared so that a run which failed, or never produced the event under
// inspection, cannot satisfy an assertion about what it produced. Each helper
// fails loudly on an absent subject rather than holding vacuously, which is
// the failure mode these tests exist to remove. Prefer these over reaching
// into an event array directly.

/** An assistant message as it appears in a MESSAGES_SNAPSHOT. */
export type SnapshotMessage = {
  id: string;
  role: string;
  content?: string;
  toolCalls?: { id: string }[];
};

export type FinishedEvent = BaseEvent & {
  outcome?: {
    type?: string;
    interrupts?: {
      id: string;
      reason?: string;
      message?: string;
      toolCallId?: string;
      responseSchema?: unknown;
      metadata?: {
        strandsName?: string;
        tool_name?: string;
        tool_input?: unknown;
        reason?: unknown;
      };
    }[];
  };
};

export type ToolStartEvent = BaseEvent & {
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
};

/** RUN_ERROR codes in emission order, empty when the run raised none. */
export function errorCodes(events: BaseEvent[]): string[] {
  return events
    .filter((e) => e.type === EventType.RUN_ERROR)
    .map((e) => {
      const err = e as BaseEvent & { code?: string; message?: string };
      // A code-less RUN_ERROR would otherwise render as null and read like no
      // error at all in a failure message.
      return err.code ?? `<no code: ${err.message ?? "unknown"}>`;
    });
}

/** Assert the run raised no error, reporting the codes when it did. */
export function expectNoRunError(events: BaseEvent[], label = "run"): void {
  const codes = errorCodes(events);
  expect(codes, `${label} emitted RUN_ERROR ${JSON.stringify(codes)}`).toEqual(
    [],
  );
}

/**
 * Assert the run ran to completion: no error, and not suspended. An interrupt
 * also emits RUN_FINISHED, so the outcome check is what separates a completed
 * run from one parked waiting on a resume.
 */
export function expectCompletedRun(events: BaseEvent[], label = "run"): void {
  expectNoRunError(events, label);
  expect(
    events.map((e) => e.type),
    `${label} produced no RUN_FINISHED`,
  ).toContain(EventType.RUN_FINISHED);
  expect(
    finishedOf(events).outcome?.type,
    `${label} suspended on an interrupt instead of completing`,
  ).not.toBe("interrupt");
}

/**
 * The run's RUN_FINISHED, failing readably when there is none. Asserts there
 * is exactly one: these helpers describe a single `collect()` of one run, and
 * silently taking the first would describe the wrong run in a stream carrying
 * several.
 */
export function finishedOf(events: BaseEvent[]): FinishedEvent {
  const finished = events.filter(
    (e) => e.type === EventType.RUN_FINISHED,
  ) as FinishedEvent[];
  expect(
    finished,
    `expected exactly one RUN_FINISHED, got ${finished.length}`,
  ).toHaveLength(1);
  return finished[0];
}

/** The interrupts the run reported, failing when it reported none. */
export function interruptsOf(
  events: BaseEvent[],
  expected = 1,
): NonNullable<NonNullable<FinishedEvent["outcome"]>["interrupts"]> {
  const finished = finishedOf(events);
  expect(finished.outcome?.type, "run did not finish with an interrupt").toBe(
    "interrupt",
  );
  const interrupts = finished.outcome?.interrupts ?? [];
  expect(
    interrupts,
    `expected ${expected} open interrupt(s), got ${JSON.stringify(
      interrupts.map((i) => i.id),
    )}`,
  ).toHaveLength(expected);
  return interrupts;
}

/** The id of the run's single interrupt. */
export function soleInterruptId(events: BaseEvent[]): string {
  return interruptsOf(events)[0].id;
}

/** TOOL_CALL_START events, asserting how many the run should have produced. */
export function toolStartsOf(
  events: BaseEvent[],
  expected?: number,
): ToolStartEvent[] {
  const starts = events.filter(
    (e) => e.type === EventType.TOOL_CALL_START,
  ) as ToolStartEvent[];
  if (expected !== undefined) {
    expect(
      starts,
      `expected ${expected} TOOL_CALL_START event(s), got ${starts.length}`,
    ).toHaveLength(expected);
  } else {
    expect(starts.length, "no TOOL_CALL_START emitted").toBeGreaterThan(0);
  }
  return starts;
}

/** Every MESSAGES_SNAPSHOT the run emitted, asserting at least one. */
export function snapshotsOf(
  events: BaseEvent[],
): { messages: SnapshotMessage[] }[] {
  const snapshots = events.filter(
    (e) => e.type === EventType.MESSAGES_SNAPSHOT,
  ) as unknown as { messages: SnapshotMessage[] }[];
  expect(snapshots.length, "no MESSAGES_SNAPSHOT emitted").toBeGreaterThan(0);
  return snapshots;
}
