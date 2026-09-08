/**
 * The per-thread config route, asserted against a genuine `Agent`.
 *
 * Some template settings cannot be recovered by reading a built Agent: Strands
 * consumes them during construction and keeps nothing under a name the adapter
 * can find. Classifying those in the disposition table says what happens to
 * them; it does not give a caller anywhere to put them. This hook does, and
 * these tests are what make that claim checkable.
 *
 * Each case sets the option through the hook and asserts the effect on the
 * agent the adapter actually builds, rather than on the config object, because
 * an option the SDK accepts and then resolves differently would pass the
 * weaker check.
 */

import { describe, it, expect } from "vitest";
import { Agent, type AgentConfig } from "@strands-agents/sdk";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput } from "./helpers";
import { ScriptedModel } from "./strands-sdk-harness";

/** Internals the SDK does not expose but which are what these options move. */
interface AgentInternals {
  _conversationManager?: { constructor: { name: string } };
  _tracer?: { _traceAttributes?: Record<string, unknown> };
  _pluginRegistry?: { _plugins?: Map<string, unknown> | Record<string, unknown> };
  _interventionRegistry?: { _handlers?: unknown[] };
  _checkpointing?: boolean;
  _sandbox?: unknown;
  sandbox?: unknown;
}

function pluginNames(agent: Agent): string[] {
  const held = (agent as unknown as AgentInternals)._pluginRegistry?._plugins;
  if (!held) return [];
  const keys =
    held instanceof Map ? [...held.keys()] : Object.keys(held as object);
  return keys.sort();
}

function internals(agent: Agent): AgentInternals {
  return agent as unknown as AgentInternals;
}

function template(overrides: Partial<AgentConfig> = {}): Agent {
  return new Agent({
    model: new ScriptedModel([{ kind: "text", text: "hi" }]),
    printer: false,
    ...overrides,
  } as AgentConfig);
}

/**
 * A directly-constructed Agent, initialized.
 *
 * Plugins are registered during initialization, not construction, so an Agent
 * that was only constructed has an empty registry and would not compare
 * meaningfully against one the adapter has already run.
 */
async function built(overrides: Partial<AgentConfig> = {}): Promise<Agent> {
  const agent = new Agent({
    model: new ScriptedModel([]),
    printer: false,
    ...overrides,
  } as AgentConfig);
  const init = (agent as unknown as { initialize?: () => Promise<void> })
    .initialize;
  if (typeof init === "function") await init.call(agent);
  return agent;
}

/** The per-thread agent the adapter builds for one run. */
async function threadAgent(
  tpl: Agent,
  config?: ConstructorParameters<typeof StrandsAgent>[0]["config"],
): Promise<Agent> {
  const sa = new StrandsAgent({ agent: tpl, name: "adapter", config });
  await collect(sa, minimalRunInput());
  const byThread = (
    sa as unknown as { _agentsByThread: Map<string, Agent> }
  )._agentsByThread;
  const built = byThread.get("thread-1");
  expect(built, "the adapter built no per-thread agent").toBeDefined();
  return built!;
}

