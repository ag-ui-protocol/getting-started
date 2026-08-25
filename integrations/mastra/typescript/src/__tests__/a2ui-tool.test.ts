import { describe, it, expect, vi, beforeEach } from "vitest";
import type { A2UIAttemptRecord } from "@ag-ui/a2ui-toolkit";

// The render subagent runs through a Mastra `Agent`. Mock it so we control what
// the forced `render_a2ui` call "returns" per recovery attempt: the mock's
// `generate()` invokes the bound render tool's `execute` with the next queued
// args (or nothing, to simulate the model producing no call).
const renderQueue: Array<Record<string, unknown> | null> = [];
const agentRuns: Array<{ instructions: string; messages: unknown }> = [];
vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    instructions: string;
    tools: Record<
      string,
      { execute: (args: unknown, ctx: unknown) => unknown }
    >;
    constructor(cfg: any) {
      this.instructions = cfg.instructions;
      this.tools = cfg.tools;
    }
    async stream(messages: unknown) {
      agentRuns.push({ instructions: this.instructions, messages });
      const args = renderQueue.shift();
      if (args != null) {
        const tool = this.tools[Object.keys(this.tools)[0]];
        await tool.execute(args, {});
      }
      // renderSubagent iterates `.fullStream`; the streamed render deltas go to
      // the writer (not asserted here), so an empty stream is enough.
      return {
        fullStream: (async function* () {})(),
      };
    }
  },
}));

import {
  getA2UITools,
  planA2UIInjection,
  isAutoInjectedA2UITool,
} from "../a2ui-tool";

/** A structurally INVALID render (root child references a missing component). */
const INVALID_COMPONENTS = [
  { id: "root", component: "Column", children: ["missing-metric"] },
];

/** A structurally VALID render (Column + two resolvable Metric children). */
const VALID_COMPONENTS = [
  { id: "root", component: "Column", children: ["m1", "m2"] },
  { id: "m1", component: "Metric", label: "Quarterly Revenue", value: "$4.2M" },
  { id: "m2", component: "Metric", label: "Win Rate", value: "31%" },
];

/** The forced-render args the subagent "produces" for a given component set. */
function renderArgs(components: unknown, data: Record<string, unknown> = {}) {
  return { surfaceId: "recovery-demo", components, data };
}

interface FakeCtx {
  agent?: { messages?: unknown[] };
  requestContext?: { get?: (key: string) => unknown };
}

function makeCtx(
  opts: {
    messages?: unknown[];
    contextEntries?: Array<Record<string, unknown>>;
  } = {},
): FakeCtx {
  return {
    agent: {
      messages: opts.messages ?? [
        { role: "user", content: "make a KPI panel" },
      ],
    },
    requestContext: {
      get: (key: string) =>
        key === "ag-ui" ? { context: opts.contextEntries ?? [] } : undefined,
    },
  };
}

// The tool is `createTool(...)`; call its `execute(input, context)` directly.
// It returns the a2ui_operations / recovery-failure envelope as a PARSED object
// (the Mastra bridge JSON.stringifies it once for the wire).
function runTool(tool: any, input: any, ctx: FakeCtx): Promise<any> {
  return tool.execute(input, ctx);
}

beforeEach(() => {
  renderQueue.length = 0;
  agentRuns.length = 0;
});

