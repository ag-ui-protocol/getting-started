import { describe, expect, it } from "vitest";
import {
  aggregateTokenUsage,
  tokenUsageFromAiSdkUsage,
  tokenUsageFromLangChainMetadata,
} from "../token-usage";
import { TokenUsageSchema } from "../schemas";

describe("tokenUsageFromAiSdkUsage", () => {
  it("maps AI-SDK v5 usage (keys already match TokenUsage)", () => {
    const u = tokenUsageFromAiSdkUsage(
      {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reasoningTokens: 20,
        cachedInputTokens: 10,
      },
      { provider: "openai", model: "gpt-4o" },
    );
    expect(u).toEqual({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 20,
      cachedInputTokens: 10,
    });
  });

  it("ignores non-finite counts (AI-SDK reports NaN for unknown)", () => {
    const u = tokenUsageFromAiSdkUsage(
      { inputTokens: 12, outputTokens: NaN, totalTokens: undefined },
      {},
    );
    expect(u).toEqual({ inputTokens: 12 });
  });

  it("returns undefined when no finite counts are present", () => {
    expect(tokenUsageFromAiSdkUsage({ inputTokens: NaN }, {})).toBeUndefined();
    expect(tokenUsageFromAiSdkUsage(undefined, {})).toBeUndefined();
  });
});

describe("tokenUsageFromLangChainMetadata", () => {
  it("maps core and detail fields", () => {
    const u = tokenUsageFromLangChainMetadata(
      {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_token_details: { cache_read: 10 },
        output_token_details: { reasoning: 20 },
      },
      { provider: "anthropic", model: "claude-sonnet-4" },
    );
    expect(u).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 20,
      cachedInputTokens: 10,
    });
  });

  it("returns undefined for missing/empty metadata", () => {
    expect(tokenUsageFromLangChainMetadata(undefined, {})).toBeUndefined();
    expect(tokenUsageFromLangChainMetadata(null, {})).toBeUndefined();
  });

  it("omits absent fields entirely", () => {
    expect(tokenUsageFromLangChainMetadata({ input_tokens: 5 }, {})).toEqual({ inputTokens: 5 });
  });
});

describe("aggregateTokenUsage", () => {
  it("sums entries for the same provider/model", () => {
    const agg = aggregateTokenUsage([
      { provider: "openai", model: "gpt-4o", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      { provider: "openai", model: "gpt-4o", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ]);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ inputTokens: 110, outputTokens: 25, totalTokens: 135 });
  });

  it("keeps distinct models separate and preserves first-seen order", () => {
    const agg = aggregateTokenUsage([
      { provider: "openai", model: "gpt-4o", inputTokens: 1 },
      { provider: "openai", model: "gpt-4o-mini", inputTokens: 2 },
      { provider: "openai", model: "gpt-4o", inputTokens: 3 },
    ]);
    expect(agg.map((u) => u.model)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(agg[0].inputTokens).toBe(4);
    expect(agg[1].inputTokens).toBe(2);
  });

  it("returns [] for empty input", () => {
    expect(aggregateTokenUsage([])).toEqual([]);
  });

  it("leaves a count undefined when no group member reported it", () => {
    const agg = aggregateTokenUsage([
      { provider: "p", model: "m", inputTokens: 1 },
      { provider: "p", model: "m", inputTokens: 2 },
    ]);
    expect(agg[0].inputTokens).toBe(3);
    expect(agg[0].outputTokens).toBeUndefined();
  });
});

// Every other representation of a token count is an integer — proto `int64`,
// C# `long?`, Python `int`. A bare `z.number()` therefore accepts values that
// cannot survive the wire: `proto.encode` validates against these schemas and
// then hands the value to an int64 writer, which throws a RangeError on a
// non-integer. Rejecting at parse turns a mid-stream crash on the protobuf
// transport into an actionable validation error at the producer.
describe("TokenUsageSchema — count constraints", () => {
  const parse = (usage: Record<string, unknown>) =>
    TokenUsageSchema.safeParse(usage).success;

  it("accepts integer counts, including zero", () => {
    expect(parse({ inputTokens: 0 })).toBe(true);
    expect(parse({ inputTokens: 1234 })).toBe(true);
  });

  it("rejects fractional counts on every numeric field", () => {
    for (const field of [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "reasoningTokens",
      "cachedInputTokens",
    ]) {
      expect(parse({ [field]: 1.5 })).toBe(false);
    }
  });

  it("rejects negative counts", () => {
    expect(parse({ inputTokens: -1 })).toBe(false);
  });

  it("still allows every count to be omitted", () => {
    expect(parse({ provider: "openai", model: "gpt-4o" })).toBe(true);
  });
});

// The two vendor mappers must guard identically. The AI-SDK one already rejects
// non-finite/non-numeric values; the LangChain one passed whatever it was handed
// straight through. That does not degrade gracefully: HttpAgent validates every
// incoming event and throws, so one provider's malformed usage metadata takes
// down an otherwise-successful run at the very last event — the user loses the
// answer, not just the token count.
describe("tokenUsageFromLangChainMetadata — input guarding", () => {
  it("drops non-numeric counts instead of forwarding them", () => {
    const u = tokenUsageFromLangChainMetadata(
      { input_tokens: "100", output_tokens: 5 },
      { provider: "openai" },
    );
    expect(u?.inputTokens).toBeUndefined();
    expect(u?.outputTokens).toBe(5);
  });

  it("drops NaN and Infinity counts", () => {
    const u = tokenUsageFromLangChainMetadata(
      { input_tokens: NaN, output_tokens: Infinity, total_tokens: 7 },
      { provider: "openai" },
    );
    expect(u?.inputTokens).toBeUndefined();
    expect(u?.outputTokens).toBeUndefined();
    expect(u?.totalTokens).toBe(7);
  });

  it("guards the nested reasoning/cache_read details too", () => {
    const u = tokenUsageFromLangChainMetadata(
      {
        input_tokens: 1,
        output_token_details: { reasoning: "12" },
        input_token_details: { cache_read: null },
      },
      {},
    );
    expect(u?.reasoningTokens).toBeUndefined();
    expect(u?.cachedInputTokens).toBeUndefined();
  });

  // Matches tokenUsageFromAiSdkUsage, which returns undefined rather than an
  // entry that claims usage was reported while carrying no counts.
  it("returns undefined when no usable count is present", () => {
    expect(tokenUsageFromLangChainMetadata({}, { provider: "openai" })).toBeUndefined();
    expect(
      tokenUsageFromLangChainMetadata({ input_tokens: "nope" }, { provider: "openai" }),
    ).toBeUndefined();
  });

  it("still maps a well-formed payload", () => {
    const u = tokenUsageFromLangChainMetadata(
      {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        output_token_details: { reasoning: 2 },
        input_token_details: { cache_read: 1 },
      },
      { provider: "openai", model: "gpt-4o" },
    );
    expect(u).toEqual({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      reasoningTokens: 2,
      cachedInputTokens: 1,
    });
  });
});
