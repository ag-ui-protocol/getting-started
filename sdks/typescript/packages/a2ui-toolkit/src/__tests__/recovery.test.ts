import { describe, it, expect, vi } from "vitest";
import {
  MAX_A2UI_ATTEMPTS,
  A2UI_RECOVERY_ACTIVITY_TYPE,
  augmentPromptWithValidationErrors,
  formatValidationErrors,
  runA2UIGenerationWithRecovery,
} from "../recovery";
import type { A2UIValidationError } from "../validate";

const CATALOG = {
  components: {
    Row: { required: ["children"] },
    HotelCard: { required: ["name", "rating"] },
  },
};

const root = { id: "root", component: "Row", children: { componentId: "card", path: "/items" } };
const goodCard = { id: "card", component: "HotelCard", name: { path: "name" }, rating: { path: "rating" } };
const badCard = { id: "card", component: "HotelCard", name: { path: "name" } }; // missing required `rating`

const goodArgs = { surfaceId: "s1", components: [root, goodCard], data: { items: [{ name: "Ritz", rating: 4.8 }] } };
const badArgs = { surfaceId: "s1", components: [root, badCard], data: { items: [{ name: "Ritz", rating: 4.8 }] } };

const buildEnvelope = (args: Record<string, unknown>) => JSON.stringify({ a2ui_operations: args.components });

describe("constants", () => {
  it("defaults the attempt cap to 3", () => {
    expect(MAX_A2UI_ATTEMPTS).toBe(3);
  });
  it("names the recovery activity type", () => {
    expect(A2UI_RECOVERY_ACTIVITY_TYPE).toBe("a2ui_recovery");
  });
});

describe("augmentPromptWithValidationErrors", () => {
  const errors: A2UIValidationError[] = [
    { code: "missing_required_prop", path: "components[1].rating", message: "missing required prop 'rating'" },
  ];
  it("returns the base prompt unchanged when there are no errors", () => {
    expect(augmentPromptWithValidationErrors("BASE", [])).toBe("BASE");
  });
  it("appends a fix-it block listing the structured errors", () => {
    const out = augmentPromptWithValidationErrors("BASE", errors);
    expect(out).toContain("BASE");
    expect(out).toContain("rating");
    expect(out).toContain(formatValidationErrors(errors));
  });
});

describe("runA2UIGenerationWithRecovery", () => {
  it("returns the valid envelope on the first attempt without retrying", async () => {
    const invokeSubagent = vi.fn(async () => goodArgs);
    const res = await runA2UIGenerationWithRecovery({ basePrompt: "P", catalog: CATALOG, invokeSubagent, buildEnvelope });
    expect(res.ok).toBe(true);
    expect(res.attempts).toHaveLength(1);
    expect(invokeSubagent).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.envelope).a2ui_operations).toBeDefined();
  });

  it("feeds errors back and recovers on the second attempt", async () => {
    const prompts: string[] = [];
    const invokeSubagent = vi.fn(async (prompt: string, attempt: number) => {
      prompts.push(prompt);
      return attempt === 1 ? badArgs : goodArgs;
    });
    const res = await runA2UIGenerationWithRecovery({ basePrompt: "P", catalog: CATALOG, invokeSubagent, buildEnvelope });
    expect(res.ok).toBe(true);
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts[0].ok).toBe(false);
    expect(res.attempts[1].ok).toBe(true);
    // The retry prompt carried the validation errors back to the sub-agent.
    expect(prompts[1]).toContain("rating");
  });

  it("exhausts after maxAttempts and returns a structured hard-failure envelope", async () => {
    const onAttempt = vi.fn();
    const invokeSubagent = vi.fn(async () => badArgs);
    const res = await runA2UIGenerationWithRecovery({ basePrompt: "P", catalog: CATALOG, invokeSubagent, buildEnvelope, onAttempt });
    expect(res.ok).toBe(false);
    expect(res.attempts).toHaveLength(MAX_A2UI_ATTEMPTS);
    expect(invokeSubagent).toHaveBeenCalledTimes(MAX_A2UI_ATTEMPTS);
    expect(onAttempt).toHaveBeenCalledTimes(MAX_A2UI_ATTEMPTS);
    const parsed = JSON.parse(res.envelope);
    expect(parsed.code).toBe("a2ui_recovery_exhausted");
    expect(parsed.error).toBeTruthy();
    expect(Array.isArray(parsed.attempts)).toBe(true);
  });

  it("honors a configured maxAttempts override", async () => {
    const invokeSubagent = vi.fn(async () => badArgs);
    const res = await runA2UIGenerationWithRecovery({
      basePrompt: "P",
      catalog: CATALOG,
      config: { maxAttempts: 2 },
      invokeSubagent,
      buildEnvelope,
    });
    expect(res.ok).toBe(false);
    expect(invokeSubagent).toHaveBeenCalledTimes(2);
  });

  it("treats a missing tool call (null) as a failed, retryable attempt", async () => {
    const invokeSubagent = vi.fn(async (_p: string, attempt: number) => (attempt === 1 ? null : goodArgs));
    const res = await runA2UIGenerationWithRecovery({ basePrompt: "P", catalog: CATALOG, invokeSubagent, buildEnvelope });
    expect(res.ok).toBe(true);
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts[0].ok).toBe(false);
  });
});
