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
        subagentRunId: "s1",
        name: "sub-agent-1",
      } as SubagentStartedEvent,
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: "s1",
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
        subagentRunId: "s1",
        name: "sub-agent-1",
      } as SubagentStartedEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "s1",
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
        subagentRunId: "s1",
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

  // Test: SUBAGENT_STARTED whose parentSubagentRunId was not started rejects
  it("should reject SUBAGENT_STARTED whose parentSubagentRunId was not started", async () => {
    const inputEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread-id",
        runId: "test-run-id",
      } as RunStartedEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "s1",
        name: "sub-agent-1",
        parentSubagentRunId: "missing-parent",
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
        subagentRunId: "s1",
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
        subagentRunId: "s1",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
        subagentRunId: "s1",
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
  it("should reject a close event whose subagentRunId differs from its opener", async () => {
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        subagentRunId: "s1",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
        subagentRunId: "s2", // <-- disagrees with the opener's s1
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

  it("should reject TOOL_CALL_ARGS whose subagentRunId differs from its opener", async () => {
    await expectRejected([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        subagentRunId: "s1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc1",
        delta: "{}",
        subagentRunId: "s2", // <-- disagrees with the opener's s1
      } as ToolCallArgsEvent,
    ]);
  });

  it("should reject TOOL_CALL_END whose subagentRunId differs from its opener", async () => {
    await expectRejected([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        subagentRunId: "s1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: "tc1",
        subagentRunId: "s2",
      } as ToolCallEndEvent,
    ]);
  });

  it("should ACCEPT state events attributed to a subagent", async () => {
    // The protocol design lists STATE_SNAPSHOT / STATE_DELTA as carrying
    // attribution, in the same standalone category as STEP_*, CUSTOM and RAW.
    // Attribution on them is PROVENANCE — which subagent produced the update —
    // not ownership; the state itself stays run-scoped and is applied run-scoped.
    //
    // An earlier revision of the verifier REJECTED these, which made this client
    // stricter than the protocol and would have thrown on a conforming producer.
    // This test exists to keep that from coming back.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "s1",
        name: "researcher",
      } as SubagentStartedEvent,
      { type: EventType.STATE_SNAPSHOT, snapshot: { a: 1 }, subagentRunId: "s1" } as BaseEvent,
      { type: EventType.STATE_DELTA, delta: [], subagentRunId: "s1" } as BaseEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
    // Attribution survives verification rather than being stripped.
    expect((events[2] as { subagentRunId?: string }).subagentRunId).toBe("s1");
    expect((events[3] as { subagentRunId?: string }).subagentRunId).toBe("s1");
  });

  it("should allow unattributed state while a subagent is running", async () => {
    // Control: the parent's own state still flows normally mid-delegation.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as SubagentStartedEvent,
      { type: EventType.STATE_SNAPSHOT, snapshot: { a: 1 } } as BaseEvent,
      { type: EventType.STATE_DELTA, delta: [] } as BaseEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
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
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as SubagentStartedEvent,
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as SubagentStartedEvent,
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
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as SubagentStartedEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        subagentRunId: "s1",
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
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as SubagentStartedEvent,
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
        { type: EventType.SUBAGENT_ERROR, subagentRunId: "s1", message: "boom" } as BaseEvent,
      ],
      /no active subagent/i,
    );
  });

  it("should let a new run reuse a subagent id closed by the previous run", async () => {
    // The closed set is run-scoped, like every other map in the verifier.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r1" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as SubagentStartedEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r1" } as RunFinishedEvent,
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r2" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as SubagentStartedEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r2" } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  it("should reject an ACTIVITY_DELTA whose subagentRunId differs from its snapshot", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: "a1",
          activityType: "search",
          content: {},
          replace: false,
          subagentRunId: "s1",
        } as BaseEvent,
        {
          type: EventType.ACTIVITY_DELTA,
          messageId: "a1",
          delta: [],
          subagentRunId: "s2",
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
        subagentRunId: "never-declared",
      } as TextMessageStartEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  it("should reject a tagged continuation of an UNTAGGED (parent-owned) opener", async () => {
    // An untagged opener means the entity belongs to the parent, which is as much an
    // owner as a subagent — so a tagged continuation on it still disagrees. Comparing
    // only when the recorded owner had an id let this through, and the reducer would
    // append a subagent's text to a parent-owned message.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as TextMessageStartEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "x",
          subagentRunId: "s1",
        } as BaseEvent,
      ],
      /does not match/i,
    );
  });

  it("should reject REASONING_END whose owner differs from the reasoning opener", async () => {
    // The owner has to survive REASONING_MESSAGE_END, since REASONING_END closes the
    // outer reasoning afterwards. Retiring it at the message end left the outer close
    // with nothing to compare against.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.REASONING_START, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: "r1",
          role: "reasoning",
          subagentRunId: "s1",
        } as BaseEvent,
        { type: EventType.REASONING_MESSAGE_END, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.REASONING_END, messageId: "r1", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match/i,
    );
  });

  it("should reject a tool-call encrypted value whose owner differs from the tool call", async () => {
    // REASONING_ENCRYPTED_VALUE continues whichever entity its `subtype` names, so a
    // "tool-call" value has to be checked against the TOOL CALL's owner. Looking only in
    // the reasoning map found nothing and accepted s2's value against s1's call.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc1",
          toolCallName: "search",
          subagentRunId: "s1",
        } as ToolCallStartEvent,
        {
          type: EventType.REASONING_ENCRYPTED_VALUE,
          subtype: "tool-call",
          entityId: "tc1",
          encryptedValue: "opaque",
          subagentRunId: "s2",
        } as BaseEvent,
      ],
      /does not match/i,
    );
  });

  it("should allow a child whose parent has already finished", async () => {
    // The rule is that parentSubagentRunId must have been STARTED, not that it must still be
    // active. Checking only the active set was stricter than the protocol defines and
    // rejected this valid lifecycle.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "p", name: "parent" } as SubagentStartedEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "p" } as SubagentFinishedEvent,
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "c",
        name: "child",
        parentSubagentRunId: "p",
      } as SubagentStartedEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "c" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  it("should still reject a parent never started in this run", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        {
          type: EventType.SUBAGENT_STARTED,
          subagentRunId: "c",
          name: "child",
          parentSubagentRunId: "ghost",
        } as SubagentStartedEvent,
      ],
      /has not been started/i,
    );
  });

  it("should not let a non-replacing ACTIVITY_SNAPSHOT take over an activity", async () => {
    // The reducer leaves the existing activity alone when replace is false, so the tracked
    // owner must not change either, or a following delta under the new tag patches a
    // message someone else owns.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: "a1",
          activityType: "search",
          content: {},
          replace: false,
          subagentRunId: "s1",
        } as BaseEvent,
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: "a1",
          activityType: "search",
          content: {},
          replace: false,
          subagentRunId: "s2",
        } as BaseEvent,
        {
          type: EventType.ACTIVITY_DELTA,
          messageId: "a1",
          delta: [],
          subagentRunId: "s2",
        } as BaseEvent,
      ],
      /does not match/i,
    );
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
        subagentRunId: "s1",
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

  // Step ownership. All three cases come from one real deepagents run reported by a
  // design partner, where a subagent ran inside the parent's `tools` step and the
  // subagent's own inner step was ALSO called `tools` -- normal, since a subagent runs
  // the same graph shape as its parent, and step names come from graph node names.
  //
  // Before steps were owner-scoped the verifier had it exactly backwards: it ACCEPTED
  // that run's mis-attributed closes and REJECTED the correctly nested stream. Both
  // directions are pinned here.

  it("should accept the parent and a subagent both having a step of the same name open", async () => {
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      // The parent's `tools` step wraps the whole delegation, untagged.
      { type: EventType.STEP_STARTED, stepName: "tools" } as BaseEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "alpha" } as SubagentStartedEvent,
      // The subagent's own inner step, same name, tagged.
      { type: EventType.STEP_STARTED, stepName: "tools", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.STEP_FINISHED, stepName: "tools", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
      // The parent's step closes AFTER the subagent run, still untagged.
      { type: EventType.STEP_FINISHED, stepName: "tools" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];

    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  it("should reject a STEP_FINISHED that closes the PARENT's step under a subagent's tag", async () => {
    // The reported bug: the producer stamped attribution from "whichever subagent is
    // currently active", so the parent's step close carried the subagent's id.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.STEP_STARTED, stepName: "tools" } as BaseEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "alpha" } as SubagentStartedEvent,
        { type: EventType.STEP_FINISHED, stepName: "tools", subagentRunId: "s1" } as BaseEvent,
      ],
      /that step is open under the parent agent.*finished by whoever started it/i,
    );
  });

  it("should reject a STEP_FINISHED that closes a SUBAGENT's step untagged", async () => {
    // The same bug in the other direction, from the end of that run: once the subagent
    // had been popped from the namespace, its own step close went out untagged.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "alpha" } as SubagentStartedEvent,
        { type: EventType.STEP_STARTED, stepName: "inner", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.STEP_FINISHED, stepName: "inner" } as BaseEvent,
      ],
      /attributed to the parent agent.*open under subagent 's1'/i,
    );
  });

  it("should name the owner of an unfinished subagent step at RUN_FINISHED", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "alpha" } as SubagentStartedEvent,
        { type: EventType.STEP_STARTED, stepName: "inner", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
      ],
      /steps are still active: inner \(subagent 's1'\)/i,
    );
  });

  // Owner-namespace and default-value fixes from PR review. Each case below is the
  // reviewer's own minimal sequence; each passed verification before the fix.

  it("should reject an encrypted MESSAGE value whose id collides with a tool call", async () => {
    // Ids are only unique within a kind, so a message and a tool call may both be "x".
    // A single owner map let the tool-call write clobber the message's owner, and the
    // encrypted value naming that id was then checked against the wrong owner.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" } as SubagentStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s2", name: "b" } as SubagentStartedEvent,
        { type: EventType.TEXT_MESSAGE_START, messageId: "x", role: "assistant", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.TOOL_CALL_START, toolCallId: "x", toolCallName: "t", subagentRunId: "s2" } as BaseEvent,
        { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: "message", entityId: "x", value: "v", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the message 'x'/i,
    );
  });

  it("should keep a tool call's owner after TOOL_CALL_END for a later encrypted value", async () => {
    // The reason owners are retained per run rather than dropped on close.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" } as SubagentStartedEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "c", toolCallName: "t", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "c", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: "tool-call", entityId: "c", value: "v", subagentRunId: "s1" } as BaseEvent,
      // #2300: the run has to reach a terminal event, and RUN_FINISHED is refused while a
      // subagent is still active, so this fixture now closes what it opened.
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];
    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  it("should reject a second reasoning opener that contradicts the first", async () => {
    // The verifier kept the first owner while the reducer mints the message from the
    // SECOND, so content then appended to a message owned by someone else.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" } as SubagentStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s2", name: "b" } as SubagentStartedEvent,
        { type: EventType.REASONING_START, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the reasoning message 'r1'/i,
    );
  });

  it("should treat the empty string as a real subagent id, distinct from the parent", async () => {
    // "" is a legal opaque id. Joining owner and step name into one key with a separator
    // made the parent (no owner) and an empty-id subagent collide, so that subagent could
    // close the parent's step. Both directions are pinned.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "", name: "a" } as SubagentStartedEvent,
        { type: EventType.STEP_STARTED, stepName: "tools" } as BaseEvent,
        { type: EventType.STEP_FINISHED, stepName: "tools", subagentRunId: "" } as BaseEvent,
      ],
      /that step is open under the parent agent/i,
    );

    const valid: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "", name: "a" } as SubagentStartedEvent,
      { type: EventType.STEP_STARTED, stepName: "tools" } as BaseEvent,
      { type: EventType.STEP_STARTED, stepName: "tools", subagentRunId: "" } as BaseEvent,
      { type: EventType.STEP_FINISHED, stepName: "tools", subagentRunId: "" } as BaseEvent,
      { type: EventType.STEP_FINISHED, stepName: "tools" } as BaseEvent,
      // #2300: the run has to reach a terminal event, and RUN_FINISHED is refused while a
      // subagent is still active, so this fixture now closes what it opened.
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];
    const events = await firstValueFrom(verifyEvents(false)(from(valid)).pipe(toArray()));
    expect(events).toHaveLength(valid.length);
  });

  it("should treat an omitted activity `replace` as true, matching the schema and reducer", async () => {
    // The schema defaults replace to true and the reducer uses `?? true`; the verifier
    // required an explicit true, so it kept the first owner and rejected the valid delta
    // for a typed producer that had not gone through Zod.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" } as SubagentStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s2", name: "b" } as SubagentStartedEvent,
      { type: EventType.ACTIVITY_SNAPSHOT, messageId: "a1", activityType: "x", content: {}, subagentRunId: "s1" } as BaseEvent,
      { type: EventType.ACTIVITY_SNAPSHOT, messageId: "a1", activityType: "x", content: {}, subagentRunId: "s2" } as BaseEvent,
      { type: EventType.ACTIVITY_DELTA, messageId: "a1", content: {}, subagentRunId: "s2" } as BaseEvent,
      // #2300: the run has to reach a terminal event, and RUN_FINISHED is refused while a
      // subagent is still active, so this fixture now closes what it opened.
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s2" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];
    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  it("should still accept an attribution-only stream with ids that were never started", async () => {
    // The design deliberately supports Phase-1 attribution WITHOUT lifecycle events, so
    // an id that no SUBAGENT_STARTED ever named is valid. Pinned because a review asked
    // for the opposite, and the docs -- not the code -- were what claimed the rule.
    const inputEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "never-started" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "x", subagentRunId: "never-started" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m", subagentRunId: "never-started" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ];
    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  });

  const expectAccepted = async (inputEvents: BaseEvent[]) => {
    const events = await firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));
    expect(events).toHaveLength(inputEvents.length);
  };

  // The `subtype: "message"` encrypted value spans BOTH message kinds. Its canonical use
  // in the docs is attaching an opaque provider blob to a REASONING message, whose owner
  // lives in the reasoning bucket -- so looking only at the text-message bucket meant the
  // check silently never fired for the case it was written for.

  it("should reject a `message` encrypted value that disagrees with its REASONING owner", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" } as SubagentStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s2", name: "b" } as SubagentStartedEvent,
        { type: EventType.REASONING_START, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.REASONING_MESSAGE_END, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: "message", entityId: "r1", value: "v", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the message 'r1'/i,
    );
  });

  it("should accept a `message` encrypted value that agrees with its REASONING owner", async () => {
    await expectAccepted([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" } as SubagentStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s2", name: "b" } as SubagentStartedEvent,
      { type: EventType.REASONING_START, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: "message", entityId: "r1", value: "v", subagentRunId: "s1" } as BaseEvent,
      // #2300: the run has to reach a terminal event, and RUN_FINISHED is refused while a
      // subagent is still active, so this fixture now closes what it opened.
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" } as SubagentFinishedEvent,
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s2" } as SubagentFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ]);
  });

  it("should reject a `message` encrypted value that disagrees with its TEXT message owner", async () => {
    // The other half of the "message" subtype, kept alongside the reasoning case so the
    // two-bucket lookup cannot regress in either direction.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" } as SubagentStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s2", name: "b" } as SubagentStartedEvent,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_END, messageId: "m1", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: "message", entityId: "m1", value: "v", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the message 'm1'/i,
    );
  });

  // Reopening a CLOSED id. The openers used to check attribution against an owner of
  // `undefined`, which can never disagree, so a second producer could reopen an id the
  // first one had closed -- and the reducer appends its content into the first's message.

  it("should reject a TEXT_MESSAGE_START that reopens a closed id under a different subagent", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "x", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_END, messageId: "m1", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the message 'm1'/i,
    );
  });

  it("should reject a TOOL_CALL_START that reopens a closed id under a different subagent", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: "{}", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: "tc1", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the tool call 'tc1'/i,
    );
  });

  it("should accept reopening a closed id under the SAME subagent", async () => {
    await expectAccepted([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ]);
  });

  it("should keep the first owner when an UNTAGGED opener reopens a tagged id", async () => {
    // First writer wins. An untagged reopen is not a disagreement (an absent tag never
    // is), but it must not OVERWRITE the retained owner with `undefined` either -- the
    // s1-tagged continuation that follows proves the owner is still s1.
    await expectAccepted([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "x", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" } as BaseEvent,
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: "{}", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ]);
  });

  it("should reject an encrypted value naming a CLOSED tool call under a different subagent", async () => {
    // The reject direction of owner retention. The accept-direction test above cannot
    // fail if retention is reverted, since a missing owner is simply not checked.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" } as SubagentStartedEvent,
        { type: EventType.TOOL_CALL_START, toolCallId: "c", toolCallName: "t", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: "c", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: "tool-call", entityId: "c", value: "v", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the tool call 'c'/i,
    );
  });

  it("should clear the retained owner buckets on a new run", async () => {
    // Owners are retained for the RUN, not forever: run 2 knows nothing about run 1's
    // tool call, so an encrypted value naming that id has no owner to disagree with.
    await expectAccepted([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r1" } as RunStartedEvent,
      { type: EventType.TOOL_CALL_START, toolCallId: "c", toolCallName: "t", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "c", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r1" } as RunFinishedEvent,
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r2" } as RunStartedEvent,
      { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: "tool-call", entityId: "c", value: "v", subagentRunId: "s2" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r2" } as RunFinishedEvent,
    ]);
  });

  // Reasoning openers. Only the disagreeing case was pinned, so the three directions
  // that must NOT change were free to drift.

  it("should accept a second reasoning opener that agrees with the first", async () => {
    await expectAccepted([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.REASONING_START, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_END, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ]);
  });

  it("should accept an UNTAGGED second reasoning opener on a tagged first", async () => {
    // An absent tag never disagrees, and the retained owner stays s1 -- which the
    // s1-tagged content that follows would fail on if it had been overwritten.
    await expectAccepted([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.REASONING_START, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "x", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_END, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ]);
  });

  it("should keep the reasoning owner when an UNTAGGED opener reopens after REASONING_END", async () => {
    // Same first-writer-wins rule as the message and tool-call openers: the owner
    // outlives REASONING_END, so an untagged reopen must not hand the id to the parent.
    await expectAccepted([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.REASONING_START, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_END, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_START, messageId: "r1" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.REASONING_END, messageId: "r1", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent,
    ]);
  });

  it("should reject a TAGGED second reasoning opener on an UNTAGGED (parent-owned) first", async () => {
    // The parent is an owner too, so the second opener contradicts it.
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.REASONING_START, messageId: "r1" } as BaseEvent,
        { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning", subagentRunId: "s1" } as BaseEvent,
      ],
      /does not match the reasoning message 'r1' opener's subagent '\(the parent agent\)'/i,
    );
  });

  // The empty string is a legal opaque subagent id, and it is falsy -- so it must be
  // distinguished from "no tag" on the message path too, not only on steps.

  it("should reject an empty-string-tagged continuation of a parent-owned message", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "x", subagentRunId: "" } as BaseEvent,
      ],
      /does not match the message 'm' opener's subagent '\(the parent agent\)'/i,
    );
  });

  it("should reject an s1-tagged continuation of a message owned by the empty-string subagent", async () => {
    await expectRejectedWith(
      [
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "x", subagentRunId: "s1" } as BaseEvent,
      ],
      /does not match the message 'm' opener's subagent ''/i,
    );
  });
});

