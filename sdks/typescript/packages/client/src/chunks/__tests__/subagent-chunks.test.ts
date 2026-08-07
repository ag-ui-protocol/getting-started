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

  it("should surface an owner change mid-stream instead of absorbing it", async () => {
    // Two chunks share a messageId but name different subagents. The chunk path
    // keys a stream by id alone, so it cannot itself tell these apart — but by
    // propagating each chunk's own tag onto the synthesized CONTENT, the
    // disagreement becomes visible to verifyEvents, which runs after this
    // transform and rejects it. Previously both deltas merged into one message
    // silently attributed entirely to the first owner.
    const events = await firstValueFrom(
      transformChunks(false)(
        concat(
          of({
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: "m1",
            role: "assistant",
            delta: "A",
            subagentId: "s1",
          } as TextMessageChunkEvent),
          of({
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: "m1",
            delta: "B",
            subagentId: "s2",
          } as TextMessageChunkEvent),
          of({
            type: EventType.RUN_FINISHED,
            threadId: "t",
            runId: "r",
          } as RunFinishedEvent),
        ),
      ).pipe(toArray()),
    );

    const contents = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
    expect(contents).toHaveLength(2);
    expect((contents[0] as Record<string, unknown>).subagentId).toBe("s1");
    expect((contents[1] as Record<string, unknown>).subagentId).toBe("s2");
  });

  it("should close a pending chunk stream before SUBAGENT_FINISHED", async () => {
    // Otherwise the synthesized TEXT_MESSAGE_END lands after the subagent's
    // terminal event, turning a valid chunk producer into a stream with
    // post-terminal subagent output.
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
