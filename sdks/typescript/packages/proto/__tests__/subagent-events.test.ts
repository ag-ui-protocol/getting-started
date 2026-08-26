import {
  BaseEvent,
  EventType,
  SubagentStartedEvent,
  SubagentFinishedEvent,
  SubagentErrorEvent,
  MessagesSnapshotEvent,
} from "@ag-ui/core";
import { describe, it, expect } from "vitest";
import { encode, decode } from "../src/proto";
import { EventType as ProtoEventType } from "../src/generated/events";
import { expectRoundTripEquality, roundTrip } from "./test-utils";

// Before these entries existed, encode() produced a ZERO-LENGTH buffer for each
// SUBAGENT_* event — no throw, no warning — so a producer on the binary
// transport lost subagent lifecycle silently while the stream carried on. And
// `subagentRunId` was dropped from every other event, since a field absent from the
// schema is simply not serialized. The length assertions below are what stops
// that regressing back into a silent drop.
describe("Subagent lifecycle events over protobuf", () => {
  it("should round-trip SUBAGENT_STARTED with every field populated", () => {
    const event: SubagentStartedEvent = {
      type: EventType.SUBAGENT_STARTED,
      timestamp: 1700000000000,
      subagentRunId: "sub-1",
      name: "researcher",
      description: "digs through sources",
      parentSubagentRunId: "sub-outer",
      parentToolCallId: "call-9",
      parentMessageId: "msg-3",
    };

    expectRoundTripEquality(event);
  });

  it("should round-trip SUBAGENT_STARTED with only the required fields", () => {
    const event: SubagentStartedEvent = {
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "sub-1",
      name: "researcher",
    };

    const decoded = roundTrip(event);
    expect(decoded.type).toBe(EventType.SUBAGENT_STARTED);
    expect(decoded.subagentRunId).toBe("sub-1");
    expect(decoded.name).toBe("researcher");
    // Absent optionals must stay absent rather than become empty strings, or a
    // consumer cannot tell "no parent" from "parent with an empty id".
    expect(decoded.description).toBeUndefined();
    expect(decoded.parentSubagentRunId).toBeUndefined();
    expect(decoded.parentToolCallId).toBeUndefined();
    expect(decoded.parentMessageId).toBeUndefined();
  });

  it("should round-trip SUBAGENT_FINISHED with and without a result", () => {
    expectRoundTripEquality({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "sub-1",
      result: { answer: 42, notes: ["a", "b"] },
    } as SubagentFinishedEvent);

    const bare = roundTrip({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "sub-1",
    } as SubagentFinishedEvent);
    expect(bare.type).toBe(EventType.SUBAGENT_FINISHED);
    expect(bare.subagentRunId).toBe("sub-1");
    expect(bare.result).toBeUndefined();
  });

  it("should round-trip SUBAGENT_FINISHED outcomes: legacy, success, suspended", () => {
    // Legacy (no outcome) decodes back to no outcome.
    const legacy = roundTrip({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "sub-1",
    } as SubagentFinishedEvent);
    expect((legacy as { outcome?: unknown }).outcome).toBeUndefined();

    expectRoundTripEquality({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "sub-1",
      outcome: { type: "success" },
    } as SubagentFinishedEvent);

    expectRoundTripEquality({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "sub-1",
      outcome: { type: "suspended", interruptIds: ["int-1", "int-2"] },
    } as SubagentFinishedEvent);

    // Suspended with no owned interrupts (ancestor of the interrupting
    // descendant): the empty list decodes back to an omitted field.
    const ancestor = roundTrip({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "sub-outer",
      outcome: { type: "suspended" },
    } as SubagentFinishedEvent);
    expect((ancestor as { outcome?: { type?: string; interruptIds?: unknown } }).outcome).toEqual({
      type: "suspended",
    });
  });

  it("should round-trip Interrupt.subagentRunId inside the RUN_FINISHED outcome", () => {
    const decoded = roundTrip({
      type: EventType.RUN_FINISHED,
      threadId: "t1",
      runId: "r1",
      outcome: {
        type: "interrupt",
        interrupts: [
          { id: "int-1", reason: "hitl", subagentRunId: "tools:s1" },
          { id: "int-2", reason: "hitl" },
        ],
      },
    } as unknown as BaseEvent);
    const outcome = (decoded as { outcome?: { interrupts?: Array<Record<string, unknown>> } }).outcome;
    expect(outcome?.interrupts?.[0].subagentRunId).toBe("tools:s1");
    expect(outcome?.interrupts?.[1].subagentRunId).toBeUndefined();
  });

  it("should round-trip SUBAGENT_ERROR with and without a code", () => {
    expectRoundTripEquality({
      type: EventType.SUBAGENT_ERROR,
      subagentRunId: "sub-1",
      message: "the subagent exploded",
      code: "E_BOOM",
    } as SubagentErrorEvent);

    const bare = roundTrip({
      type: EventType.SUBAGENT_ERROR,
      subagentRunId: "sub-1",
      message: "the subagent exploded",
    } as SubagentErrorEvent);
    expect(bare.message).toBe("the subagent exploded");
    expect(bare.code).toBeUndefined();
  });

  it("should encode each lifecycle event to a non-empty buffer", () => {
    // The original defect exactly: a 0-byte encode meant the encoder wrote a
    // 4-byte length header of zero and the consumer saw nothing at all.
    const events = [
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s", name: "n" },
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s" },
      { type: EventType.SUBAGENT_ERROR, subagentRunId: "s", message: "m" },
    ];

    for (const event of events) {
      expect(encode(event as never).length, `${event.type} encoded to 0 bytes`).toBeGreaterThan(0);
    }
  });
});

