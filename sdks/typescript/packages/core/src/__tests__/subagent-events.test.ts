import { describe, it, expect } from "vitest";
import {
  TextMessageStartEventSchema,
  TextMessageChunkEventSchema,
  ToolCallStartEventSchema,
  ToolCallChunkEventSchema,
  ToolCallResultEventSchema,
  ReasoningMessageChunkEventSchema,
  StateDeltaEventSchema,
  StepStartedEventSchema,
  CustomEventSchema,
  EventType,
} from "../events";

describe("event subagentRunId attribution", () => {
  it("accepts subagentRunId on creation events", () => {
    expect(
      TextMessageStartEventSchema.parse({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        subagentRunId: "sub-1",
      }).subagentRunId,
    ).toBe("sub-1");
    expect(
      ToolCallStartEventSchema.parse({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        subagentRunId: "sub-2",
      }).subagentRunId,
    ).toBe("sub-2");
    expect(
      ToolCallResultEventSchema.parse({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tm1",
        toolCallId: "tc1",
        content: "done",
        subagentRunId: "sub-3",
      }).subagentRunId,
    ).toBe("sub-3");
  });

  it("accepts subagentRunId on all chunk events", () => {
    expect(
      TextMessageChunkEventSchema.parse({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        subagentRunId: "sub-7",
      }).subagentRunId,
    ).toBe("sub-7");
    expect(
      ToolCallChunkEventSchema.parse({
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        subagentRunId: "sub-8",
      }).subagentRunId,
    ).toBe("sub-8");
    expect(
      ReasoningMessageChunkEventSchema.parse({
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "r1",
        delta: "thinking",
        subagentRunId: "sub-9",
      }).subagentRunId,
    ).toBe("sub-9");
  });

  it("declares subagentRunId as a typed field (rejects non-string), not passthrough", () => {
    // BaseEventSchema is .passthrough(), so an undeclared key would survive .parse()
    // regardless of the schema. A DECLARED z.string() field, however, rejects a
    // non-string value — so safeParse failing on a numeric subagentRunId proves the
    // field is genuinely declared on each schema (and guards against its removal).
    const numericSubagentRunId = 123 as unknown as string;
    expect(
      TextMessageStartEventSchema.safeParse({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        subagentRunId: numericSubagentRunId,
      }).success,
    ).toBe(false);
    expect(
      TextMessageChunkEventSchema.safeParse({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        subagentRunId: numericSubagentRunId,
      }).success,
    ).toBe(false);
    expect(
      ToolCallStartEventSchema.safeParse({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "f",
        subagentRunId: numericSubagentRunId,
      }).success,
    ).toBe(false);
    expect(
      ToolCallChunkEventSchema.safeParse({
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        subagentRunId: numericSubagentRunId,
      }).success,
    ).toBe(false);
    expect(
      ToolCallResultEventSchema.safeParse({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tm1",
        toolCallId: "tc1",
        content: "done",
        subagentRunId: numericSubagentRunId,
      }).success,
    ).toBe(false);
    expect(
      ReasoningMessageChunkEventSchema.safeParse({
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "r1",
        subagentRunId: numericSubagentRunId,
      }).success,
    ).toBe(false);
    expect(
      StateDeltaEventSchema.safeParse({
        type: EventType.STATE_DELTA,
        delta: [],
        subagentRunId: numericSubagentRunId,
      }).success,
    ).toBe(false);
    expect(
      StepStartedEventSchema.safeParse({
        type: EventType.STEP_STARTED,
        stepName: "s",
        subagentRunId: numericSubagentRunId,
      }).success,
    ).toBe(false);
    expect(
      CustomEventSchema.safeParse({
        type: EventType.CUSTOM,
        name: "n",
        value: 1,
        subagentRunId: numericSubagentRunId,
      }).success,
    ).toBe(false);
  });

  it("accepts subagentRunId on standalone events", () => {
    expect(
      StateDeltaEventSchema.parse({
        type: EventType.STATE_DELTA,
        delta: [],
        subagentRunId: "sub-4",
      }).subagentRunId,
    ).toBe("sub-4");
    expect(
      StepStartedEventSchema.parse({
        type: EventType.STEP_STARTED,
        stepName: "s",
        subagentRunId: "sub-5",
      }).subagentRunId,
    ).toBe("sub-5");
    expect(
      CustomEventSchema.parse({
        type: EventType.CUSTOM,
        name: "n",
        value: 1,
        subagentRunId: "sub-6",
      }).subagentRunId,
    ).toBe("sub-6");
  });
});
