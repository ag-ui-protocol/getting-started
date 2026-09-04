import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A token count a provider hands over as a string, a `null` or an object is a
 * defect in the provider's metadata, not a count. Dropping it is right — one
 * malformed count must not fail an otherwise-successful run at its final event
 * — but dropping it in SILENCE means the usage numbers are quietly wrong and
 * nothing says why. The mappers warn once per rejected key instead.
 *
 * Every test re-imports the module through `vi.resetModules()`, because the
 * once-per-key suppression is module state: without the reset the second test
 * would inherit the first one's already-warned keys.
 */
const freshModule = async () => {
  vi.resetModules();
  return import("../token-usage");
};

describe("a malformed token count is reported, not just dropped", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("names the key, the value and its type when an AI-SDK count is a string", async () => {
    const { tokenUsageFromAiSdkUsage } = await freshModule();

    const usage = tokenUsageFromAiSdkUsage({ inputTokens: "1024", outputTokens: 7 }, {});

    expect(usage).toEqual({ outputTokens: 7 });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("[ag-ui]");
    expect(message).toContain("usage.inputTokens");
    expect(message).toContain('"1024"');
    expect(message).toContain("string");
  });

  it("reports a null count, which is not the same as an absent one", async () => {
    const { tokenUsageFromAiSdkUsage } = await freshModule();

    tokenUsageFromAiSdkUsage({ inputTokens: null, outputTokens: 7 }, {});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("usage.inputTokens");
  });

  it("warns once per key, however many times the bad value arrives", async () => {
    const { tokenUsageFromAiSdkUsage } = await freshModule();

    tokenUsageFromAiSdkUsage({ inputTokens: "1024", outputTokens: 7 }, {});
    tokenUsageFromAiSdkUsage({ inputTokens: "2048", outputTokens: 9 }, {});
    tokenUsageFromAiSdkUsage({ inputTokens: { total: 1 }, outputTokens: 9 }, {});

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns once for EACH key, so a second bad field is not hidden by the first", async () => {
    const { tokenUsageFromAiSdkUsage } = await freshModule();

    tokenUsageFromAiSdkUsage({ inputTokens: "1024", outputTokens: null, totalTokens: 3 }, {});

    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(messages.some((m: string) => m.includes("usage.inputTokens"))).toBe(true);
    expect(messages.some((m: string) => m.includes("usage.outputTokens"))).toBe(true);
  });

  it("names the AG-UI key for a LangChain payload, not the vendor's spelling", async () => {
    const { tokenUsageFromLangChainMetadata } = await freshModule();

    const usage = tokenUsageFromLangChainMetadata(
      { input_tokens: "1024", output_tokens: 7, output_token_details: { reasoning: null } },
      {},
    );

    expect(usage).toEqual({ outputTokens: 7 });
    const messages = warn.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(messages.some((m: string) => m.includes("usage.inputTokens"))).toBe(true);
    expect(messages.some((m: string) => m.includes("usage.reasoningTokens"))).toBe(true);
    expect(messages.some((m: string) => m.includes("input_tokens"))).toBe(false);
  });

  it("says nothing for an absent count, which is the normal case", async () => {
    const { tokenUsageFromAiSdkUsage } = await freshModule();

    const usage = tokenUsageFromAiSdkUsage({ inputTokens: 5, outputTokens: undefined }, {});

    expect(usage).toEqual({ inputTokens: 5 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("says nothing for NaN, which is how AI-SDK spells a count the provider did not return", async () => {
    const { tokenUsageFromAiSdkUsage } = await freshModule();

    const usage = tokenUsageFromAiSdkUsage({ inputTokens: 5, outputTokens: NaN }, {});

    expect(usage).toEqual({ inputTokens: 5 });
    expect(warn).not.toHaveBeenCalled();
  });
});
