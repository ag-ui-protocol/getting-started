/**
 * Template-field forwarding, asserted against a genuine `Agent`.
 *
 * The sibling suite drives a hand-built template object whose fields all sit
 * on public properties. A real `Agent` does not store them that way: several
 * are only reachable under an underscore-prefixed name. Forwarding logic that
 * reads the public names returns `undefined` for a field the caller did set,
 * and a suite built on a fabricated template cannot tell the difference.
 *
 * These tests exist so that it can. Anything a real Agent exposes under no
 * name at all is pinned in the fabricated suite instead, where the assertion
 * can actually fail.
 */

import { describe, it, expect } from "vitest";
import {
  Agent,
  SlidingWindowConversationManager,
  tool,
  type AgentConfig,
} from "@strands-agents/sdk";
import { z } from "zod";

import { StrandsAgent } from "../agent";
import { ScriptedModel } from "./strands-sdk-harness";

const structuredOutputSchema = z.object({ answer: z.string() });

function realTemplate(overrides: Partial<AgentConfig> = {}) {
  return new Agent({
    model: new ScriptedModel([]),
    printer: false,
    name: "my-template-agent",
    description: "a wizard",
    id: "wizard-001",
    systemPrompt: "you are helpful",
    appState: { seed: 42 },
    modelState: { responseId: "abc" },
    structuredOutputSchema,
    toolExecutor: "sequential",
    traceAttributes: { "deployment.environment": "test" },
    ...overrides,
  });
}

/** The AgentConfig the adapter would hand to a per-thread agent. */
function threadConfig(template: Agent): AgentConfig {
  const sa = new StrandsAgent({ agent: template, name: "adapter-name" });
  return (
    sa as unknown as { _buildThreadAgentConfig: () => AgentConfig }
  )._buildThreadAgentConfig();
}

describe("template forwarding against the real Strands SDK", () => {
  it("forwards fields the Agent keeps under their own name", () => {
    const cfg = threadConfig(realTemplate());
    expect(cfg.name).toBe("my-template-agent");
    expect(cfg.description).toBe("a wizard");
    expect(cfg.id).toBe("wizard-001");
    expect(cfg.systemPrompt).toBe("you are helpful");
    expect(cfg.appState).toEqual({ seed: 42 });
    expect(cfg.modelState).toEqual({ responseId: "abc" });
  });

  it("forwards a field the Agent only keeps under an underscore name", () => {
    // Reading this under its public name yields undefined on a real Agent,
    // which is how it was being dropped while the suite stayed green.
    const template = realTemplate();
    const cfg = threadConfig(template);

    // Compared against whatever the Agent itself stored, not against the
    // literal that was passed in: newer releases normalize this option into an
    // executor instance, and pinning the literal would make the assertion
    // about the SDK's representation rather than about the forwarding.
    const stored = (template as unknown as Record<string, unknown>)
      ._toolExecutor;
    expect(stored).toBeDefined();
    expect(cfg.toolExecutor).toBe(stored);
  });

  it("leaves structured output off the per-thread agent", () => {
    // Forwarding it makes Strands inject its structured-output tool, which
    // this adapter streams to the client and which fails an ordinary text
    // turn. It was never actually forwarded before, so this is the shipped
    // behaviour rather than a new omission.
    const cfg = threadConfig(realTemplate());
    expect(cfg.structuredOutputSchema).toBeUndefined();
  });

  it("forwards the Model instance rather than a model id", () => {
    const template = realTemplate();
    const cfg = threadConfig(template);
    expect(cfg.model).toBe(template.model);
  });

  it("does not share the template's conversationManager across threads", () => {
    // It carries one conversation's window state; sharing a single instance
    // would let one thread trim or summarise another thread's history.
    const conversationManager = new SlidingWindowConversationManager({
      windowSize: 3,
    });
    const cfg = threadConfig(realTemplate({ conversationManager }));
    expect(cfg.conversationManager).toBeUndefined();
  });

  it("gives each thread of one adapter its own tools array", () => {
    // Two configs from the SAME adapter: building a second adapter would hand
    // back two fresh arrays whatever the copy does, so the assertion would
    // hold with the copy removed.
    const echo = tool({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ v: z.string() }),
      callback: (input) => ({ echoed: input.v }),
    });
    const sa = new StrandsAgent({
      agent: realTemplate({ tools: [echo] }),
      name: "adapter-name",
    });
    const build = (
      sa as unknown as { _buildThreadAgentConfig: () => AgentConfig }
    )._buildThreadAgentConfig.bind(sa);

    const a = build();
    const b = build();

    expect(a.tools).toHaveLength(1);
    expect(a.tools).not.toBe(b.tools);
    // Same tool, separate arrays: one thread mutating its list must not reach
    // another's.
    expect(a.tools?.[0]).toBe(b.tools?.[0]);
  });

  it("carries the template's id so snapshots stay findable", () => {
    // The id is what a SessionManager keys snapshots by, so it has to survive
    // the rebuild rather than being regenerated per thread.
    const template = realTemplate();
    const first = threadConfig(template);
    const second = threadConfig(template);

    expect(first.id).toBe("wizard-001");
    expect(second.id).toBe(first.id);
  });

  it("builds a working Agent from the forwarded config", () => {
    // The config is only useful if the SDK accepts it. Asserting the object's
    // shape leaves room for a value that looks right and is then rejected, or
    // that switches on machinery the adapter does not want.
    const cfg = threadConfig(realTemplate());
    const rebuilt = new Agent(cfg);

    expect(rebuilt.name).toBe("my-template-agent");
    expect(rebuilt.id).toBe("wizard-001");
  });
});
