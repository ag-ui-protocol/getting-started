/**
 * Shared test helpers. These mirror the Python test helpers but adapted for
 * the TS Strands SDK's streaming shape.
 */

import type { Agent, AgentStreamEvent } from "@strands-agents/sdk";
import type {
  BaseEvent,
  Interrupt as AguiInterrupt,
  RunAgentInput,
} from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import type { StrandsAgentConfig } from "../config";

export function minimalRunInput(
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput {
  return {
    threadId: overrides.threadId ?? "thread-1",
    runId: overrides.runId ?? "run-1",
    state: overrides.state ?? {},
    messages: overrides.messages ?? [],
    tools: overrides.tools ?? [],
    context: overrides.context ?? [],
    forwardedProps: overrides.forwardedProps,
    ...overrides,
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
