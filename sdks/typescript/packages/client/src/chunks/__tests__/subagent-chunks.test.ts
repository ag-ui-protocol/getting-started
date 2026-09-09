import { of, concat, from, firstValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import { transformChunks } from "../transform";
import type { BaseEvent } from "@ag-ui/core";
import {
  EventType,
  TextMessageChunkEvent,
  ToolCallChunkEvent,
  ReasoningMessageChunkEvent,
  TextMessageStartEvent,
  ToolCallStartEvent,
  ReasoningMessageStartEvent,
  RunFinishedEvent,
  SubagentStartedEvent,
  SubagentFinishedEvent,
  SubagentErrorEvent,
} from "@ag-ui/core";
import { describe, expect, it } from "vitest";

describe("transformChunks subagentRunId propagation", () => {
  it("should propagate subagentRunId from TEXT_MESSAGE_CHUNK to synthesized TEXT_MESSAGE_START", async () => {
    const chunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "hi",
      subagentRunId: "sub-1",
    };

    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(chunk), of(closeEvent));
    const transformed$ = transformChunks(false)(events$);

    const events = await firstValueFrom(transformed$.pipe(toArray()));

    const startEvent = events[0] as TextMessageStartEvent;
    expect(startEvent.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(startEvent.subagentRunId).toBe("sub-1");
  });

  it("should propagate subagentRunId from TOOL_CALL_CHUNK to synthesized TOOL_CALL_START", async () => {
    const chunk: ToolCallChunkEvent = {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tc1",
      toolCallName: "f",
      delta: "{}",
      subagentRunId: "sub-2",
    };

    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(chunk), of(closeEvent));
    const transformed$ = transformChunks(false)(events$);

    const events = await firstValueFrom(transformed$.pipe(toArray()));

    const startEvent = events[0] as ToolCallStartEvent;
    expect(startEvent.type).toBe(EventType.TOOL_CALL_START);
    expect(startEvent.subagentRunId).toBe("sub-2");
  });

  it("should propagate subagentRunId from REASONING_MESSAGE_CHUNK to synthesized REASONING_MESSAGE_START", async () => {
    const chunk: ReasoningMessageChunkEvent = {
      type: EventType.REASONING_MESSAGE_CHUNK,
      messageId: "r1",
      delta: "thinking",
      subagentRunId: "sub-3",
    };

    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(chunk), of(closeEvent));
    const transformed$ = transformChunks(false)(events$);

    const events = await firstValueFrom(transformed$.pipe(toArray()));

    const startEvent = events[0] as ReasoningMessageStartEvent;
    expect(startEvent.type).toBe(EventType.REASONING_MESSAGE_START);
    expect(startEvent.role).toBe("reasoning");
    expect(startEvent.subagentRunId).toBe("sub-3");
  });

  it("should pass through SUBAGENT_STARTED events unchanged", async () => {
    const subagentStarted: SubagentStartedEvent = {
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "sub-1",
      name: "research-agent",
    };

    const events$ = of(subagentStarted);
    const transformed$ = transformChunks(false)(events$);

    const events = await firstValueFrom(transformed$.pipe(toArray()));
    expect(events).toEqual([subagentStarted]);
  });

  it("should carry the opener's subagentRunId onto the synthesized END", async () => {
    // Without this the END is untagged, so a consumer reading attribution per
    // event sees the message close as if the parent had done it.
    const events = await firstValueFrom(
      transformChunks(false)(
        concat(
          of({
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: "m1",
            role: "assistant",
            delta: "hi",
            subagentRunId: "sub-1",
          } as TextMessageChunkEvent),
          of({
            type: EventType.RUN_FINISHED,
            threadId: "t",
            runId: "r",
          } as RunFinishedEvent),
        ),
      ).pipe(toArray()),
    );

    const end = events.find((e) => e.type === EventType.TEXT_MESSAGE_END);
    expect(end).toBeDefined();
    expect((end as Record<string, unknown>).subagentRunId).toBe("sub-1");
  });

  it("should carry the incoming chunk's subagentRunId onto synthesized CONTENT", async () => {
    const events = await firstValueFrom(
      transformChunks(false)(
        concat(
          of({
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: "m1",
            role: "assistant",
            delta: "A",
            subagentRunId: "sub-1",
          } as TextMessageChunkEvent),
          of({
            type: EventType.RUN_FINISHED,
            threadId: "t",
            runId: "r",
          } as RunFinishedEvent),
        ),
      ).pipe(toArray()),
    );

    const content = events.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
    expect(content).toBeDefined();
    expect((content as Record<string, unknown>).subagentRunId).toBe("sub-1");
  });

  it("should treat an explicitly empty reasoning messageId as a new stream", async () => {
    // An empty id is present, not absent, so it opens a NEW reasoning message. Truthiness
    // here left the previous message open and stamped its content with the new chunk's
    // owner, which the verifier then rejected as a mismatch — while .NET accepted the
    // same stream.
    const first: ReasoningMessageChunkEvent = {
      type: EventType.REASONING_MESSAGE_CHUNK,
      messageId: "r",
      delta: "A",
      subagentRunId: "s1",
    };
    const second: ReasoningMessageChunkEvent = {
      type: EventType.REASONING_MESSAGE_CHUNK,
      messageId: "",
      delta: "B",
      subagentRunId: "s2",
    };
    const runFinished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t",
      runId: "r",
    };

    const events = await firstValueFrom(
      transformChunks(false)(from([first, second, runFinished])).pipe(toArray()),
    );

    // Two separate reasoning messages, each with its own owner.
    const starts = events.filter((e) => e.type === EventType.REASONING_MESSAGE_START);
    expect(starts).toHaveLength(2);
    expect((starts[0] as Record<string, unknown>).subagentRunId).toBe("s1");
    expect((starts[1] as Record<string, unknown>).subagentRunId).toBe("s2");
  });

  it("should reject an owner change on the same chunk stream", async () => {
    // Two chunks share a messageId but name different subagents — a contradiction the
    // continuation-owner rule forbids. Rejected here rather than left to verifyEvents,
    // because a compact chunk carrying attribution but no delta emits no synthesized
    // event at all, so the disagreement would never reach the verifier.
    const first: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "A",
      subagentRunId: "s1",
    };
    const conflicting: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      delta: "B",
      subagentRunId: "s2",
    };

    await expect(
      firstValueFrom(transformChunks(false)(from([first, conflicting])).pipe(toArray())),
    ).rejects.toThrow(/does not match the open stream's subagent/);
  });

  it("should reject an owner change even when the chunk carries no delta", async () => {
    // The shape that made propagation alone insufficient: no delta means no synthesized
    // CONTENT to carry the conflicting tag.
    const first: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "A",
      subagentRunId: "s1",
    };
    const conflicting: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      subagentRunId: "s2",
    };

    await expect(
      firstValueFrom(transformChunks(false)(from([first, conflicting])).pipe(toArray())),
    ).rejects.toThrow(/does not match the open stream's subagent/);
  });

  it("should allow an untagged continuation chunk on a tagged stream", async () => {
    // Omitting the tag is not a disagreement, so producers that tag only the opening
    // chunk keep working.
    const first: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "A",
      subagentRunId: "s1",
    };
    const untagged: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      delta: "B",
    } as TextMessageChunkEvent;
    const runFinished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t",
      runId: "r",
    };

    const events = await firstValueFrom(
      transformChunks(false)(from([first, untagged, runFinished])).pipe(toArray()),
    );
    const contents = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
    expect(contents).toHaveLength(2);
    expect((contents[1] as Record<string, unknown>).subagentRunId).toBe("s1");
  });

  it("should not close another subagent's pending stream on a terminal", async () => {
    // One global pending stream lives here, so closing on ANY subagent terminal broke
    // unrelated lanes: s2 finishing closed s1's open message, and since continuation
    // chunks omit messageId the next s1 chunk then threw "First TEXT_MESSAGE_CHUNK must
    // have a messageId".
    const s1Chunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "A",
      subagentRunId: "s1",
    };
    const s2Finished: SubagentFinishedEvent = {
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "s2",
    };
    const s1More: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      delta: "B",
      subagentRunId: "s1",
    } as TextMessageChunkEvent;
    const runFinished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t",
      runId: "r",
    };

    const events = await firstValueFrom(
      transformChunks(false)(from([s1Chunk, s2Finished, s1More, runFinished])).pipe(toArray()),
    );

    // s1's message stayed open across s2's terminal, so both deltas belong to it and
    // exactly one END is synthesized.
    const contents = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
    expect(contents.map((c) => (c as Record<string, unknown>).delta)).toEqual(["A", "B"]);
    expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_END)).toHaveLength(1);
  });

  it("should close a pending chunk stream before SUBAGENT_FINISHED", async () => {
    // Otherwise the synthesized TEXT_MESSAGE_END — which carries the opener's
    // subagentRunId — lands after that subagent's terminal event, so a consumer
    // grouping by subagent attaches it to a group it has already marked complete.
    // The verifier tolerates such a tag by design; this is about not synthesizing
    // incoherent output in the first place.
    const started: SubagentStartedEvent = {
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "s1",
      name: "researcher",
    };
    const chunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "hi",
      subagentRunId: "s1",
    };
    const finished: SubagentFinishedEvent = {
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "s1",
    };
    const runFinished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t",
      runId: "r",
    };

    const events = await firstValueFrom(
      transformChunks(false)(from([started, chunk, finished, runFinished])).pipe(toArray()),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(
      types.indexOf(EventType.SUBAGENT_FINISHED),
    );
  });

  it("should close a pending chunk stream before SUBAGENT_ERROR", async () => {
    const started: SubagentStartedEvent = {
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "s1",
      name: "researcher",
    };
    const chunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "hi",
      subagentRunId: "s1",
    };
    const errored: SubagentErrorEvent = {
      type: EventType.SUBAGENT_ERROR,
      subagentRunId: "s1",
      message: "boom",
    };

    const events = await firstValueFrom(
      transformChunks(false)(from([started, chunk, errored])).pipe(toArray()),
    );

    const types = events.map((e) => e.type);
    expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(
      types.indexOf(EventType.SUBAGENT_ERROR),
    );
  });
});