describe("verifyEvents subagent ownership seeded from snapshots", () => {
  const run = (inputEvents: BaseEvent[]) =>
    firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));

  const expectRejectedWith = async (inputEvents: BaseEvent[], message: RegExp) => {
    let caught: unknown;
    try {
      await run(inputEvents);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(message);
  };

  const started = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent;
  const finished = { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent;
  const snapshotWith = (messages: unknown[]) =>
    ({ type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent);

  it("should reject reopening a snapshot message under a different subagent", async () => {
    // The exact replay-corruption sequence: without seeding, the verifier
    // accepted this and the reducer appended s2's content into s1's message.
    await expectRejectedWith(
      [
        started,
        snapshotWith([{ id: "m", role: "assistant", content: "old", subagentRunId: "s1" }]),
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the message 'm' opener's subagent 's1'/i,
    );
  });

  it("should reject a tagged reopen of a parent-owned snapshot message", async () => {
    await expectRejectedWith(
      [
        started,
        snapshotWith([{ id: "m", role: "assistant", content: "old" }]),
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s2" } as BaseEvent,
      ],
      /\(the parent agent\)/i,
    );
  });

  it("should accept reopening a snapshot message under its own subagent, and untagged", async () => {
    const events = await run([
      started,
      snapshotWith([{ id: "m", role: "assistant", content: "old", subagentRunId: "s1" }]),
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "new" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m" } as BaseEvent,
      // Untagged never disagrees with any owner.
      { type: EventType.TEXT_MESSAGE_START, messageId: "m2", role: "assistant" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m2" } as BaseEvent,
      finished,
    ]);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("should seed ownership from the RUN_STARTED input echo", async () => {
    // RUN_STARTED.input is inside the verified stream and the reducer applies
    // its messages, so replayed history arriving this way must seed exactly
    // like a snapshot — without it, reopening an input message under another
    // owner appended the new producer's content into the old owner's message.
    await expectRejectedWith(
      [
        {
          type: EventType.RUN_STARTED,
          threadId: "t",
          runId: "r",
          input: {
            threadId: "t",
            runId: "r",
            state: {},
            tools: [],
            context: [],
            messages: [{ id: "m", role: "assistant", content: "old", subagentRunId: "s1" }],
          },
        } as unknown as RunStartedEvent,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the message 'm' opener's subagent 's1'/i,
    );
  });

  it("should seed a snapshot reasoning message into the reasoning owner map", async () => {
    await expectRejectedWith(
      [
        started,
        snapshotWith([{ id: "r1", role: "reasoning", content: "old", subagentRunId: "s1" }]),
        { type: EventType.REASONING_MESSAGE_START, messageId: "r1", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the reasoning message 'r1' opener's subagent 's1'/i,
    );
  });

  it("should let a later snapshot authoritatively replace a recorded owner", async () => {
    // A snapshot restates the whole conversation and the reducer replaces the
    // message, so the verifier's map must follow it — keeping the old owner
    // while the document says otherwise made the two contradict each other.
    await expectRejectedWith(
      [
        started,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s1" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_END, messageId: "m", subagentRunId: "s1" } as BaseEvent,
        snapshotWith([{ id: "m", role: "assistant", content: "snapshot", subagentRunId: "s2" }]),
        // The OLD owner no longer matches: the snapshot moved the message to s2.
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s1" } as BaseEvent,
      ],
      /does not match the message 'm' opener's subagent 's2'/i,
    );
  });

  it("should accept the snapshot's new owner after it replaces the recorded one", async () => {
    const events = await run([
      started,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m", subagentRunId: "s1" } as BaseEvent,
      snapshotWith([{ id: "m", role: "assistant", content: "snapshot", subagentRunId: "s2" }]),
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s2" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m", subagentRunId: "s2" } as BaseEvent,
      finished,
    ]);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("should reject replaying a snapshot tool call under a different subagent", async () => {
    await expectRejectedWith(
      [
        started,
        snapshotWith([
          {
            id: "m",
            role: "assistant",
            subagentRunId: "s1",
            toolCalls: [
              { id: "tc", type: "function", function: { name: "search", arguments: "{}" } },
            ],
          },
        ]),
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc",
          toolCallName: "search",
          subagentRunId: "s2",
        } as ToolCallStartEvent,
      ],
      /does not match the tool call 'tc' opener's subagent 's1'/i,
    );
  });
});

describe("verifyEvents activity ownership survives a replace:false snapshot", () => {
  const run = (inputEvents: BaseEvent[]) =>
    firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));

  const expectRejectedWith = async (inputEvents: BaseEvent[], message: RegExp) => {
    let caught: unknown;
    try {
      await run(inputEvents);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(message);
  };

  const started = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent;
  const finished = { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent;
  const seededActivity = {
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [
      { id: "a", role: "activity", activityType: "PLAN", content: {}, subagentRunId: "s1" },
    ],
  } as BaseEvent;

  // The "known activity" gate is the owners map that snapshot seeding fills —
  // .NET gates on its activityOwners the same way. A separate known-ids set let
  // a replace:false snapshot pass the is-new test on a seeded activity and
  // re-own it, so the following delta patched a message the reducer still
  // attributes to s1.
  it("rejects a delta under the re-owner after a replace:false snapshot on a seeded activity", async () => {
    await expectRejectedWith(
      [
        started,
        seededActivity,
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: "a",
          activityType: "PLAN",
          content: {},
          replace: false,
          subagentRunId: "s2",
        } as BaseEvent,
        {
          type: EventType.ACTIVITY_DELTA,
          messageId: "a",
          patch: [],
          subagentRunId: "s2",
        } as BaseEvent,
      ],
      /does not match the activity 'a' opener's subagent 's1'/i,
    );
  });

  it("accepts a REPLACING snapshot re-owning a seeded activity, and the new owner's delta", async () => {
    const events = await run([
      started,
      seededActivity,
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "a",
        activityType: "PLAN",
        content: {},
        replace: true,
        subagentRunId: "s2",
      } as BaseEvent,
      {
        type: EventType.ACTIVITY_DELTA,
        messageId: "a",
        patch: [],
        subagentRunId: "s2",
      } as BaseEvent,
      finished,
    ]);
    expect(events).toHaveLength(5);
  });
});

describe("verifyEvents tool result mints an owned message", () => {
  const run = (inputEvents: BaseEvent[]) =>
    firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));

  const expectRejectedWith = async (inputEvents: BaseEvent[], message: RegExp) => {
    let caught: unknown;
    try {
      await run(inputEvents);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(message);
  };

  const started = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent;
  const finished = { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent;
  const s1Result = {
    type: EventType.TOOL_CALL_RESULT,
    messageId: "m",
    toolCallId: "tc",
    content: "done",
    subagentRunId: "s1",
  } as BaseEvent;

  // TOOL_CALL_RESULT mints the tool message the reducer inserts. Without an
  // ownership record for the minted id, reopening it through another
  // producer's text events passed and appended their content into it.
  it("rejects reopening a result-minted message under a different subagent", async () => {
    await expectRejectedWith(
      [
        started,
        s1Result,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s2" } as BaseEvent,
      ],
      /does not match the message 'm' opener's subagent 's1'/i,
    );
  });

  it("rejects a tagged reopen of a message minted by an UNTAGGED result", async () => {
    await expectRejectedWith(
      [
        started,
        { type: EventType.TOOL_CALL_RESULT, messageId: "m", toolCallId: "tc", content: "done" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s2" } as BaseEvent,
      ],
      /\(the parent agent\)/i,
    );
  });

  it("accepts an untagged or same-owner reopen of a result-minted message", async () => {
    const events = await run([
      started,
      s1Result,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s1" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m" } as BaseEvent,
      finished,
    ]);
    expect(events).toHaveLength(5);
  });
});

describe("verifyEvents rejects null anywhere on the subagent surface", () => {
  const run = (inputEvents: BaseEvent[]) =>
    firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));

  const expectRejectedWith = async (inputEvents: BaseEvent[], message: RegExp) => {
    let caught: unknown;
    try {
      await run(inputEvents);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(message);
  };

  const started = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent;

  // The zod schemas reject these on the wire; in-process producers bypass zod,
  // and a null tag that slipped through persisted into message state and was
  // re-serialized onto the next run's input. Same precedent as the lifecycle
  // required-field checks.
  it("rejects a null attribution tag on any event", async () => {
    await expectRejectedWith(
      [
        started,
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "m",
          role: "assistant",
          subagentRunId: null,
        } as unknown as BaseEvent,
      ],
      /'subagentRunId: null'.*omit it entirely/i,
    );
  });

  it("rejects a null tag nested in MESSAGES_SNAPSHOT and the RUN_STARTED input echo", async () => {
    await expectRejectedWith(
      [
        started,
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [{ id: "m", role: "assistant", content: "x", subagentRunId: null }],
        } as unknown as BaseEvent,
      ],
      /message \(id 'm'\) with 'subagentRunId: null'/i,
    );
    await expectRejectedWith(
      [
        {
          type: EventType.RUN_STARTED,
          threadId: "t",
          runId: "r",
          input: {
            messages: [{ id: "m", role: "assistant", content: "x", subagentRunId: null }],
          },
        } as unknown as BaseEvent,
      ],
      /message \(id 'm'\) with 'subagentRunId: null'/i,
    );
  });

  it("rejects null one level deeper: outcome.interruptIds and interrupt tags", async () => {
    await expectRejectedWith(
      [
        started,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as BaseEvent,
        {
          type: EventType.SUBAGENT_FINISHED,
          subagentRunId: "s1",
          outcome: { type: "suspended", interruptIds: null },
        } as unknown as BaseEvent,
      ],
      /'outcome.interruptIds: null'/i,
    );
    await expectRejectedWith(
      [
        started,
        {
          type: EventType.RUN_FINISHED,
          threadId: "t",
          runId: "r",
          outcome: {
            type: "interrupt",
            interrupts: [{ id: "int-1", reason: "approval", subagentRunId: null }],
          },
        } as unknown as BaseEvent,
      ],
      /interrupt \(id 'int-1'\) carrying 'subagentRunId: null'/i,
    );
  });

  it("rejects null on the lifecycle events' optional fields", async () => {
    await expectRejectedWith(
      [
        started,
        {
          type: EventType.SUBAGENT_STARTED,
          subagentRunId: "s1",
          name: "researcher",
          parentSubagentRunId: null,
        } as unknown as BaseEvent,
      ],
      /'parentSubagentRunId: null'/i,
    );
    await expectRejectedWith(
      [
        started,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as BaseEvent,
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1", outcome: null } as unknown as BaseEvent,
      ],
      /'outcome: null'/i,
    );
    await expectRejectedWith(
      [
        started,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as BaseEvent,
        {
          type: EventType.SUBAGENT_ERROR,
          subagentRunId: "s1",
          message: "boom",
          code: null,
        } as unknown as BaseEvent,
      ],
      /'code: null'/i,
    );
  });
});

describe("verifyEvents rejects non-string interruptIds entries", () => {
  const run = (inputEvents: BaseEvent[]) =>
    firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));

  it("rejects a null element inside outcome.interruptIds", async () => {
    // The field-level null check alone let `interruptIds: [null]` through,
    // contradicting the string[] schema.
    let caught: unknown;
    try {
      await run([
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as BaseEvent,
        {
          type: EventType.SUBAGENT_FINISHED,
          subagentRunId: "s1",
          outcome: { type: "suspended", interruptIds: [null] },
        } as unknown as BaseEvent,
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(/non-string entry in 'outcome.interruptIds'/i);
  });

  it("rejects an outcome whose discriminant is not success or suspended", async () => {
    // The schema's discriminated union rejects these on the wire; the verifier
    // must reject them in-process too — a null discriminant slipped through the
    // field-level checks.
    for (const badType of [null, "paused", undefined]) {
      let caught: unknown;
      try {
        await run([
          { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
          { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as BaseEvent,
          {
            type: EventType.SUBAGENT_FINISHED,
            subagentRunId: "s1",
            outcome: { type: badType },
          } as unknown as BaseEvent,
        ]);
      } catch (err) {
        caught = err;
      }
      expect(caught, `outcome.type=${String(badType)}`).toBeInstanceOf(AGUIError);
      expect((caught as Error).message).toMatch(/outcome type/i);
    }
  });

  it("rejects falsy PRESENT outcomes — only undefined is absent", async () => {
    // `finishedOutcome &&` skipped "" / false / 0, all of which the schema
    // rejects.
    for (const badOutcome of ["", false, 0]) {
      let caught: unknown;
      try {
        await run([
          { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
          { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as BaseEvent,
          {
            type: EventType.SUBAGENT_FINISHED,
            subagentRunId: "s1",
            outcome: badOutcome,
          } as unknown as BaseEvent,
        ]);
      } catch (err) {
        caught = err;
      }
      expect(caught, `outcome=${JSON.stringify(badOutcome)}`).toBeInstanceOf(AGUIError);
    }
  });

  it("accepts a well-formed interruptIds list", async () => {
    const events = await run([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "r" } as BaseEvent,
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: "s1",
        outcome: { type: "suspended", interruptIds: ["int-1"] },
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "r",
        outcome: { type: "interrupt", interrupts: [{ id: "int-1", reason: "approval" }] },
      } as unknown as BaseEvent,
    ]);
    expect(events).toHaveLength(4);
  });
});

describe("verifyEvents subagent lifecycle required fields", () => {
  const started = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent;

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

  it("should reject SUBAGENT_STARTED without a subagentRunId", async () => {
    await expectRejectedWith(
      [started, { type: EventType.SUBAGENT_STARTED, name: "worker" } as BaseEvent],
      /SUBAGENT_STARTED.*subagentRunId/i,
    );
  });

  it("should reject SUBAGENT_STARTED without a name", async () => {
    await expectRejectedWith(
      [started, { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1" } as BaseEvent],
      /SUBAGENT_STARTED.*name/i,
    );
  });

  it("should reject SUBAGENT_FINISHED without a subagentRunId", async () => {
    await expectRejectedWith(
      [
        started,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "worker" } as BaseEvent,
        { type: EventType.SUBAGENT_FINISHED } as BaseEvent,
      ],
      /SUBAGENT_FINISHED.*subagentRunId/i,
    );
  });

  it("should reject SUBAGENT_ERROR without a message", async () => {
    await expectRejectedWith(
      [
        started,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "worker" } as BaseEvent,
        { type: EventType.SUBAGENT_ERROR, subagentRunId: "s1" } as BaseEvent,
      ],
      /SUBAGENT_ERROR.*message/i,
    );
  });
});

describe("verifyEvents tool call vs parent message ownership", () => {
  const started = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as RunStartedEvent;
  const finished = { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as RunFinishedEvent;

  const run = (inputEvents: BaseEvent[]) =>
    firstValueFrom(verifyEvents(false)(from(inputEvents)).pipe(toArray()));

  const expectRejectedWith = async (inputEvents: BaseEvent[], message: RegExp) => {
    let caught: unknown;
    try {
      await run(inputEvents);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AGUIError);
    expect((caught as Error).message).toMatch(message);
  };

  const s1Message: BaseEvent[] = [
    { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", subagentRunId: "s1" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: "m", subagentRunId: "s1" } as BaseEvent,
  ];

  it("should reject a tool call whose explicit owner conflicts with its parent message's owner", async () => {
    // ToolCall has no attribution field of its own, so accepting this
    // guarantees s2's call is silently recorded inside s1's message.
    await expectRejectedWith(
      [
        started,
        ...s1Message,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc",
          toolCallName: "search",
          parentMessageId: "m",
          subagentRunId: "s2",
        } as ToolCallStartEvent,
      ],
      /parent message 'm'/i,
    );
  });

  it("should reject a tagged tool call on a parent-owned message", async () => {
    await expectRejectedWith(
      [
        started,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_END, messageId: "m" } as BaseEvent,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc",
          toolCallName: "search",
          parentMessageId: "m",
          subagentRunId: "s2",
        } as ToolCallStartEvent,
      ],
      /\(the parent agent\)/i,
    );
  });

  it("should accept a matching tag and let an untagged tool call inherit its parent's owner", async () => {
    const events = await run([
      started,
      ...s1Message,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc",
        toolCallName: "search",
        parentMessageId: "m",
        subagentRunId: "s1",
      } as ToolCallStartEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc" } as ToolCallEndEvent,
      // Untagged inherits s1 from the parent message, so an s1-tagged
      // continuation agrees with it.
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc2",
        toolCallName: "search",
        parentMessageId: "m",
      } as ToolCallStartEvent,
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc2", delta: "{}", subagentRunId: "s1" } as ToolCallArgsEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc2" } as ToolCallEndEvent,
      finished,
    ]);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("should reject a continuation disagreeing with the owner an untagged tool call inherited", async () => {
    await expectRejectedWith(
      [
        started,
        ...s1Message,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc",
          toolCallName: "search",
          parentMessageId: "m",
        } as ToolCallStartEvent,
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc", delta: "{}", subagentRunId: "s2" } as ToolCallArgsEvent,
      ],
      /does not match the tool call 'tc' opener's subagent 's1'/i,
    );
  });

  it("should reject an untagged reopen whose new parent's owner disagrees with the retained one", async () => {
    // The raw tag is absent on both starts, but the second start's EFFECTIVE
    // owner is s2 (inherited from m2) while the retained owner is s1 — the
    // reducer would keep tc inside m1 and append s2's args there.
    await expectRejectedWith(
      [
        started,
        ...s1Message,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc",
          toolCallName: "search",
          parentMessageId: "m",
        } as ToolCallStartEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: "tc" } as ToolCallEndEvent,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m2", role: "assistant", subagentRunId: "s2" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_END, messageId: "m2", subagentRunId: "s2" } as BaseEvent,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc",
          toolCallName: "search",
          parentMessageId: "m2",
        } as ToolCallStartEvent,
      ],
      /owned by 's1'.*parent message 'm2'.*owned by 's2'/i,
    );
  });
});
