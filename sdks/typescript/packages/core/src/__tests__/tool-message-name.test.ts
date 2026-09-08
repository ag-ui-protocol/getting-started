import { describe, it, expect } from "vitest";
import { ToolMessageSchema } from "../types";

describe("tool message name", () => {
  it("accepts an optional name on a tool message", () => {
    const parsed = ToolMessageSchema.parse({
      id: "t1",
      role: "tool",
      content: "ok",
      toolCallId: "tc1",
      name: "request_page_oncall",
    });
    expect(parsed.name).toBe("request_page_oncall");
  });

  it("leaves name undefined when omitted", () => {
    const parsed = ToolMessageSchema.parse({
      id: "t1",
      role: "tool",
      content: "ok",
      toolCallId: "tc1",
    });
    expect(parsed.name).toBeUndefined();
  });
});
