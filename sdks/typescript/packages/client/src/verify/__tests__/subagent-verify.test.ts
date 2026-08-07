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
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
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

  // verify guards tool calls the same way it guards messages, but only the
  // message path had a test. A tool call is the more consequential of the two:
  // its args and result are what travel back to the provider, so an owner
  // disagreement mid-stream is how a subagent's call could be stitched onto the
  // parent's.
  const expectRejectedWith = async (inputEvents: BaseEvent[], message: RegExp) => {
    let caught: unknown;
    try {
      await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(message);
  };

  const expectRejected = (inputEvents: BaseEvent[]) =>
    expectRejectedWith(inputEvents, /does not match/i);

  it("should reject TOOL_CALL_ARGS whose subagentId differs from its opener", async () => {
    await expectRejected([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        subagentId: "s1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc1",
        delta: "{}",
        subagentId: "s2", // <-- disagrees with the opener's s1
      } as ToolCallArgsEvent,
    ]);
  });

  it("should reject TOOL_CALL_END whose subagentId differs from its opener", async () => {
    await expectRejected([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        subagentId: "s1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: "tc1",
        subagentId: "s2",
      } as ToolCallEndEvent,
    ]);
  });

  it("should reject STATE_SNAPSHOT attributed to a subagent", async () => {
    // Only the parent owns state. defaultApplyEvents replaces the shared state
    // without consulting attribution, so without this the subagent's partial view
    // lands as the parent's. The .NET client rejects the same stream.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        {
          type: EventType.SUBAGENT_STARTED,
          subagentId: "s1",
          name: "researcher",
        } as SubagentStartedEvent,
        { type: EventType.STATE_SNAPSHOT, snapshot: { a: 1 }, subagentId: "s1" } as BaseEvent,
      ],
      /only the parent agent owns state/i,
    );
  });

  it("should reject STATE_DELTA attributed to a subagent", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        {
          type: EventType.SUBAGENT_STARTED,
          subagentId: "s1",
          name: "researcher",
        } as SubagentStartedEvent,
        { type: EventType.STATE_DELTA, delta: [], subagentId: "s1" } as BaseEvent,
      ],
      /only the parent agent owns state/i,
    );
  });

  it("should allow unattributed state while a subagent is running", async () => {
    // Control: the parent's own state still flows normally mid-delegation.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "r" } as SubagentStartedEvent,
      { type: EventType.STATE_SNAPSHOT, snapshot: { a: 1 } } as BaseEvent,
      { type: EventType.STATE_DELTA, delta: [] } as BaseEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  it("should reject restarting a subagent that already finished in this run", async () => {
    // Ids are per-invocation. Reusing one gives a single invocation two starts and
    // two terminals, which is what tracking only the ACTIVE set allowed.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "r" } as SubagentStartedEvent,
        { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as SubagentFinishedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "r" } as SubagentStartedEvent,
      ],
      /has already finished in this run/i,
    );
  });

  it("should NOT reject an event tagged with an already-finished subagent", async () => {
    // Pins a deliberate design decision, not an oversight. The verifier's rule is that
    // a continuation must not DISAGREE with its opener; requiring a tag to name a
    // still-live subagent was explicitly rejected so that attribution-only producers —
    // which tag events but never send SUBAGENT_* — stay valid. Tightening this would
    // add a constraint the protocol does not define, so it stays accepted here and a
    // consumer decides how to render it.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "r" } as SubagentStartedEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as SubagentFinishedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        subagentId: "s1",
      } as TextMessageStartEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  it("should reject a second terminal for the same subagent", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "r" } as SubagentStartedEvent,
        { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as SubagentFinishedEvent,
        { type: EventType.SUBAGENT_ERROR, subagentId: "s1", message: "boom" } as BaseEvent,
      ],
      /no active subagent/i,
    );
  });

  it("should let a new run reuse a subagent id closed by the previous run", async () => {
    // The closed set is run-scoped, like every other map in the verifier.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r1" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "r" } as SubagentStartedEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r1" } as RunFinishedEvent,
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r2" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "r" } as SubagentStartedEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r2" } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  it("should reject an ACTIVITY_DELTA whose subagentId differs from its snapshot", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: "a1",
          activityType: "search",
          content: {},
          replace: false,
          subagentId: "s1",
        } as BaseEvent,
        {
          type: EventType.ACTIVITY_DELTA,
          messageId: "a1",
          delta: [],
          subagentId: "s2",
        } as BaseEvent,
      ],
      /does not match/i,
    );
  });

  it("should allow an attribution-only stream with no lifecycle events", async () => {
    // The closed-set rule must not break Phase-1 producers, which tag events but
    // never send SUBAGENT_*. They close nothing, so nothing is ever in the set.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        subagentId: "never-declared",
      } as TextMessageStartEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  it("should allow an untagged continuation of a tagged tool call", async () => {
    // Omitting the tag is not a disagreement: attribution is optional per event,
    // and the opener already established the owner. Only a *different* id is an
    // error, so producers that tag only openers stay valid.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        subagentId: "s1",
      } as ToolCallStartEvent,
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: "{}" } as ToolCallArgsEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(
      verifyEvents(false)(from(inputEvents)).pipe(toArray()),
    );
    expect(events.map((e) => e.type)).toEqual(inputEvents.map((e) => e.type));
  });
});