describe("subagentRunId attribution over protobuf", () => {
  it("should preserve subagentRunId on every attributable event already in the schema", () => {
    const events: Array<Record<string, unknown>> = [
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hi" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" },
      { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: "{}" },
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
      { type: EventType.STEP_STARTED, stepName: "step" },
      { type: EventType.STEP_FINISHED, stepName: "step" },
      { type: EventType.CUSTOM, name: "thing", value: { a: 1 } },
    ];

    for (const base of events) {
      const decoded = decode(encode({ ...base, subagentRunId: "sub-7" } as never)) as Record<
        string,
        unknown
      >;
      expect(decoded.subagentRunId, `${base.type} lost subagentRunId`).toBe("sub-7");
    }
  });

  it("should leave subagentRunId absent when the producer omits it", () => {
    // The field is optional in the schema, so an unattributed event must not
    // come back carrying an empty string — that would make every parent event
    // look like it belonged to a subagent named "".
    const events: Array<Record<string, unknown>> = [
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
      { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" },
      { type: EventType.STEP_STARTED, stepName: "step" },
    ];

    for (const base of events) {
      const decoded = decode(encode(base as never)) as Record<string, unknown>;
      expect(decoded.subagentRunId, `${base.type} invented a subagentRunId`).toBeUndefined();
    }
  });

  it("documents that chunk events still cannot be encoded at all (pre-existing)", () => {
    // TEXT_MESSAGE_CHUNK and TOOL_CALL_CHUNK have proto messages AND oneof slots
    // but no EventType enum entry, so writing base_event.type throws. That
    // predates subagents and is part of the wider protobuf-parity gap (only 19 of
    // the 36 event types are modelled), which is explicitly out of scope here — see
    // PNI-277. Both messages did get a subagent_run_id field for when they are
    // wired up, but the field is unreachable until the enum entries exist.
    //
    // This is asserted rather than skipped so that whoever fixes the enum sees
    // this test fail and turns it into a real round-trip assertion.
    for (const event of [
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m", delta: "x", subagentRunId: "s" },
      { type: EventType.TOOL_CALL_CHUNK, toolCallId: "t", delta: "y", subagentRunId: "s" },
    ]) {
      expect(() => encode(event as never), `${event.type} now encodes — see PNI-277`).toThrow(
        /invalid int32/,
      );
    }
  });

  it("should preserve per-message subagentRunId through MESSAGES_SNAPSHOT", () => {
    // One snapshot mixes the parent's messages with those of every subagent that
    // ran, which is why the field is per-message and not on the event. If it were
    // dropped here, the final snapshot would collapse every subagent group into
    // the parent thread.
    const event: MessagesSnapshotEvent = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "m1", role: "assistant", content: "parent speaking" },
        { id: "m2", role: "assistant", content: "subagent speaking", subagentRunId: "sub-1" },
        { id: "m3", role: "assistant", content: "other subagent", subagentRunId: "sub-2" },
      ],
    } as MessagesSnapshotEvent;

    const decoded = roundTrip(event);
    const byId = Object.fromEntries(decoded.messages.map((m) => [m.id, m]));

    expect((byId.m1 as Record<string, unknown>).subagentRunId).toBeUndefined();
    expect((byId.m2 as Record<string, unknown>).subagentRunId).toBe("sub-1");
    expect((byId.m3 as Record<string, unknown>).subagentRunId).toBe("sub-2");
  });
});

