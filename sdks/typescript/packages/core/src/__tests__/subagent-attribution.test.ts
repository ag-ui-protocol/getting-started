import { describe, it, expect } from "vitest";
import {
  MessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
  ActivityMessageSchema,
  ReasoningMessageSchema,
} from "../types";

describe("message subagentId attribution", () => {
  it("accepts subagentId on an assistant message", () => {
    const parsed = AssistantMessageSchema.parse({
      id: "m1",
      role: "assistant",
      content: "hi",
      subagentId: "sub-1",
    });
    expect(parsed.subagentId).toBe("sub-1");
  });

  it("accepts subagentId on tool, activity, and reasoning messages", () => {
    expect(
      ToolMessageSchema.parse({
        id: "t1",
        role: "tool",
        content: "ok",
        toolCallId: "tc1",
        subagentId: "sub-2",
      }).subagentId,
    ).toBe("sub-2");
    expect(
      ActivityMessageSchema.parse({
        id: "a1",
        role: "activity",
        activityType: "x",
        content: {},
        subagentId: "sub-3",
      }).subagentId,
    ).toBe("sub-3");
    expect(
      ReasoningMessageSchema.parse({
        id: "r1",
        role: "reasoning",
        content: "think",
        subagentId: "sub-4",
      }).subagentId,
    ).toBe("sub-4");
  });

  it("treats subagentId as optional (omitted => undefined)", () => {
    const parsed = MessageSchema.parse({ id: "m2", role: "assistant", content: "hi" });
    expect(parsed.subagentId).toBeUndefined();
  });
});
