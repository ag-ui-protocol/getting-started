/**
 * Every forwardable field on the template Agent must reach the per-thread
 * AgentConfig. Mirrors Python's `_extract_agent_kwargs`.
 */

import { describe, it, expect, vi } from "vitest";
import type { AgentConfig, Plugin } from "@strands-agents/sdk";
import { StrandsAgent } from "../agent";
import { collect } from "./helpers";

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

  it("forwards traceAttributes, structuredOutputSchema, toolExecutor", async () => {
    capturedConfigs.length = 0;
    const sa = new StrandsAgent({ agent: richTemplate(), name: "t" });
    await collect(sa);
    const cfg = capturedConfigs.at(-1)!;
    expect(cfg.traceAttributes).toEqual({ team: "agui" });
    expect(cfg.structuredOutputSchema).toBeDefined();
    expect(cfg.toolExecutor).toBe("concurrent");
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