describe("getA2UITools (Mastra)", () => {
  it("advertises the canonical generate_a2ui tool by default", () => {
    const tool = getA2UITools({ model: "openai/gpt-4.1" });
    expect(tool.id).toBe("generate_a2ui");
    expect(typeof tool.description).toBe("string");
  });

  it("recovers: invalid first attempt, valid second attempt paints", async () => {
    renderQueue.push(
      renderArgs(INVALID_COMPONENTS),
      renderArgs(VALID_COMPONENTS),
    );

    const attempts: A2UIAttemptRecord[] = [];
    const tool = getA2UITools({
      model: "openai/gpt-4.1",
      defaultCatalogId: "declarative-gen-ui-catalog",
      recovery: { maxAttempts: 3 },
      onA2UIAttempt: (r) => attempts.push(r),
    });

    const envelope = await runTool(tool, { intent: "create" }, makeCtx());

    // A valid surface painted (has ops, carries the Metric + configured catalog).
    expect(Array.isArray(envelope.a2ui_operations)).toBe(true);
    expect(JSON.stringify(envelope)).toContain("Metric");
    expect(JSON.stringify(envelope)).toContain("declarative-gen-ui-catalog");
    expect(envelope.code).toBeUndefined();

    // Exactly two attempts: first invalid, second valid.
    expect(agentRuns).toHaveLength(2);
    expect(attempts.map((a) => a.ok)).toEqual([false, true]);

    // The retry prompt was augmented with the prior attempt's errors.
    expect(agentRuns[1].instructions).toContain("Previous attempt was invalid");
  });

  it("exhausts: every attempt invalid -> structured recovery-exhausted envelope", async () => {
    renderQueue.push(
      renderArgs(INVALID_COMPONENTS),
      renderArgs(INVALID_COMPONENTS),
      renderArgs(INVALID_COMPONENTS),
    );

    const attempts: A2UIAttemptRecord[] = [];
    const tool = getA2UITools({
      model: "openai/gpt-4.1",
      recovery: { maxAttempts: 3 },
      onA2UIAttempt: (r) => attempts.push(r),
    });

    const envelope = await runTool(tool, { intent: "create" }, makeCtx());

    expect(envelope.code).toBe("a2ui_recovery_exhausted");
    expect(agentRuns).toHaveLength(3);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => !a.ok)).toBe(true);
  });

  it("treats a missing render_a2ui call as an invalid attempt", async () => {
    renderQueue.push(null); // model produced no render call
    const tool = getA2UITools({
      model: "openai/gpt-4.1",
      recovery: { maxAttempts: 1 },
    });

    const envelope = await runTool(tool, { intent: "create" }, makeCtx());
    expect(envelope.code).toBe("a2ui_recovery_exhausted");
    expect(agentRuns).toHaveLength(1);
  });

  it("stamps the configured defaultCatalogId (subagent never picks the catalog)", async () => {
    renderQueue.push(renderArgs(VALID_COMPONENTS));
    const tool = getA2UITools({
      model: "openai/gpt-4.1",
      defaultCatalogId: "my-catalog",
    });

    const envelope = await runTool(tool, {}, makeCtx());
    expect(JSON.stringify(envelope)).toContain("my-catalog");
  });

  it("resolves the catalog schema forwarded on the request context", async () => {
    renderQueue.push(renderArgs(VALID_COMPONENTS));
    const tool = getA2UITools({
      model: "openai/gpt-4.1",
      defaultCatalogId: "cat",
    });

    const contextEntries = [
      {
        description:
          "A2UI Component Schema — available components for generating UI surfaces. " +
          "Use these component names and properties when creating A2UI operations.",
        value: JSON.stringify({
          catalogId: "cat",
          components: [{ name: "Metric" }],
        }),
      },
      { description: "Sales context", value: "The user is a sales rep." },
    ];

    await runTool(tool, { intent: "create" }, makeCtx({ contextEntries }));

    // buildContextPrompt (the subagent's instructions) surfaces the non-schema
    // context entry + the schema.
    expect(agentRuns[0].instructions).toContain("Sales context");
    expect(agentRuns[0].instructions).toContain("Available Components");
  });

  it("strips a trailing in-flight generate_a2ui call from subagent history", async () => {
    renderQueue.push(renderArgs(VALID_COMPONENTS));
    const tool = getA2UITools({ model: "openai/gpt-4.1" });

    const messages = [
      { role: "user", content: "make a KPI panel" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ function: { name: "generate_a2ui" } }],
      },
    ];
    await runTool(tool, { intent: "create" }, makeCtx({ messages }));

    const sentMessages = agentRuns[0].messages as Array<{
      role: string;
      content: string;
    }>;
    // Only the user turn survives (empty-content assistant call is stripped).
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ role: "user" });
  });

  it("returns an error envelope for an update targeting an unknown surface", async () => {
    const tool = getA2UITools({ model: "openai/gpt-4.1" });
    const envelope = await runTool(
      tool,
      { intent: "update", target_surface_id: "ghost" },
      makeCtx(),
    );
    // Never invoked the subagent — the request was rejected up front.
    expect(agentRuns).toHaveLength(0);
    expect(JSON.stringify(envelope)).toContain("no prior render");
  });
});

