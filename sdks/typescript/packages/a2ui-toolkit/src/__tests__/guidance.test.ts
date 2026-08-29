import { describe, it, expect } from "vitest";
import { DEFAULT_GENERATION_GUIDELINES } from "../index";

describe("DEFAULT_GENERATION_GUIDELINES — local-swap actions (OSS-165 v2)", () => {
  it("teaches the agui.* functionCall shape for no-round-trip local interactions", () => {
    expect(DEFAULT_GENERATION_GUIDELINES).toContain("functionCall");
    expect(DEFAULT_GENERATION_GUIDELINES).toContain("agui.setValue");
    expect(DEFAULT_GENERATION_GUIDELINES).toContain("agui.toggleValue");
  });
});