describe("wire compatibility of the subagent additions", () => {
  it("should decode bytes produced before the subagent fields existed", () => {
    // Golden bytes captured from the pre-subagent schema. Every subagent field
    // was appended, so an old producer's output must still decode — and must not
    // acquire a subagentRunId out of thin air. If someone renumbers an existing
    // field, this is what fails.
    //
    // TEXT_MESSAGE_START { messageId: "m1", role: "assistant" }, no subagentRunId.
    const golden = Uint8Array.from([
      10, 17, 10, 0, 18, 2, 109, 49, 26, 9, 97, 115, 115, 105, 115, 116, 97, 110, 116,
    ]);

    const decoded = decode(golden) as Record<string, unknown>;
    expect(decoded.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(decoded.messageId).toBe("m1");
    expect(decoded.role).toBe("assistant");
    expect(decoded.subagentRunId).toBeUndefined();
  });

  it("should keep the pre-existing EventType enum numbers stable", () => {
    // The three subagent entries were appended at 16-18. Renumbering any of the
    // originals would silently change every event's type on the wire, so the
    // originals are pinned here rather than trusted to review.
    const expected: Record<string, number> = {
      TEXT_MESSAGE_START: 0,
      TEXT_MESSAGE_CONTENT: 1,
      TEXT_MESSAGE_END: 2,
      TOOL_CALL_START: 3,
      TOOL_CALL_ARGS: 4,
      TOOL_CALL_END: 5,
      STATE_SNAPSHOT: 6,
      STATE_DELTA: 7,
      MESSAGES_SNAPSHOT: 8,
      RAW: 9,
      CUSTOM: 10,
      RUN_STARTED: 11,
      RUN_FINISHED: 12,
      RUN_ERROR: 13,
      STEP_STARTED: 14,
      STEP_FINISHED: 15,
      SUBAGENT_STARTED: 16,
      SUBAGENT_FINISHED: 17,
      SUBAGENT_ERROR: 18,
    };

    for (const [name, value] of Object.entries(expected)) {
      expect(
        (ProtoEventType as unknown as Record<string, number>)[name],
        `${name} changed wire number`,
      ).toBe(value);
    }
  });
});

describe("SUBAGENT_FINISHED outcome null on the unvalidated encode path", () => {
  // encode() falls back to the raw event when the schema parse fails. A null
  // outcome must degrade to the legacy (omitted) encoding, not crash reading
  // `.type` off null.
  it("encodes outcome: null as the legacy omitted outcome instead of crashing", () => {
    const encoded = encode({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "s1",
      outcome: null,
    } as never);
    const decoded = decode(encoded) as { outcome?: unknown; subagentRunId?: string };
    expect(decoded.subagentRunId).toBe("s1");
    expect(decoded.outcome).toBeUndefined();
  });
});
