import { describe, expect, it } from "vitest";
import { EventType } from "../index";
import type {
  AGUIEventOf,
  EventPayloadOf,
  ReasoningMessageContentEventProps,
  TextMessageStartEventProps,
  ToolCallStartEventProps,
} from "../index";

// Compile-time canaries for the compat derivations. Omit over any type that
// carries a string index signature silently erases every named field — the
// exact defect these types shipped with twice — so each assertion here is a
// `tsc` check that the named fields survived, phrased so a regression fails
// the build rather than weakening types quietly.
describe("compat type derivations", () => {
  it("Props keep their required fields", () => {
    // @ts-expect-error toolCallId and toolCallName are required
    const missing: ToolCallStartEventProps = {};
    const full: ToolCallStartEventProps = {
      toolCallId: "tc-1",
      toolCallName: "get_weather",
    };
    // @ts-expect-error a wrong-typed named field must not hide in an index signature
    const wrong: ToolCallStartEventProps = { toolCallId: 1, toolCallName: "x" };
    // @ts-expect-error messageId is required
    const missingMessage: TextMessageStartEventProps = {};
    // The reasoning Props once derived from the zod schema object by accident;
    // a real field proves they derive from the event type.
    const reasoning: ReasoningMessageContentEventProps = {
      messageId: "m1",
      delta: "d",
    };
    // Extra keys stay tolerated, as they always were.
    const extra: TextMessageStartEventProps = { messageId: "m1", xExtra: 1 };
    expect([missing, full, wrong, missingMessage, reasoning, extra]).toBeDefined();
  });

  it("EventPayloadOf keeps the event's own fields and drops the base ones", () => {
    // @ts-expect-error toolCallId and toolCallName survive the Omit
    const empty: EventPayloadOf<EventType.TOOL_CALL_START> = {};
    const payload: EventPayloadOf<EventType.TOOL_CALL_START> = {
      toolCallId: "tc-1",
      toolCallName: "get_weather",
    };
    // The base fields are gone: `timestamp` may not appear.
    const withBase: EventPayloadOf<EventType.TOOL_CALL_START> = {
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      // @ts-expect-error timestamp is a base field, not payload
      timestamp: 1,
    };
    const event: AGUIEventOf<EventType.TOOL_CALL_START> = {
      type: EventType.TOOL_CALL_START,
      ...payload,
    };
    // Distribution over a union: each member keeps its OWN fields; without
    // it, Omit over the union would keep only the common (base) keys and
    // every payload would collapse to {}.
    const unionPayload: EventPayloadOf<EventType.TOOL_CALL_START | EventType.RUN_STARTED> = {
      threadId: "t1",
      runId: "r1",
    };
    // @ts-expect-error at least one member's required fields must be met
    const noMember: EventPayloadOf<EventType.TOOL_CALL_START | EventType.RUN_STARTED> = {
      toolCallId: "tc-1",
      runId: "r1",
    };
    // A complete member carrying a stray key from another member COMPILES —
    // deliberately not fought with never-padding: extra keys are what the
    // runtime tolerance keeps everywhere, so the type matching the runtime
    // contract is correct, and the historic types were looser still.
    const memberWithStray: EventPayloadOf<EventType.TOOL_CALL_START | EventType.RUN_STARTED> = {
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      runId: "r1",
    };
    expect([
      empty,
      payload,
      withBase,
      event,
      unionPayload,
      noMember,
      memberWithStray,
    ]).toBeDefined();
  });
});
