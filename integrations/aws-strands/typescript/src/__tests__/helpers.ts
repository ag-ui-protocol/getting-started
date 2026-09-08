/**
 * Shared test helpers. These mirror the Python test helpers but adapted for
 * the TS Strands SDK's streaming shape.
 */

import {
  Agent as StrandsAgentCore,
  Message as StrandsMessage,
  Model,
  tool,
  type Agent,
  type AgentStreamEvent,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
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
import { AG_UI_FRONTEND_CALL_IDS_STATE_KEY } from "../session-reconcile";

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
    // An inert hook registry, so a stub can take a run that carries
    // `context[]`: the adapter refuses such a run on an agent with no
    // `addHook`, because the context reaches the model only through a hook.
    // Python's `_CapturingCore` carries a real `HookRegistry` for the same
    // reason. Override with `addHook: undefined` to drive the refusal.
    addHook: () => () => {},
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
  return strandsAgentOverStub(scriptedAgent(events, options.stubOverrides), {
    config: options.config,
    name: options.name,
  });
}

/**
 * The same wrapping, over a stub the caller already built.
 *
 * `scriptedStrandsAgent` above builds its own stub and is what most tests
 * want. This is for the tests whose stub has to exist FIRST, because its own
 * `stream()` closes over it to record what reached it. Both go through one
 * place so only one knows the private-field cast that seeds the cache.
 */