function makeInput(
  forwardedProps: Record<string, unknown> = {},
  context: Array<Record<string, unknown>> = [],
): any {
  return { forwardedProps, context, messages: [], threadId: "t", runId: "r" };
}

describe("planA2UIInjection (Mastra auto-inject)", () => {
  it("returns null when injectA2UITool is not forwarded", () => {
    const plan = planA2UIInjection({
      model: "openai/gpt-4.1",
      input: makeInput({}),
      existingToolNames: [],
    });
    expect(plan).toBeNull();
  });

  it("opts out when injectA2UITool is explicitly false", () => {
    const plan = planA2UIInjection({
      model: "openai/gpt-4.1",
      input: makeInput({ injectA2UITool: false }),
      existingToolNames: [],
    });
    expect(plan).toBeNull();
  });

  it("injects generate_a2ui and drops render_a2ui when forwarded true", () => {
    const plan = planA2UIInjection({
      model: "openai/gpt-4.1",
      input: makeInput({ injectA2UITool: true }),
      existingToolNames: ["get_weather"],
    });
    expect(plan).not.toBeNull();
    expect(plan!.toolName).toBe("generate_a2ui");
    expect(plan!.dropToolNames).toEqual(["render_a2ui"]);
    expect(isAutoInjectedA2UITool(plan!.tool)).toBe(true);
    expect(plan!.tool.id).toBe("generate_a2ui");
  });

  it("USER-PREVAILS: skips when the agent already wires generate_a2ui", () => {
    const plan = planA2UIInjection({
      model: "openai/gpt-4.1",
      input: makeInput({ injectA2UITool: true }),
      existingToolNames: ["generate_a2ui"],
    });
    expect(plan).toBeNull();
  });

  it("skips + warns when no model can be resolved", () => {
    const warn = vi.fn();
    const plan = planA2UIInjection({
      model: null,
      input: makeInput({ injectA2UITool: true }),
      existingToolNames: [],
      log: { warn },
    });
    expect(plan).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("a string flag names the render tool to drop", () => {
    const plan = planA2UIInjection({
      model: "openai/gpt-4.1",
      input: makeInput({ injectA2UITool: "custom_render" }),
      existingToolNames: [],
    });
    expect(plan!.dropToolNames).toEqual(["custom_render"]);
  });

  it("backend config.injectA2UITool drives injection when forwardedProps is absent", () => {
    const plan = planA2UIInjection({
      model: "openai/gpt-4.1",
      input: makeInput({}),
      existingToolNames: [],
      config: { injectA2UITool: true },
    });
    expect(plan).not.toBeNull();
    expect(plan!.toolName).toBe("generate_a2ui");
  });

  it("forwardedProps wins over backend config (explicit runtime opt-out)", () => {
    const plan = planA2UIInjection({
      model: "openai/gpt-4.1",
      input: makeInput({ injectA2UITool: false }),
      existingToolNames: [],
      config: { injectA2UITool: true },
    });
    expect(plan).toBeNull();
  });

  it("explicit backend injectA2UITool:false opts out even when forwarded true (fixed-schema owns its tool)", () => {
    const plan = planA2UIInjection({
      model: "openai/gpt-4.1",
      input: makeInput({ injectA2UITool: true }),
      existingToolNames: ["search_hotels", "search_flights"],
      config: { injectA2UITool: false },
    });
    expect(plan).toBeNull();
  });
});
