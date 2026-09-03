import { describe, expect, it } from "vitest";
import { InterruptSchema, ResumeEntrySchema, RunAgentInputSchema } from "../schemas";

describe("InterruptSchema", () => {
  it("accepts an interrupt with only required fields", () => {
    const parsed = InterruptSchema.parse({ id: "int-1", reason: "tool_call" });
    expect(parsed).toEqual({ id: "int-1", reason: "tool_call" });
  });

  it("accepts all standardized optional fields", () => {
    const input = {
      id: "int-1",
      reason: "input_required",
      message: "Approve?",
      toolCallId: "tc-1",
      responseSchema: { type: "object" },
      expiresAt: "2026-04-22T00:00:00Z",
      metadata: { foo: "bar" },
    };
    expect(InterruptSchema.parse(input)).toEqual(input);
  });

  it("rejects when id is missing", () => {
    expect(() => InterruptSchema.parse({ reason: "tool_call" })).toThrow();
  });

  it("rejects when reason is missing", () => {
    expect(() => InterruptSchema.parse({ id: "int-1" })).toThrow();
  });
});

describe("ResumeEntrySchema", () => {
  it("accepts resolved entry with payload", () => {
    const parsed = ResumeEntrySchema.parse({
      interruptId: "int-1",
      status: "resolved",
      payload: { approved: true },
    });
    expect(parsed.status).toBe("resolved");
    expect(parsed.payload).toEqual({ approved: true });
  });

  it("accepts cancelled entry without payload", () => {
    const parsed = ResumeEntrySchema.parse({
      interruptId: "int-1",
      status: "cancelled",
    });
    expect(parsed.status).toBe("cancelled");
    expect(parsed.payload).toBeUndefined();
  });

  it("rejects unknown status value", () => {
    expect(() => ResumeEntrySchema.parse({ interruptId: "int-1", status: "denied" })).toThrow();
  });
});

describe("ResumeEntry.metadata", () => {
  // Every JSON shape the protocol promises survives a round trip.
  const VALUE_SHAPES = {
    nullValue: null,
    string: "afterModel-review",
    number: 42,
    float: 1.5,
    boolean: true,
    emptyArray: [],
    array: [1, "two", null, { nested: true }],
    emptyObject: {},
    nested: { signature: { alg: "ed25519", hash: "abc" }, tags: ["a", "b"] },
  };

  it("round-trips every JSON value shape through JSON", () => {
    const entry = ResumeEntrySchema.parse({
      interruptId: "int-1",
      status: "resolved",
      payload: { approved: true },
      metadata: VALUE_SHAPES,
    });
    const restored = ResumeEntrySchema.parse(JSON.parse(JSON.stringify(entry)));
    expect(restored.metadata).toEqual(VALUE_SHAPES);
  });

  it("round-trips an empty metadata object, distinct from absent", () => {
    const restored = ResumeEntrySchema.parse(
      JSON.parse(
        JSON.stringify(
          ResumeEntrySchema.parse({ interruptId: "int-1", status: "resolved", metadata: {} }),
        ),
      ),
    );
    expect(restored.metadata).toEqual({});
  });

  it("is optional", () => {
    const parsed = ResumeEntrySchema.parse({ interruptId: "int-1", status: "cancelled" });
    expect(parsed.metadata).toBeUndefined();
  });

  it("rejects an explicit null", () => {
    // See OptionalMetadataSchema: absent-or-object, never null.
    expect(() =>
      ResumeEntrySchema.parse({
        interruptId: "int-1",
        status: "resolved",
        metadata: null,
      }),
    ).toThrow();
  });

  it("serializes without the key when absent, rather than emitting null", () => {
    const entry = ResumeEntrySchema.parse({ interruptId: "int-1", status: "resolved" });
    expect(JSON.parse(JSON.stringify(entry))).not.toHaveProperty("metadata");
  });

  it("is carried on both statuses", () => {
    const cancelled = ResumeEntrySchema.parse({
      interruptId: "int-1",
      status: "cancelled",
      metadata: { reason: "timeout" },
    });
    expect(cancelled.metadata).toEqual({ reason: "timeout" });
  });

  it("reaches the agent through RunAgentInput.resume", () => {
    const parsed = RunAgentInputSchema.parse({
      threadId: "t-1",
      runId: "r-1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
      resume: [
        {
          interruptId: "generic-1",
          status: "resolved",
          payload: { approved: true },
          metadata: { "ag-ui": {}, definitionId: "review-plan", key: "afterModel-review" },
        },
      ],
    });
    expect(parsed.resume?.[0].metadata).toEqual({
      "ag-ui": {},
      definitionId: "review-plan",
      key: "afterModel-review",
    });
  });
});

describe("RunAgentInput.resume", () => {
  const baseInput = {
    threadId: "t-1",
    runId: "r-1",
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };

  it("reads a bare null state as absent, and preserves nulls inside state", () => {
    // The state contract: optional, absent means "no state", and a bare null is
    // the same statement — every consumer collapses the two, and .NET cannot
    // represent the difference. Coercing here keeps a hand-rolled client that
    // sends "state": null on the same footing as one that omits the key.
    const { state, ...withoutState } = baseInput;
    expect(RunAgentInputSchema.parse(withoutState).state).toBeUndefined();
    expect(RunAgentInputSchema.parse({ ...baseInput, state: null }).state).toBeUndefined();
    expect(RunAgentInputSchema.parse({ ...baseInput, state: { selectedId: null } }).state).toEqual({
      selectedId: null,
    });
  });

  it("accepts input without resume (back-compat)", () => {
    const parsed = RunAgentInputSchema.parse(baseInput);
    expect(parsed.resume).toBeUndefined();
  });

  it("accepts input with a resume array", () => {
    const parsed = RunAgentInputSchema.parse({
      ...baseInput,
      resume: [
        { interruptId: "int-1", status: "resolved", payload: { approved: true } },
        { interruptId: "int-2", status: "cancelled" },
      ],
    });
    expect(parsed.resume).toHaveLength(2);
    expect(parsed.resume?.[0].status).toBe("resolved");
    expect(parsed.resume?.[1].status).toBe("cancelled");
  });

  it("rejects resume entry with invalid status", () => {
    expect(() =>
      RunAgentInputSchema.parse({
        ...baseInput,
        resume: [{ interruptId: "int-1", status: "ignored" }],
      }),
    ).toThrow();
  });
});
