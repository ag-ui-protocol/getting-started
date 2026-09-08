/**
 * Every forwardable field on the template Agent must reach the per-thread
 * AgentConfig. Mirrors Python's `_extract_agent_kwargs`.
 */

import { describe, it, expect, vi } from "vitest";
import type { AgentConfig, Plugin } from "@strands-agents/sdk";
import { StrandsAgent } from "../agent";
import { collect, minimalRunInput } from "./helpers";

const capturedConfigs: AgentConfig[] = [];

vi.mock("@strands-agents/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@strands-agents/sdk")>();
  class MockAgent {
    model: unknown;
    tools: unknown[] = [];
    systemPrompt?: unknown;
    name?: string;
    description?: string;
    id?: string;
    toolRegistry = {
      _tools: new Map<string, unknown>(),
      add(t: unknown) {
        this._tools.set((t as { name: string }).name, t);
      },
      getByName(name: string) {
        return this._tools.get(name);
      },
      get(name: string) {
        return this._tools.get(name);
      },
      removeByName(name: string) {
        this._tools.delete(name);
      },
      remove() {},
      values() {
        return Array.from(this._tools.values());
      },
    };
    constructor(cfg?: AgentConfig) {
      if (cfg) {
        capturedConfigs.push(cfg);
        this.model = cfg.model;
        this.tools = (cfg.tools as unknown[]) ?? [];
        if (cfg.systemPrompt !== undefined)
          this.systemPrompt = cfg.systemPrompt;
        if (cfg.name !== undefined) this.name = cfg.name;
        if (cfg.description !== undefined) this.description = cfg.description;
        if (cfg.id !== undefined) this.id = cfg.id;
      }
    }
    // eslint-disable-next-line require-yield
    async *stream() {}
  }
  return { ...actual, Agent: MockAgent };
});

/** Build a template Agent stub populated with every forwardable field. */
function richTemplate(): import("@strands-agents/sdk").Agent {
  return {
    model: { name: "template-model" },
    tools: [],
    systemPrompt: "you are helpful",
    name: "my-template-agent",
    description: "a wizard",
    id: "wizard-001",
    appState: {
      getAll: () => ({ seed: 42, region: "us-west-2" }),
    },
    modelState: {
      getAll: () => ({ responseId: "abc" }),
    },
    traceAttributes: { team: "agui" },
    structuredOutputSchema: { type: "zod-placeholder" },
    toolExecutor: "concurrent",
    toolRegistry: {
      _tools: new Map(),
      add: () => {},
      getByName: () => undefined,
      get: () => undefined,
      removeByName: () => {},
      remove: () => {},
      values: () => [],
    },
  } as unknown as import("@strands-agents/sdk").Agent;
}