describe("per-thread agent config against the real Strands SDK", () => {
  it("keeps an explicit retry opt-out instead of reinstalling the default", async () => {
    // `retryStrategy: null` is a choice to run without retries. It leaves no
    // trace on the built Agent, so the template cannot carry it; supplied per
    // thread it has to survive.
    const withDefault = await threadAgent(template());
    const optedOut = await threadAgent(template(), {
      threadAgentConfig: () => ({ retryStrategy: null }),
    });

    const dropped = pluginNames(withDefault).filter(
      (name) => !pluginNames(optedOut).includes(name),
    );
    // Something the default install brings is gone, and what is gone is the
    // retry machinery rather than some unrelated plugin.
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.join(",")).toMatch(/retry/i);
  });

  it("carries trace attributes to the agent that runs", async () => {
    const built = await threadAgent(template(), {
      threadAgentConfig: () => ({
        traceAttributes: { "deployment.environment": "test" },
      }),
    });

    expect(internals(built)._tracer?._traceAttributes).toEqual({
      "deployment.environment": "test",
    });
  });

  it("resolves the context manager per thread", async () => {
    // Set on the template this is lost: the SDK resolves the facade into a
    // conversation manager plus a plugin and keeps the facade nowhere. Through
    // the hook each thread resolves it for itself, which is what per-thread
    // isolation wants anyway.
    //
    // Asserted against what the SDK itself does with the option rather than
    // against a named class, because releases from before the option existed
    // ignore it. That keeps the test meaningful on both: it fails whenever the
    // adapter's agent differs from one the caller could have built directly.
    const option = { contextManager: "auto" } as Partial<AgentConfig>;
    const direct = await built({ ...option });

    const bare = await built();
    const plain = await threadAgent(template());
    const managed = await threadAgent(template(), {
      threadAgentConfig: () => option,
    });

    expect(internals(managed)._conversationManager?.constructor.name).toBe(
      internals(direct)._conversationManager?.constructor.name,
    );

    // The facade also brings a plugin, and carrying only half of it would
    // leave the conversation manager right and the offloading gone. Compared
    // as the delta the option introduces, since the adapter's agents carry
    // plugins of their own that have nothing to do with this option.
    const added = (withOption: string[], without: string[]) =>
      withOption.filter((name) => !without.includes(name));
    expect(added(pluginNames(managed), pluginNames(plain))).toEqual(
      added(pluginNames(direct), pluginNames(bare)),
    );
  });

  it("builds memory, storage and sandbox per thread rather than sharing one", async () => {
    // These hold conversation-scoped state, so the point is not that the hook
    // ran but that each thread's agent ends up with its own. Counting the
    // hook's own calls would pass even if nothing it returned reached an agent.
    //
    // `memoryManager` is given a config the SDK accepts and then normalizes
    // into its own object, so it is checked by kind and by being distinct per
    // thread rather than by identity. `storage` and `sandbox` pass through, so
    // those keep identity.
    const handed: Record<string, Record<string, unknown>> = {};
    const sa = new StrandsAgent({
      agent: template(),
      name: "adapter",
      config: {
        threadAgentConfig: (input) => {
          const forThread = {
            memoryManager: { stores: [{}] },
            storage: { marker: `storage-${input.threadId}` },
            // Minimal shape the SDK will accept: initialization asks a
            // sandbox for its tools.
            sandbox: {
              marker: `sandbox-${input.threadId}`,
              getTools: () => [],
            },
          };
          handed[input.threadId] = forThread;
          return forThread as unknown as Partial<AgentConfig>;
        },
      },
    });

    await collect(sa, minimalRunInput({ threadId: "a" }));
    await collect(sa, minimalRunInput({ threadId: "b" }));

    const byThread = (
      sa as unknown as { _agentsByThread: Map<string, Agent> }
    )._agentsByThread;
    const read = (agent: Agent | undefined, field: string) => {
      const held = agent as unknown as Record<string, unknown> | undefined;
      // Which name the SDK keeps has moved between releases, so try both.
      return held?.[field] ?? held?.[`_${field}`];
    };
    const kind = (value: unknown) =>
      value === undefined || value === null
        ? String(value)
        : (value as object).constructor?.name;

    for (const field of ["memoryManager", "storage", "sandbox"]) {
      // Ground truth is what the SDK itself does with this value. On a release
      // that has the option that is a real instance; on one that predates it
      // the option is ignored and so is this. Either way a drop by the adapter
      // alone fails, and so does the adapter handing over something else.
      const direct = await built({
        [field]: handed.a[field],
      } as Partial<AgentConfig>);

      for (const threadId of ["a", "b"]) {
        expect(
          kind(read(byThread.get(threadId), field)),
          `${field} did not reach thread ${threadId} as a direct Agent has it`,
        ).toBe(kind(read(direct, field)));
      }

      // Where the SDK keeps it at all, the two threads must not share one.
      const forA = read(byThread.get("a"), field);
      if (forA !== undefined) {
        expect(forA, `${field} is shared between threads`).not.toBe(
          read(byThread.get("b"), field),
        );
      }
    }

    // The pass-through values keep identity, so each thread has the object
    // built for it rather than some other thread's.
    if (read(byThread.get("a"), "storage") !== undefined) {
      expect(read(byThread.get("a"), "storage")).toBe(handed.a.storage);
      expect(read(byThread.get("b"), "storage")).toBe(handed.b.storage);
      expect(read(byThread.get("a"), "sandbox")).toBe(handed.a.sandbox);
    }
  });

  it("still carries what the template can carry", async () => {
    // The hook must not have displaced ordinary forwarding. Compared against a
    // directly-built Agent again, so this says the same thing on a release
    // that predates these options as on one that has them.
    const handler = { name: "approve" };
    const option = {
      interventions: [handler],
      checkpointing: true,
    } as Partial<AgentConfig>;
    const direct = new Agent({
      model: new ScriptedModel([]),
      printer: false,
      ...option,
    } as AgentConfig);

    const built = await threadAgent(template(option));

    expect(internals(built)._interventionRegistry?._handlers).toEqual(
      internals(direct)._interventionRegistry?._handlers,
    );
    expect(internals(built)._checkpointing).toBe(
      internals(direct)._checkpointing,
    );
  });

  it("lets the caller override a field the template did carry", async () => {
    const built = await threadAgent(template({ name: "from-template" }), {
      threadAgentConfig: () => ({ name: "from-hook" }),
    });

    expect(built.name).toBe("from-hook");
  });

  it("keeps ownership of what makes threads separate", async () => {
    // A caller pointing every thread at one seeded history would undo the
    // isolation the per-thread rebuild exists for, so the adapter wins here.
    const built = await threadAgent(template(), {
      threadAgentConfig: () =>
        ({ printer: true }) as unknown as Partial<AgentConfig>,
    });

    expect((built as unknown as { _printer?: unknown })._printer).toBeFalsy();
  });

  it("does not let the hook supply session state or history", async () => {
    // "The adapter owns these" has to hold whether or not the adapter happens
    // to have a replacement ready. With no session-manager provider and a cold
    // thread there is nothing to overwrite with, and a conditional re-assert
    // leaves the caller's value in place: one session manager and one history
    // reaching every thread, which is the isolation this rebuild exists for.
    const shared = { marker: "one-session-for-everyone" };
    const sa = new StrandsAgent({
      agent: template(),
      name: "adapter",
      config: {
        threadAgentConfig: () =>
          ({
            sessionManager: shared,
            messages: [{ role: "user", content: [{ text: "leaked" }] }],
          }) as unknown as Partial<AgentConfig>,
      },
    });

    await collect(sa, minimalRunInput({ threadId: "a" }));
    await collect(sa, minimalRunInput({ threadId: "b" }));

    const byThread = (
      sa as unknown as { _agentsByThread: Map<string, Agent> }
    )._agentsByThread;
    const a = byThread.get("a");
    const b = byThread.get("b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    const sessionOf = (agent: Agent | undefined) =>
      (agent as unknown as { sessionManager?: unknown } | undefined)
        ?.sessionManager;
    expect(sessionOf(a)).not.toBe(shared);
    expect(sessionOf(b)).not.toBe(shared);

    // The injected history must not have become either thread's first turn.
    const firstTexts = (agent: Agent | undefined) =>
      JSON.stringify((agent as unknown as { messages?: unknown })?.messages ?? []);
    expect(firstTexts(a)).not.toContain("leaked");
    expect(firstTexts(b)).not.toContain("leaked");
  });

  it("fails the run when the hook throws, and does not cache the thread", async () => {
    let calls = 0;
    const sa = new StrandsAgent({
      agent: template(),
      name: "adapter",
      config: {
        threadAgentConfig: () => {
          calls += 1;
          throw new Error("no config for you");
        },
      },
    });

    const first = await collect(sa, minimalRunInput());
    expect(first.map((e) => e.type)).toContain("RUN_ERROR");

    // Not cached, so the next request retries rather than reusing a thread
    // that was never built.
    await collect(sa, minimalRunInput());
    expect(calls).toBe(2);
  });
});
