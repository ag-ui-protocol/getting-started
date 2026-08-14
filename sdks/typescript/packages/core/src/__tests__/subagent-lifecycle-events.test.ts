import { describe, it, expect } from "vitest";
import {
  EventType,
  EventSchemas,
  SubagentStartedEventSchema,
  SubagentFinishedEventSchema,
  SubagentErrorEventSchema,
  RunFinishedEventSchema,
} from "../events";
import {
  createSubagentStartedEvent,
  createSubagentFinishedEvent,
  createSubagentErrorEvent,
} from "../event-factories";

describe("subagent lifecycle events", () => {
  it("creates and validates SUBAGENT_STARTED with parent", () => {
    const e = createSubagentStartedEvent({
      subagentRunId: "sub-1",
      name: "Researcher",
      description: "does research",
      parentSubagentRunId: "sub-0",
    });
    expect(e.type).toBe(EventType.SUBAGENT_STARTED);
    expect(() => EventSchemas.parse(e)).not.toThrow();
    expect(e.subagentRunId).toBe("sub-1");
    expect(e.parentSubagentRunId).toBe("sub-0");
  });

  it("creates SUBAGENT_FINISHED and SUBAGENT_ERROR", () => {
    const fin = createSubagentFinishedEvent({ subagentRunId: "sub-1" });
    expect(fin.type).toBe(EventType.SUBAGENT_FINISHED);
    const err = createSubagentErrorEvent({
      subagentRunId: "sub-1",
      message: "boom",
      code: "E1",
    });
    expect(err.type).toBe(EventType.SUBAGENT_ERROR);
    expect(err.message).toBe("boom");
    expect(() => EventSchemas.parse(fin)).not.toThrow();
    expect(() => EventSchemas.parse(err)).not.toThrow();
  });

  it("accepts JSON null for optional fields and treats it as omitted", () => {
    // .NET producers serialize optional fields as null (System.Text.Json). A schema that
    // rejected null would fail on a stream the .NET SDK considers valid — the same interop
    // regression already fixed once for ToolCallStartEvent.parentMessageId.
    const started = SubagentStartedEventSchema.parse({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "s1",
      name: "researcher",
      description: null,
      parentSubagentRunId: null,
      parentToolCallId: null,
      parentMessageId: null,
    });

    expect(started.description).toBeUndefined();
    expect(started.parentSubagentRunId).toBeUndefined();
    expect(started.parentToolCallId).toBeUndefined();
    expect(started.parentMessageId).toBeUndefined();

    const errored = SubagentErrorEventSchema.parse({
      type: EventType.SUBAGENT_ERROR,
      subagentRunId: "s1",
      message: "boom",
      code: null,
    });
    expect(errored.code).toBeUndefined();
  });

  it("requires name on SUBAGENT_STARTED and message on SUBAGENT_ERROR", () => {
    expect(() =>
      EventSchemas.parse({ type: EventType.SUBAGENT_STARTED, subagentRunId: "s" }),
    ).toThrow();
    expect(() => EventSchemas.parse({ type: EventType.SUBAGENT_ERROR, subagentRunId: "s" })).toThrow();
  });

  it("parses SUBAGENT_FINISHED outcomes and treats null as omitted", () => {
    const legacy = SubagentFinishedEventSchema.parse({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "s1",
      outcome: null, // Pydantic producers serialize the no-outcome case as null
    });
    expect(legacy.outcome).toBeUndefined();

    const success = SubagentFinishedEventSchema.parse({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "s1",
      outcome: { type: "success" },
    });
    expect(success.outcome).toEqual({ type: "success" });

    const suspended = SubagentFinishedEventSchema.parse({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "s1",
      outcome: { type: "suspended", interruptIds: ["int-1"] },
    });
    expect(suspended.outcome).toEqual({ type: "suspended", interruptIds: ["int-1"] });

    expect(() =>
      SubagentFinishedEventSchema.parse({
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: "s1",
        outcome: { type: "paused" },
      }),
    ).toThrow();
  });

  it("carries the raising subagent on an Interrupt inside the run outcome", () => {
    const finished = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t1",
      runId: "r1",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "int-1", reason: "hitl", subagentRunId: "tools:s1" }],
      },
    });
    const outcome = finished.outcome as { interrupts: Array<{ subagentRunId?: string }> };
    expect(outcome.interrupts[0].subagentRunId).toBe("tools:s1");
  });
});