describe("AgentConfig forwarding", () => {
  it("forwards name, description, id to every per-thread AgentConfig", async () => {
    capturedConfigs.length = 0;
    const sa = new StrandsAgent({ agent: richTemplate(), name: "agui-name" });
    await collect(sa);
    const cfg = capturedConfigs.at(-1)!;
    expect(cfg.name).toBe("my-template-agent");
    expect(cfg.description).toBe("a wizard");
    expect(cfg.id).toBe("wizard-001");
  });

  it("forwards appState and modelState as plain dicts", async () => {
    capturedConfigs.length = 0;
    const sa = new StrandsAgent({ agent: richTemplate(), name: "t" });
    await collect(sa);
    const cfg = capturedConfigs.at(-1)!;
    expect(cfg.appState).toEqual({ seed: 42, region: "us-west-2" });
    expect(cfg.modelState).toEqual({ responseId: "abc" });
  });

  it("forwards toolExecutor but not structuredOutputSchema or traceAttributes", async () => {
    capturedConfigs.length = 0;
    const sa = new StrandsAgent({ agent: richTemplate(), name: "t" });
    await collect(sa);
    const cfg = capturedConfigs.at(-1)!;
    expect(cfg.toolExecutor).toBe("concurrent");
    // structuredOutputSchema is deliberately left behind. Carrying it makes
    // Strands inject its structured-output tool, which this adapter streams to
    // the client as a visible tool call and which fails a plain text turn when
    // the model does not call it. A real Agent keeps the schema under a
    // private name that the previous field list never read, so it has never
    // reached a per-thread agent in practice; this pins that.
    expect(cfg.structuredOutputSchema).toBeUndefined();
    // traceAttributes goes to the tracer the Agent builds, and the Agent keeps
    // nothing under this name. Recovering it meant matching a name against
    // whatever objects the Agent held, which found coincidences too, so it is
    // declared unsupported rather than guessed at.
    expect(cfg.traceAttributes).toBeUndefined();
  });

  it("warns about template settings it will not carry", async () => {
    // The point of declaring a field unsupported is that the caller finds out.
    // This template sets several of them plainly, so each is readable and
    // therefore demonstrably chosen rather than an SDK default.
    //
    // Said when the first per-thread agent is built, not at construction: a
    // caller can supply any of these through threadAgentConfig, and at
    // construction that hook has not run, so warning then would nag callers
    // who had already handled it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sa = new StrandsAgent({ agent: richTemplate(), name: "t" });
      expect(warn).not.toHaveBeenCalled();

      await collect(sa);

      const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toContain("traceAttributes");
      expect(said).toContain("structuredOutputSchema");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet about a setting the per-thread hook supplies", async () => {
    // Acting on the warning has to make it stop, otherwise it is noise that
    // teaches callers to ignore it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sa = new StrandsAgent({
        agent: richTemplate(),
        name: "t",
        config: {
          threadAgentConfig: () =>
            ({ traceAttributes: { team: "agui" } }) as never,
        },
      });
      await collect(sa);

      const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).not.toContain("traceAttributes");
      // The one it did not supply is still named.
      expect(said).toContain("structuredOutputSchema");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns a later thread that omits what an earlier thread supplied", async () => {
    // The report is one-shot so a busy adapter does not repeat itself, but
    // one-shot has to mean per setting, not per adapter. A thread that
    // supplies everything must not buy silence for a thread that supplies
    // nothing: the second thread really does lose those settings.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sa = new StrandsAgent({
        agent: richTemplate(),
        name: "t",
        config: {
          threadAgentConfig: (input) =>
            input.threadId === "supplies-everything"
              ? ({
                  traceAttributes: { team: "agui" },
                  structuredOutputSchema: { type: "zod-placeholder" },
                } as never)
              : ({} as never),
        },
      });

      await collect(sa, minimalRunInput({ threadId: "supplies-everything" }));
      const afterFirst = warn.mock.calls.length;
      await collect(sa, minimalRunInput({ threadId: "supplies-nothing" }));

      const said = warn.mock.calls
        .slice(afterFirst)
        .map((c) => String(c[0]))
        .join("\n");
      expect(said).toContain("traceAttributes");
      expect(said).toContain("structuredOutputSchema");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not repeat a warning it has already given", async () => {
    // The other half of one-shot: two threads that both omit the same setting
    // are told once, not once each.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sa = new StrandsAgent({ agent: richTemplate(), name: "t" });

      await collect(sa, minimalRunInput({ threadId: "first" }));
      const afterFirst = warn.mock.calls.length;
      await collect(sa, minimalRunInput({ threadId: "second" }));

      expect(warn.mock.calls.length).toBe(afterFirst);
    } finally {
      warn.mockRestore();
    }
  });

  it("omits optional fields entirely when the template doesn't set them", async () => {
    capturedConfigs.length = 0;
    // Bare template with only the mandatory fields.
    const bare = {
      model: { name: "m" },
      tools: [],
      toolRegistry: {
        _tools: new Map(),
        add: () => {},
        getByName: () => undefined,
        get: () => undefined,
        removeByName: () => {},
        remove: () => {},
        values: () => [],
      },
    } as unknown as import("@strands-agents/sdk").Agent;
    const sa = new StrandsAgent({ agent: bare, name: "t" });
    await collect(sa);
    const cfg = capturedConfigs.at(-1)!;
    expect("systemPrompt" in cfg).toBe(false);
    expect("name" in cfg).toBe(false);
    expect("description" in cfg).toBe(false);
    // id is always set (falls back to adapter name for stable session paths)
    expect(cfg.id).toBe("t");
    expect("appState" in cfg).toBe(false);
    expect("modelState" in cfg).toBe(false);
    expect("traceAttributes" in cfg).toBe(false);
    expect("structuredOutputSchema" in cfg).toBe(false);
    expect("toolExecutor" in cfg).toBe(false);
  });

  it("explicitly does NOT forward the template's conversationManager (documented exclusion)", async () => {
    capturedConfigs.length = 0;
    const tpl = richTemplate() as unknown as Record<string, unknown>;
    tpl.conversationManager = { name: "sliding-window", initAgent: () => {} };
    const sa = new StrandsAgent({
      agent: tpl as unknown as import("@strands-agents/sdk").Agent,
      name: "t",
    });
    await collect(sa);
    const cfg = capturedConfigs.at(-1)!;
    // conversationManager is NOT in the forwarded config; Strands will
    // construct its default (SlidingWindowConversationManager) per-thread.
    expect("conversationManager" in cfg).toBe(false);
  });

  it("forwards alongside plugins and sessionManager when all are set", async () => {
    capturedConfigs.length = 0;
    const plugin: Plugin = { name: "p", initAgent: () => {} };
    const sa = new StrandsAgent({
      agent: richTemplate(),
      name: "t",
      plugins: [plugin],
    });
    await collect(sa);
    const cfg = capturedConfigs.at(-1)!;
    expect(cfg.name).toBe("my-template-agent");
    expect(cfg.plugins).toEqual([plugin]);
  });

  it("carries a field a newer SDK keeps in a registry", async () => {
    // Fields added after this package was built cannot appear in the
    // compile-time table, so they are classified separately and read at
    // runtime. `interventions` is the one that matters: it turns on native
    // human-in-the-loop, and the SDK consumes it into a registry rather than
    // keeping it under its own name.
    //
    // The template here is hand-built because the locked SDK predates the
    // field; the shape mirrors what a current Agent holds.
    capturedConfigs.length = 0;
    const handler = { name: "approve" };
    const template = {
      ...richTemplate(),
      _interventionRegistry: { _handlers: [handler] },
    } as unknown as import("@strands-agents/sdk").Agent;

    const sa = new StrandsAgent({ agent: template, name: "t" });
    await collect(sa);

    const cfg = capturedConfigs.at(-1)! as AgentConfig & {
      interventions?: unknown[];
    };
    expect(cfg.interventions).toHaveLength(1);
    // The handler object itself, not a copy: the registry holds the caller's
    // own objects and that is what the next agent has to register.
    expect(cfg.interventions?.[0]).toBe(handler);
  });

  it("does not forward plugins found on the template itself", async () => {
    // Plugins reach per-thread agents only through the explicit option above.
    // A template's own plugins are registered against the template alongside
    // Strands' built-ins, and a second Agent refuses to register a built-in
    // twice, so carrying them across breaks construction.
    //
    // A real Agent keeps plugins somewhere this adapter does not read, so the
    // template here exposes them plainly: that is what makes the assertion
    // able to fail if the field is ever reclassified as copyable.
    capturedConfigs.length = 0;
    const plugin: Plugin = { name: "on-template", initAgent: () => {} };
    const template = {
      ...richTemplate(),
      plugins: [plugin],
    } as unknown as import("@strands-agents/sdk").Agent;

    const sa = new StrandsAgent({ agent: template, name: "t" });
    await collect(sa);

    const cfg = capturedConfigs.at(-1)!;
    expect(cfg.plugins).toBeUndefined();
  });

  it("forwards the Model instance, preserving provider-specific config like Bedrock thinking", async () => {
    // Regression: a previous string-coercion path replaced any BedrockModel
    // instance with just `model.modelId`, silently discarding
    // `additionalRequestFields.thinking`, `temperature`, and guardrails. That
    // broke /agentic-chat-reasoning end-to-end (zero REASONING_* events).
    capturedConfigs.length = 0;
    class FakeBedrockModel {
      readonly modelId = "global.anthropic.claude-sonnet-4-6";
      readonly temperature = 1;
      readonly additionalRequestFields = {
        thinking: { type: "enabled", budget_tokens: 2000 },
      };
    }
    Object.defineProperty(FakeBedrockModel, "name", { value: "BedrockModel" });
    const tpl = {
      ...richTemplate(),
      model: new FakeBedrockModel(),
    } as unknown as import("@strands-agents/sdk").Agent;
    const sa = new StrandsAgent({ agent: tpl, name: "t" });
    await collect(sa);
    const cfg = capturedConfigs.at(-1)!;
    expect(cfg.model).toBeInstanceOf(FakeBedrockModel);
    expect(
      (cfg.model as unknown as FakeBedrockModel).additionalRequestFields,
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 2000 },
    });
    expect((cfg.model as unknown as FakeBedrockModel).temperature).toBe(1);
  });
});
