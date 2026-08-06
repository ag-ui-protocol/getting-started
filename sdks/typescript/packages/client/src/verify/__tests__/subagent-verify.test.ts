import { from, firstValueFrom } from "rxjs";
import { tap, toArray } from "rxjs/operators";
import { verifyEvents } from "../verify";
import {
  BaseEvent,
  EventType,
  AGUIError,
  RunStartedEvent,
  RunFinishedEvent,
  SubagentStartedEvent,
  SubagentFinishedEvent,
  TextMessageStartEvent,
  TextMessageEndEvent,
} from "@ag-ui/core";

describe("verifyEvents subagent lifecycle", () => {
  // Test: A well-formed subagent lifecycle within a run resolves
  it("should allow a well-formed subagent lifecycle within a run", async () => {
    const inputEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread-id",
        runId: "test-run-id",
      } as RunStartedEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentId: "s1",
        name: "sub-agent-1",
      } as SubagentStartedEvent,
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentId: "s1",
      } as SubagentFinishedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread-id",
        runId: "test-run-id",
      } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));

    expect(events.length).toBe(4);
    expect(events[3].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Duplicate SUBAGENT_STARTED for the same id rejects
  it("should reject a duplicate SUBAGENT_STARTED for the same id", async () => {
    const inputEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread-id",
        runId: "test-run-id",
      } as RunStartedEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentId: "s1",
        name: "sub-agent-1",
      } as SubagentStartedEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentId: "s1",
        name: "sub-agent-1",
      } as SubagentStartedEvent,
    ];

    const events: BaseEvent[] = [];
    let caught: unknown;
    try {
      await firstValueFrom(
        verifyEvents(false)(from(inputEvents)).pipe(
          tap((event) => events.push(event)),
          toArray(),
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(/already/i);
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.SUBAGENT_STARTED);
  });

  // Test: SUBAGENT_FINISHED for an id that never started rejects
  it("should reject SUBAGENT_FINISHED for an id that never started", async () => {
    const inputEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread-id",
        runId: "test-run-id",
      } as RunStartedEvent,
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentId: "s1",
      } as SubagentFinishedEvent,
    ];

    const events: BaseEvent[] = [];
    let caught: unknown;
    try {
      await firstValueFrom(
        verifyEvents(false)(from(inputEvents)).pipe(
          tap((event) => events.push(event)),
          toArray(),
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(/not started|no active|matching/i);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: SUBAGENT_STARTED whose parentSubagentId was not started rejects
  it("should reject SUBAGENT_STARTED whose parentSubagentId was not started", async () => {
    const inputEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread-id",
        runId: "test-run-id",
      } as RunStartedEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentId: "s1",
        name: "sub-agent-1",
        parentSubagentId: "missing-parent",
      } as SubagentStartedEvent,
    ];

    const events: BaseEvent[] = [];
    let caught: unknown;
    try {
      await firstValueFrom(
        verifyEvents(false)(from(inputEvents)).pipe(
          tap((event) => events.push(event)),
          toArray(),
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(/parent/i);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: RUN_FINISHED while a subagent is still open rejects
  it("should reject RUN_FINISHED while a subagent is still open", async () => {
    const inputEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread-id",
        runId: "test-run-id",
      } as RunStartedEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentId: "s1",
        name: "sub-agent-1",
      } as SubagentStartedEvent,
      // Intentionally not finishing s1
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread-id",
        runId: "test-run-id",
      } as RunFinishedEvent,
    ];

    const events: BaseEvent[] = [];
    let caught: unknown;
    try {
      await firstValueFrom(
        verifyEvents(false)(from(inputEvents)).pipe(
          tap((event) => events.push(event)),
          toArray(),
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(/subagent/i);
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.SUBAGENT_STARTED);
  });

  // Test: A stream with no lifecycle events at all is still valid
  it("should allow a stream with no subagent lifecycle events", async () => {
    const inputEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread-id",
        runId: "test-run-id",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        subagentId: "s1",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
        subagentId: "s1",
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread-id",
        runId: "test-run-id",
      } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));

    expect(events.length).toBe(4);
    expect(events[3].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: a continuation/close event tagged with a different subagent than its
  // opener is rejected.
  it("should reject a close event whose subagentId differs from its opener", async () => {
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        subagentId: "s1",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
        subagentId: "s2", // <-- disagrees with the opener's s1
      } as TextMessageEndEvent,
    ];

    const events: BaseEvent[] = [];
    let caught: unknown;
    try {
      await firstValueFrom(
        verifyEvents(false)(from(inputEvents)).pipe(
          tap((e) => events.push(e)),
          toArray(),
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(/does not match/i);
  });
});
