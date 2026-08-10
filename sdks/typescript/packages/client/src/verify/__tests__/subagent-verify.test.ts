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
});
