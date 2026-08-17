import { describe, expect, it } from "vitest";
import {
  EventSchemas,
  EventType,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  TokenUsageSchema,
} from "../events";

describe("TokenUsageSchema — numeric-only usage shape", () => {
  it("parses a full usage entry with all allowed fields", () => {
    const parsed = TokenUsageSchema.parse({
      provider: "anthropic",
      model: "claude-sonnet-4",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 20,
      cachedInputTokens: 10,
    });
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.totalTokens).toBe(150);
  });

  it("parses an empty usage entry (all fields optional)", () => {
    expect(() => TokenUsageSchema.parse({})).not.toThrow();
  });

  it("strips unknown / content-bearing fields from a usage entry", () => {
    const parsed = TokenUsageSchema.parse({
      inputTokens: 5,
      // must never survive: content-bearing / identifying fields
      prompt: "the secret prompt text",
      threadId: "t-1",
    });
    expect(parsed).toEqual({ inputTokens: 5 });
    expect(parsed as Record<string, unknown>).not.toHaveProperty("prompt");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("threadId");
  });

  it("rejects a non-numeric token count", () => {
    expect(() => TokenUsageSchema.parse({ inputTokens: "lots" })).toThrow();
  });
});

describe("RunFinishedEventSchema — optional usage array", () => {
  it("parses a legacy event with no usage", () => {
    const parsed = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
    });
    expect(parsed.usage).toBeUndefined();
  });

  it("parses a RUN_FINISHED event carrying usage entries", () => {
    const parsed = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      usage: [
        { provider: "openai", model: "gpt-4o", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        { provider: "openai", model: "gpt-4o-mini", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      ],
    });
    expect(parsed.usage).toHaveLength(2);
    expect(parsed.usage?.[1].model).toBe("gpt-4o-mini");
  });
});

describe("RunErrorEventSchema — optional usage array", () => {
  it("parses a RUN_ERROR event with no usage", () => {
    const parsed = RunErrorEventSchema.parse({
      type: EventType.RUN_ERROR,
      message: "boom",
    });
    expect(parsed.usage).toBeUndefined();
  });

  it("parses partial usage on a failed run", () => {
    const parsed = RunErrorEventSchema.parse({
      type: EventType.RUN_ERROR,
      message: "boom",
      usage: [{ provider: "anthropic", inputTokens: 100 }],
    });
    expect(parsed.usage?.[0].inputTokens).toBe(100);
  });
});

describe("EventSchemas — usage survives the outer discriminated union", () => {
  // Regression guard: the outer discriminatedUnion strips top-level keys that
  // are not declared on the matched member schema. `usage` MUST be declared so
  // it survives a full-stream parse (this is the exact failure mode that a
  // `.passthrough()`-only approach hits).
  it("preserves usage when parsing RUN_FINISHED through the outer union", () => {
    const parsed = EventSchemas.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      usage: [{ provider: "anthropic", totalTokens: 42 }],
    });
    expect(parsed.type).toBe(EventType.RUN_FINISHED);
    if (parsed.type === EventType.RUN_FINISHED) {
      expect(parsed.usage?.[0].totalTokens).toBe(42);
    }
  });

  it("preserves usage when parsing RUN_ERROR through the outer union", () => {
    const parsed = EventSchemas.parse({
      type: EventType.RUN_ERROR,
      message: "boom",
      usage: [{ provider: "anthropic", inputTokens: 7 }],
    });
    expect(parsed.type).toBe(EventType.RUN_ERROR);
    if (parsed.type === EventType.RUN_ERROR) {
      expect(parsed.usage?.[0].inputTokens).toBe(7);
    }
  });
});
