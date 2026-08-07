import { of, concat, from, firstValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import { transformChunks } from "../transform";
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

describe("transformChunks subagentId propagation", () => {
  it("should propagate subagentId from TEXT_MESSAGE_CHUNK to synthesized TEXT_MESSAGE_START", async () => {
    const chunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "hi",
      subagentId: "sub-1",
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
    expect(startEvent.subagentId).toBe("sub-1");
  });

  it("should propagate subagentId from TOOL_CALL_CHUNK to synthesized TOOL_CALL_START", async () => {
    const chunk: ToolCallChunkEvent = {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tc1",
      toolCallName: "f",
      delta: "{}",
      subagentId: "sub-2",
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
    expect(startEvent.subagentId).toBe("sub-2");
  });

  it("should propagate subagentId from REASONING_MESSAGE_CHUNK to synthesized REASONING_MESSAGE_START", async () => {
    const chunk: ReasoningMessageChunkEvent = {
      type: EventType.REASONING_MESSAGE_CHUNK,
      messageId: "r1",
      delta: "thinking",
      subagentId: "sub-3",
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
    expect(startEvent.subagentId).toBe("sub-3");
  });

  it("should pass through SUBAGENT_STARTED events unchanged", async () => {
    const subagentStarted: SubagentStartedEvent = {
      type: EventType.SUBAGENT_STARTED,
      subagentId: "sub-1",
      name: "research-agent",
    };

    const events$ = of(subagentStarted);
    const transformed$ = transformChunks(false)(events$);

    const events = await firstValueFrom(transformed$.pipe(toArray()));
    expect(events).toEqual([subagentStarted]);
  });

  it("should carry the opener's subagentId onto the synthesized END", async () => {
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
            subagentId: "sub-1",
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
    expect((end as Record<string, unknown>).subagentId).toBe("sub-1");
  });

  it("should carry the incoming chunk's subagentId onto synthesized CONTENT", async () => {
    const events = await firstValueFrom(
      transformChunks(false)(
        concat(
          of({
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: "m1",
            role: "assistant",
            delta: "A",
            subagentId: "sub-1",
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
    expect((content as Record<string, unknown>).subagentId).toBe("sub-1");
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
      subagentId: "s1",
    };
    const conflicting: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      delta: "B",
      subagentId: "s2",
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
      subagentId: "s1",
    };
    const conflicting: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      subagentId: "s2",
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
      subagentId: "s1",
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
    expect((contents[1] as Record<string, unknown>).subagentId).toBe("s1");
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
      subagentId: "s1",
    };
    const s2Finished: SubagentFinishedEvent = {
      type: EventType.SUBAGENT_FINISHED,
      subagentId: "s2",
    };
    const s1More: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      delta: "B",
      subagentId: "s1",
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
    // subagentId — lands after that subagent's terminal event, so a consumer
    // grouping by subagent attaches it to a group it has already marked complete.
    // The verifier tolerates such a tag by design; this is about not synthesizing
    // incoherent output in the first place.
    const started: SubagentStartedEvent = {
      type: EventType.SUBAGENT_STARTED,
      subagentId: "s1",
      name: "researcher",
    };
    const chunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "hi",
      subagentId: "s1",
    };
    const finished: SubagentFinishedEvent = {
      type: EventType.SUBAGENT_FINISHED,
      subagentId: "s1",
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
      subagentId: "s1",
      name: "researcher",
    };
    const chunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "hi",
      subagentId: "s1",
    };
    const errored: SubagentErrorEvent = {
      type: EventType.SUBAGENT_ERROR,
      subagentId: "s1",
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
