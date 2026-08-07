import { describe, it, expect } from "vitest";
import {
  EventType,
  EventSchemas,
  SubagentStartedEventSchema,
  SubagentErrorEventSchema,
} from "../events";
import {
  createSubagentStartedEvent,
  createSubagentFinishedEvent,
  createSubagentErrorEvent,
} from "../event-factories";

describe("subagent lifecycle events", () => {
  it("creates and validates SUBAGENT_STARTED with parent", () => {
    const e = createSubagentStartedEvent({
      subagentId: "sub-1",
      name: "Researcher",
      description: "does research",
      parentSubagentId: "sub-0",
    });
    expect(e.type).toBe(EventType.SUBAGENT_STARTED);
    expect(() => EventSchemas.parse(e)).not.toThrow();
    expect(e.subagentId).toBe("sub-1");
    expect(e.parentSubagentId).toBe("sub-0");
  });

  it("creates SUBAGENT_FINISHED and SUBAGENT_ERROR", () => {
    const fin = createSubagentFinishedEvent({ subagentId: "sub-1" });
    expect(fin.type).toBe(EventType.SUBAGENT_FINISHED);
    const err = createSubagentErrorEvent({
      subagentId: "sub-1",
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
      subagentId: "s1",
      name: "researcher",
      description: null,
      parentSubagentId: null,
      parentToolCallId: null,
      parentMessageId: null,
    });

    expect(started.description).toBeUndefined();
    expect(started.parentSubagentId).toBeUndefined();
    expect(started.parentToolCallId).toBeUndefined();
    expect(started.parentMessageId).toBeUndefined();

    const errored = SubagentErrorEventSchema.parse({
      type: EventType.SUBAGENT_ERROR,
      subagentId: "s1",
      message: "boom",
      code: null,
    });
    expect(errored.code).toBeUndefined();
  });

  it("requires name on SUBAGENT_STARTED and message on SUBAGENT_ERROR", () => {
    expect(() =>
      EventSchemas.parse({ type: EventType.SUBAGENT_STARTED, subagentId: "s" }),
    ).toThrow();
    expect(() => EventSchemas.parse({ type: EventType.SUBAGENT_ERROR, subagentId: "s" })).toThrow();
  });
});