export function strandsAgentOverStub(
  stub: Agent,
  options: { config?: StrandsAgentConfig; name?: string } = {},
): StrandsAgent {
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
 * id is parked as a bare unanswered generic interrupt. It is a plain record
 * because that is the only shape the SDK's `InterruptState` serializes and
 * SessionManager restores; parking a `Map` here would send every interrupt test
 * down a branch production never takes.
 */
export function parkInterrupts(
  aguiAgent: StrandsAgent,
  threadId: string,
  recorded: AguiInterrupt[],
  native?: Record<string, unknown>,
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
    Object.fromEntries(
      recorded.map((interrupt) => [
        interrupt.id,
        { id: interrupt.id, name: "need_input" },
      ]),
    );
  // A thread with no agent yet gets a stub honouring the same minimal contract
  // every other double here does. A bare `{}` would stand in for an agent while
  // answering nothing the adapter asks of one.
  const strandsAgent =
    internals._agentsByThread.get(threadId) ??
    scriptedAgent([], { messages: [] });
  internals._agentsByThread.set(threadId, strandsAgent);
  (strandsAgent as { _interruptState?: unknown })._interruptState = {
    activated: Object.keys(interrupts).length > 0,
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
 * A deep copy of one history message, rebuilt through the SDK's own
 * deserializer so the block classes (and the `type` discriminators readers
 * assert on) come back.
 *
 * History holds two shapes: SDK class instances, which report their stored
 * form through `toJSON()`, and the plain objects a data-hydrated restore
 * leaves behind. That plain shape is exactly what the reconciliation
 * recogniser exists to handle, so demanding `toJSON()` here would throw inside
 * the model for the one history a test most needs to drive end to end. A plain
 * message is already in serialized form, so it goes straight to `fromJSON`.
 */
function recordedCopy(message: StrandsMessage): StrandsMessage {
  const data =
    typeof (message as { toJSON?: unknown } | null)?.toJSON === "function"
      ? message.toJSON()
      : (message as unknown as ReturnType<StrandsMessage["toJSON"]>);
  return StrandsMessage.fromJSON(data);
}

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

  /**
   * The history handed to `stream()` on each turn, oldest first. Each entry is
   * a deep copy, so a later turn cannot rewrite an earlier one: reconciliation
   * replaces blocks inside a message's `content` array in place, and an entry
   * that merely aliased those message objects would silently become a record
   * of the corrected history rather than of what the model actually saw.
   */
  public readonly seenMessages: StrandsMessage[][] = [];

  /**
   * The un-copied array `stream()` was handed on each turn. `seenMessages` is
   * a copy by design, which leaves nothing tying it back to what arrived, so
   * this is the identity: a test can prove the message objects it rewrites are
   * the ones the model was actually given, rather than only that some array
   * somewhere changed.
   */
  public readonly handedMessages: StrandsMessage[][] = [];

  /**
   * The tool names offered on each turn, oldest first. What the registry held
   * when the turn started, as the model itself saw it, which is the only place
   * a per-request tool filter is observable from outside the adapter.
   */
  public readonly offeredToolNames: Set<string>[] = [];

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

  async *stream(
    messages: StrandsMessage[],
    options?: { toolSpecs?: { name: string }[] },
  ): AsyncIterable<ModelStreamEvent> {
    this.handedMessages.push(messages);
    this.seenMessages.push(messages.map(recordedCopy));
    this.offeredToolNames.push(
      new Set((options?.toolSpecs ?? []).map((spec) => spec.name)),
    );
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
    /** Forwarded to every per-thread agent, so a hook can edit its state. */
    plugins?: unknown[];
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
    ...(options.plugins ? { plugins: options.plugins as never } : {}),
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
  // What `stream` was before wrapping: a real `Agent` inherits it from the
  // prototype, while a stub carries its own. Deleting unconditionally restores
  // the first correctly and destroys the second.
  const ownStream = Object.getOwnPropertyDescriptor(target, "stream");
  target[WRAPPED] = true;
  target.stream = wrapper;
  return {
    calls,
    restore: () => {
      if (ownStream) Object.defineProperty(target, "stream", ownStream);
      // Delete rather than reassign: leaving a bound own property would keep
      // shadowing the prototype method the agent would otherwise use.
      else delete target.stream;
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

// ---------------------------------------------------------------------------
// Model-facing history readers
// ---------------------------------------------------------------------------
//
// Shared so the fidelity tests that guard these readers guard the readers the
// other suites actually use. A private copy per file leaves the real ones
// unprotected, and a reader that silently returns nothing for a turn the model
// never took makes every negative assertion about that turn vacuous.

/** Every text a reader can reach: top level, and nested in a tool result. */
export function historyTexts(history: readonly StrandsMessage[]): string[] {
  const texts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string") texts.push(value);
  };
  for (const message of history) {
    for (const block of message.content as unknown[]) {
      const record = block as { text?: unknown; content?: unknown };
      push(record.text);
      // A toolResult nests the text one level deeper.
      for (const inner of (record.content ?? []) as unknown[]) {
        push((inner as { text?: unknown }).text);
      }
    }
  }
  return texts;
}

/** Role plus the block discriminators, per message. */
export function historyShape(
  history: readonly StrandsMessage[],
): Array<{ role: string; blocks: string[] }> {
  return history.map((message) => ({
    role: message.role,
    blocks: (message.content as unknown[]).map(
      (block) => (block as { type?: string }).type ?? "unknown",
    ),
  }));
}

/** The history the model recorded on its `call`-th turn, or a loud failure. */
function recordedTurn(
  model: ScriptedModel,
  call: number,
): readonly StrandsMessage[] {
  const turn = model.seenMessages[call];
  expect(
    turn,
    `the model recorded no turn ${call} (it took ${model.seenMessages.length})`,
  ).toBeDefined();
  return turn!;
}

/** Text of every message the model saw on its `call`-th invocation. */
export function modelSawTexts(model: ScriptedModel, call: number): string[] {
  return historyTexts(recordedTurn(model, call));
}

/** The role + block kinds of every message the model saw on a given call. */
export function modelSawShape(
  model: ScriptedModel,
  call: number,
): Array<{ role: string; blocks: string[] }> {
  return historyShape(recordedTurn(model, call));
}

// ---------------------------------------------------------------------------
// Durable recovery assertions
// ---------------------------------------------------------------------------
//
// Whether recovery works after a restart is decided by what the session store
// holds, not by whether a run raised an error: an error code says a request was
// refused, while the store says whether the thread can still go anywhere. So
// the assertion below renders the whole picture at once and compares it in one
// go.

/**
 * One content block of a persisted `toolResult`, in reading form. A block the
 * store carries under another key still compares exactly under `toEqual`; only
 * the two a frontend result can produce are named.
 */
export type PersistedResultContent = { text?: string; json?: unknown };

/** A persisted `toolResult`, exactly as the store holds it. */
export interface PersistedToolResult {
  toolUseId: string;
  status: string;
  content: PersistedResultContent[];
}

/** An interrupt checkpoint, read from the store or from a live agent. */
export interface CheckpointPicture {
  activated: boolean;
  /** Ids of the native interrupts the checkpoint holds. */
  interruptIds: string[];
  /** `toolUseId`s of the tool batch the checkpoint parked, in batch order. */
  parkedToolCallIds: string[];
  /** The results of that batch which had already completed. */
  parkedToolResults: PersistedToolResult[];
}

/**
 * Everything reconciliation writes through, in one shape.
 *
 * Rendered from the store by `durableRecoveryState` and from a live agent's own
 * memory by `memoryPicture`, so the two halves can be compared facet for facet.
 */
export interface StorePicture {
  /** Messages, one label per content block. */
  messages: Array<{ role: string; blocks: string[] }>;
  /** Every `toolResult`, in reading order. */
  toolResults: PersistedToolResult[];
  /** The frontend-call ids still recorded. */
  frontendCallIds: string[];
  checkpoint: CheckpointPicture;
}

/** Everything a restarted process would find, plus the live checkpoint. */
export interface DurableRecoveryState {
  /** null when nothing was persisted at all. */
  store: StorePicture | null;
  /** The checkpoint the live thread agent still holds. */
  live: CheckpointPicture;
}

const idleCheckpoint = (): CheckpointPicture => ({
  activated: false,
  interruptIds: [],
  parkedToolCallIds: [],
  parkedToolResults: [],
});

/** A thread with nothing parked, which is most of them. */
export const IDLE_CHECKPOINT: CheckpointPicture = idleCheckpoint();

/**
 * The `snapshot_latest.json` under `dir`, or undefined when the run wrote
 * none. Located by walking the tree rather than by reconstructing the layout,
 * so a change to the SDK's own path scheme shows up as a missing file rather
 * than as a reader that silently looks in the wrong place.
 */
export function snapshotPathOf(dir: string): string | undefined {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "snapshot_latest.json") found.push(path);
    }
  };
  walk(dir);
  expect(
    found.length,
    `expected at most one snapshot under ${dir}, found ${found.length}`,
  ).toBeLessThan(2);
  return found[0];
}

/** The persisted snapshot's shape, as far as these assertions read it. */
export interface PersistedSnapshot {
  data: {
    messages: unknown[];
    state: Record<string, unknown>;
    interrupts?: unknown;
  };
}

function readSnapshot(dir: string): PersistedSnapshot | undefined {
  const path = snapshotPathOf(dir);
  return path ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

/** The persisted snapshot under `dir`, failing when there is none. */
export function persistedSnapshot(dir: string): PersistedSnapshot {
  const snapshot = readSnapshot(dir);
  expect(snapshot, `no snapshot was persisted under ${dir}`).toBeDefined();
  return snapshot!;
}

/** Every `toolResult` in a persisted snapshot's messages. */
export function persistedToolResults(dir: string): PersistedToolResult[] {
  return toolResultsOf(persistedSnapshot(dir).data.messages);
}

function toolResultsOf(messages: readonly unknown[]): PersistedToolResult[] {
  const out: PersistedToolResult[] = [];
  for (const message of messages) {
    for (const block of ((message as { content?: unknown[] } | null)?.content ??
      []) as unknown[]) {
      // A hole in the content array is skipped rather than read, the way
      // `blockLabels` beside this already tolerates one.
      const wrapped = (block as { toolResult?: unknown } | null)?.toolResult;
      if (wrapped) out.push(wrapped as PersistedToolResult);
    }
  }
  return out;
}

/**
 * One label per content block: enough to read the message back (a text block
 * carries its text, a call its tool and id) without duplicating the exact
 * `toolResult` bodies rendered alongside.
 */
function blockLabels(message: unknown): string[] {
  return (
    ((message as { content?: unknown[] } | null)?.content ?? []) as unknown[]
  ).map((block) => {
    const record = block as Record<string, unknown>;
    if (typeof record?.text === "string") return `text:${record.text}`;
    const use = record?.toolUse as
      | { name?: string; toolUseId?: string }
      | undefined;
    if (use) return `toolUse:${use.name}#${use.toolUseId}`;
    const result = record?.toolResult as { toolUseId?: string } | undefined;
    if (result) return `toolResult:#${result.toolUseId}`;
    return Object.keys(record ?? {})[0] ?? "unknown";
  });
}

/** Render one `InterruptState`, in either the persisted or the live form. */
function checkpointPicture(state: unknown): CheckpointPicture {
  const checkpoint = state as
    | {
        activated?: unknown;
        interrupts?: Record<string, unknown> | Map<string, unknown>;
        pendingToolExecution?: {
          assistantMessageData?: unknown;
          completedToolResults?: Record<string, { toolResult?: unknown }>;
        };
      }
    | undefined;
  if (!checkpoint) return idleCheckpoint();
  const interrupts = checkpoint.interrupts;
  const parked = checkpoint.pendingToolExecution;
  return {
    activated: checkpoint.activated === true,
    interruptIds: [
      ...(interrupts instanceof Map
        ? interrupts.keys()
        : Object.keys(interrupts ?? {})),
    ].sort(),
    parkedToolCallIds: blockLabels(parked?.assistantMessageData)
      .filter((label) => label.startsWith("toolUse:"))
      .map((label) => label.slice(label.indexOf("#") + 1)),
    parkedToolResults: Object.values(parked?.completedToolResults ?? {})
      .map((entry) => entry?.toolResult as PersistedToolResult)
      .filter(Boolean),
  };
}

/** One picture out of a persisted snapshot. */
function snapshotPicture(snapshot: PersistedSnapshot): StorePicture {
  const recorded = snapshot.data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY];
  return {
    messages: snapshot.data.messages.map((message) => ({
      role: (message as { role: string }).role,
      blocks: blockLabels(message),
    })),
    toolResults: toolResultsOf(snapshot.data.messages),
    frontendCallIds: Array.isArray(recorded) ? (recorded as string[]) : [],
    checkpoint: checkpointPicture(snapshot.data.interrupts),
  };
}

/**
 * The checkpoint `agent`'s thread is holding right now.
 *
 * The whole claim a test can make when no session manager was ever wired: with
 * no store behind the run, a "nothing was persisted" assertion holds against
 * any directory at all, while this one still fails if the refusal left the
 * checkpoint standing.
 */
export function liveCheckpoint(
  agent?: StrandsAgent,
  threadId = "thread-1",
): CheckpointPicture {
  return checkpointPicture(
    agent
      ? (
          threadAgent(agent, threadId) as unknown as {
            _interruptState?: unknown;
          }
        )?._interruptState
      : undefined,
  );
}

/** The durable picture `dir` and `agent` add up to. */
export function durableRecoveryState(
  dir: string,
  agent?: StrandsAgent,
  threadId = "thread-1",
): DurableRecoveryState {
  const snapshot = readSnapshot(dir);
  return {
    store: snapshot ? snapshotPicture(snapshot) : null,
    live: liveCheckpoint(agent, threadId),
  };
}

/**
 * Assert the FULL durable picture: the persisted messages, every persisted
 * `toolResult` with its status and content, the recorded frontend-call ids, and
 * the parked checkpoint contents both on disk and on the live agent.
 *
 * `expected` is complete rather than partial on purpose. A test that says only
 * "no error was raised" says nothing about whether the next process can pick
 * the thread up, and every facet omitted from an expectation is a facet a
 * regression can move without failing anything.
 */
export function expectDurableRecovery(
  dir: string,
  agent: StrandsAgent | undefined,
  expected: DurableRecoveryState,
  label = "durable recovery state",
  threadId = "thread-1",
): void {
  expect(durableRecoveryState(dir, agent, threadId), label).toEqual(expected);
}

// ---------------------------------------------------------------------------
// Store versus in-memory agreement
// ---------------------------------------------------------------------------
//
// Reconciliation corrects the live `agent.messages` (and the results a
// checkpoint parks beside them) and then asks the session manager to save a
// snapshot. Those two halves can drift apart: a rejected save leaves the
// correction in memory alone, and a run that continues from it continues from
// state no restart can see. An assertion on either half in isolation cannot
// catch that, so the one below renders both in the SAME shape and compares
// them, and composes with the durable picture above rather than duplicating it.

/** Serialize the way the snapshot writer does, so instances read as data. */
function asStoredData(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** The per-thread agent behind `agent`, which may already be one. */
function coreAgentOf(agent: unknown, threadId: string): unknown {
  const byThread = (agent as { _agentsByThread?: Map<string, unknown> })
    ?._agentsByThread;
  return byThread instanceof Map ? byThread.get(threadId) : agent;
}

/**
 * The picture a snapshot taken right now WOULD carry, read off live memory.
 *
 * Messages go through the same serialization the snapshot writer applies, so a
 * history of SDK class instances renders as the data the store would hold. The
 * checkpoint's parked results get the same treatment; its interrupt ids are
 * passed through unserialized because `checkpointPicture` reads them out of
 * either shape the state can be in, the plain record the SDK holds or the `Map`
 * an older mock used.
 */
export function memoryPicture(
  agent: unknown,
  threadId = "thread-1",
): StorePicture {
  const core = coreAgentOf(agent, threadId) as {
    messages?: unknown[];
    appState?: { get?: (key: string) => unknown };
    _interruptState?: {
      activated?: unknown;
      interrupts?: unknown;
      pendingToolExecution?: unknown;
    };
  };
  const messages = (asStoredData(core?.messages ?? []) ?? []) as unknown[];
  const recorded = core?.appState?.get?.(AG_UI_FRONTEND_CALL_IDS_STATE_KEY);
  const interruptState = core?._interruptState;
  return {
    messages: messages.map((message) => ({
      role: (message as { role: string }).role,
      blocks: blockLabels(message),
    })),
    toolResults: toolResultsOf(messages),
    frontendCallIds: Array.isArray(recorded) ? (recorded as string[]) : [],
    checkpoint: checkpointPicture(
      interruptState
        ? {
            ...interruptState,
            pendingToolExecution: asStoredData(
              interruptState.pendingToolExecution,
            ),
          }
        : undefined,
    ),
  };
}

/**
 * Assert that what a reconcile attempt left in memory is what the store holds.
 *
 * `store` is either a storage directory, read the way a restart would read it,
 * or a picture captured at the moment of a snapshot write (which is how a fake
 * session manager stands in for one). Either way a correction that never
 * reached the store, or an id pruned only in memory, fails here.
 */
export function expectStoreMatchesMemory(
  store: string | StorePicture,
  agent: unknown,
  label = "store versus in-memory picture",
  threadId = "thread-1",
): void {
  const expected =
    typeof store === "string"
      ? snapshotPicture(persistedSnapshot(store))
      : store;
  expect(memoryPicture(agent, threadId), label).toEqual(expected);
}
