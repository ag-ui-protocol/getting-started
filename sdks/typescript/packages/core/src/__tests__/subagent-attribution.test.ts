import { describe, it, expect } from "vitest";
import {
  MessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
  ActivityMessageSchema,
  ReasoningMessageSchema,
} from "../types";
import { ThinkingTextMessageContentEventSchema, TextMessageContentEventSchema } from "../events";
import { EventType } from "../events";

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

describe("deprecated THINKING_* events carry no attribution", () => {
  // The deprecated THINKING_* family predates subagents and is not in the
  // attribution table; Python and .NET declare no such field. The TS schema
  // derives from the text schema and silently inherited it — parsed output
  // must not carry what the other SDKs reject.
  it("declares no subagentRunId on THINKING_TEXT_MESSAGE_CONTENT", () => {
    // BaseEventSchema is passthrough, so unknown keys always survive parsing —
    // the parity fix is the DECLARATION: the field must not be a typed,
    // validated member of the deprecated schema when Python and .NET have none.
    expect("subagentRunId" in ThinkingTextMessageContentEventSchema.shape).toBe(false);
    // And undeclared means unvalidated: a non-string rides through as an extra
    // instead of failing the parse, exactly as it would on any other event.
    const parsed = ThinkingTextMessageContentEventSchema.parse({
      type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
      delta: "hmm",
      subagentRunId: 123,
    });
    expect(parsed.delta).toBe("hmm");
  });

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
