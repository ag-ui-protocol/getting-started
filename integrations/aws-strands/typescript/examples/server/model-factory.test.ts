/**
 * Provider wiring in the shared examples model factory.
 *
 * The factory is the only place that asks a provider for reasoning content,
 * and the dojo e2e suite always drives the OpenAI branch against a mock
 * server, so deleting a provider's reasoning config leaves every other check
 * green. These tests close that hole.
 *
 * No network and no provider client: each `@strands-agents/sdk/models/*`
 * module is mocked with a recorder that captures the options the factory
 * passed, which is exactly the layer where a dropped config block would show
 * up. Mirrors `python/tests/test_model_factory.py`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({
  anthropic: [] as Record<string, unknown>[],
  openai: [] as Record<string, unknown>[],
}));

vi.mock("@strands-agents/sdk/models/anthropic", () => ({
  AnthropicModel: class {
    constructor(options: Record<string, unknown>) {
      recorded.anthropic.push(options);
    }
  },
}));

vi.mock("@strands-agents/sdk/models/openai", () => ({
  OpenAIModel: class {
    constructor(options: Record<string, unknown>) {
      recorded.openai.push(options);
    }
  },
}));

import { createModel } from "./model-factory";

describe("examples model factory reasoning config", () => {
  beforeEach(() => {
    recorded.anthropic.length = 0;
    recorded.openai.length = 0;
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("OPENAI_BASE_URL", "");
  });

  it("omits thinking on Anthropic by default", async () => {
    vi.stubEnv("MODEL_PROVIDER", "anthropic");

    await createModel();

    expect(recorded.anthropic).toHaveLength(1);
    expect(recorded.anthropic[0]!.params).toBeUndefined();
  });

  it("requests extended thinking on Anthropic when reasoning is on", async () => {
    vi.stubEnv("MODEL_PROVIDER", "anthropic");

    await createModel({ reasoning: true });

    expect(recorded.anthropic[0]!.params).toEqual({
      thinking: { type: "enabled", budget_tokens: 2000 },
    });
  });

  it("omits reasoning on OpenAI by default", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openai");

    await createModel();

    expect(recorded.openai).toHaveLength(1);
    expect(recorded.openai[0]!.params).toBeUndefined();
  });

  it("requests reasoning summaries on OpenAI when reasoning is on", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openai");

    await createModel({ reasoning: true });

    expect(recorded.openai[0]!.params).toEqual({
      reasoning: { effort: "medium", summary: "auto" },
    });
  });

  it("keeps the API mode independent of reasoning", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openai");

    await createModel({ openaiApi: "chat", reasoning: true });

    expect(recorded.openai[0]!.api).toBe("chat");
  });
});
