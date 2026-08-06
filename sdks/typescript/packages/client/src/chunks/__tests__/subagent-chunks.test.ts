import { of, concat, firstValueFrom } from "rxjs";
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
});
