import { describe, expect, it } from "vitest";
import { EventType } from "../index";
import {
  EventSchemas,
  RunFinishedEventSchema,
  RunFinishedOutcomeSchema,
} from "../schemas";

describe("RunFinishedEventSchema — outcome is optional and back-compat", () => {
  it("parses a legacy event with no outcome", () => {
    const parsed = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
    });
    expect(parsed.outcome).toBeUndefined();
  });

  it("rejects an explicit `outcome: null`", () => {
    // Pinned by the spec corpus (RunFinishedEvent/invalid/outcome-null.json):
    // outcome is absent or an object, never null. Python's own encoder
    // serializes with exclude_none=True, so the official path never emits one.
    const result = RunFinishedEventSchema.safeParse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: null,
    });
    expect(result.success).toBe(false);
  });

  it("parses a legacy event with no outcome but with a result", () => {
    const parsed = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      result: { answer: 42 },
    });
    expect(parsed.outcome).toBeUndefined();
    expect(parsed.result).toEqual({ answer: 42 });
  });

  it("parses outcome={ type: 'success' }", () => {
    const parsed = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: { type: "success" },
      result: { answer: 42 },
    });
    expect(parsed.outcome).toEqual({ type: "success" });
    expect(parsed.result).toEqual({ answer: 42 });
  });

  it("parses outcome={ type: 'interrupt', interrupts: [...] }", () => {
    const parsed = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "int-1", reason: "tool_call" }],
      },
    });
    expect(parsed.outcome?.type).toBe("interrupt");
    if (parsed.outcome?.type === "interrupt") {
      expect(parsed.outcome.interrupts).toHaveLength(1);
    }
  });
});

describe("RunFinishedOutcomeSchema — discriminated union", () => {
  it("rejects outcome with empty interrupts", () => {
    expect(() =>
      RunFinishedOutcomeSchema.parse({ type: "interrupt", interrupts: [] }),
    ).toThrow();
  });

  it("rejects outcome with unknown type", () => {
    expect(() => RunFinishedOutcomeSchema.parse({ type: "nope" })).toThrow();
  });
});

describe("EventSchemas — outer union routes RUN_FINISHED correctly", () => {
  it("parses a RUN_FINISHED success event through the outer union", () => {
    const parsed = EventSchemas.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: { type: "success" },
    });
    expect(parsed.type).toBe(EventType.RUN_FINISHED);
    if (parsed.type === EventType.RUN_FINISHED) {
      expect(parsed.outcome?.type).toBe("success");
    }
  });

  it("parses a RUN_FINISHED interrupt event through the outer union", () => {
    const parsed = EventSchemas.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "int-1", reason: "tool_call" }],
      },
    });
    expect(parsed.type).toBe(EventType.RUN_FINISHED);
    if (parsed.type === EventType.RUN_FINISHED && parsed.outcome?.type === "interrupt") {
      expect(parsed.outcome.interrupts).toHaveLength(1);
    }
  });

  it("parses a legacy RUN_FINISHED event without outcome through the outer union", () => {
    const parsed = EventSchemas.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
    });
    expect(parsed.type).toBe(EventType.RUN_FINISHED);
    if (parsed.type === EventType.RUN_FINISHED) {
      expect(parsed.outcome).toBeUndefined();
    }
  });
});