describe("a runtime null tag reads as the parent lane", () => {
  // The schemas reject null, and a runtime null must not mint its own Map lane
  // distinct from the parent's undefined — that produced overlapping starts for
  // what is one parent stream. Lane KEYING therefore collapses null onto the
  // parent; the emitted event is a separate question, below.
  it("null-tagged and untagged parent chunks share one lane", async () => {
    const events$ = from([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: "a",
        subagentRunId: null,
      } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m2", delta: "b" } as BaseEvent,
    ]);
    const out = await firstValueFrom(transformChunks(false)(events$).pipe(toArray()));

    const starts = out.filter((e) => e.type === EventType.TEXT_MESSAGE_START);
    expect(starts).toHaveLength(2);
    // One lane: the second opener closes the first stream before starting.
    const firstEndIdx = out.findIndex((e) => e.type === EventType.TEXT_MESSAGE_END);
    const secondStartIdx = out.findIndex(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_START &&
        (e as { messageId?: string }).messageId === "m2",
    );
    expect(firstEndIdx).toBeGreaterThan(-1);
    expect(firstEndIdx).toBeLessThan(secondStartIdx);
    // The null RIDES ALONG rather than being scrubbed. Spelling an absent owner
    // as null is a violation the spec names, and this stage is not the one that
    // judges it: enforcement runs before expansion on every pipeline in
    // agent.ts, and after it when a middleware expands via runNext. Dropping it
    // here made the violation fatal in the first case and invisible in the
    // second, so which one a consumer hit decided whether a producer's bug was
    // ever reported.
    const opener = out.find(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_START &&
        (e as { messageId?: string }).messageId === "m1",
    );
    expect((opener as { subagentRunId?: unknown }).subagentRunId).toBeNull();
  });

  it("keeps a null tag fatal whichever stage reaches it first", async () => {
    const chunk = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      delta: "a",
      subagentRunId: null,
    } as unknown as BaseEvent;

    // Expanded first (the runNext ordering), the null must survive expansion so
    // the enforcement stage downstream can reject it.
    const expanded = await firstValueFrom(
      transformChunks(false)(from([chunk])).pipe(toArray()),
    );

    expect(
      expanded.some((e) => (e as { subagentRunId?: unknown }).subagentRunId === null),
    ).toBe(true);
  });
});
