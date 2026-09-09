import { describe, it, expect } from "vitest";
import {
  MessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
  ActivityMessageSchema,
  ReasoningMessageSchema,
  TextMessageContentEventSchema,
} from "../schemas";
import { EventType } from "../index";

describe("message subagentRunId attribution", () => {
  it("accepts subagentRunId on an assistant message", () => {
    const parsed = AssistantMessageSchema.parse({
      id: "m1",
      role: "assistant",
      content: "hi",
      subagentRunId: "sub-1",
    });
    expect(parsed.subagentRunId).toBe("sub-1");
  });

  it("accepts subagentRunId on tool, activity, and reasoning messages", () => {
    expect(
      ToolMessageSchema.parse({
        id: "t1",
        role: "tool",
        content: "ok",
        toolCallId: "tc1",
        subagentRunId: "sub-2",
      }).subagentRunId,
    ).toBe("sub-2");
    expect(
      ActivityMessageSchema.parse({
        id: "a1",
        role: "activity",
        activityType: "x",
        content: {},
        subagentRunId: "sub-3",
      }).subagentRunId,
    ).toBe("sub-3");
    expect(
      ReasoningMessageSchema.parse({
        id: "r1",
        role: "reasoning",
        content: "think",
        subagentRunId: "sub-4",
      }).subagentRunId,
    ).toBe("sub-4");
  });

  it("treats subagentRunId as optional (omitted => undefined)", () => {
    const parsed = MessageSchema.parse({ id: "m2", role: "assistant", content: "hi" });
    expect(parsed.subagentRunId).toBeUndefined();
  });
});

describe("the non-deprecated text content schema carries attribution", () => {
  // The deprecated THINKING_* family used to need a case of its own here: the
  // TS schema derived from the text schema and silently inherited
  // subagentRunId, which Python and .NET never declared. That family is no
  // longer part of the protocol — the compatibility boundary upgrades those
  // events to their REASONING_* equivalents on the way in (see
  // DEPRECATIONS.md) — so only the live declaration is left to keep honest.
  it("still declares and validates subagentRunId on the non-deprecated text content schema", () => {
    expect("subagentRunId" in TextMessageContentEventSchema.shape).toBe(true);
    const parsed = TextMessageContentEventSchema.parse({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta: "hi",
      subagentRunId: "s1",
    });
    expect(parsed.subagentRunId).toBe("s1");
  });
});
