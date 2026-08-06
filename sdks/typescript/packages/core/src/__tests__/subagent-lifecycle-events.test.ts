import { describe, it, expect } from "vitest";
import { EventType, EventSchemas } from "../events";
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

  it("requires name on SUBAGENT_STARTED and message on SUBAGENT_ERROR", () => {
    expect(() =>
      EventSchemas.parse({ type: EventType.SUBAGENT_STARTED, subagentId: "s" }),
    ).toThrow();
    expect(() => EventSchemas.parse({ type: EventType.SUBAGENT_ERROR, subagentId: "s" })).toThrow();
  });
});
