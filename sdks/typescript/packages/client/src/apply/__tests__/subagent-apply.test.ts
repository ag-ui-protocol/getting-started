import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  BaseEvent,
  EventType,
  Message,
  RunStartedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  RunAgentInput,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

describe("defaultApplyEvents with subagentId attribution", () => {
  it("should copy subagentId from TEXT_MESSAGE_START onto the newly created message", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
      subagentId: "sub-1",
    } as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Hello",
    } as TextMessageContentEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "msg1");

    expect(message).toBeDefined();
    expect((message as any).subagentId).toBe("sub-1");
  });

  it("should copy subagentId from TOOL_CALL_RESULT onto the newly created tool message", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call_123",
      toolCallName: "doSomething",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "call_123",
    } as ToolCallEndEvent);
    events$.next({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "tool-result-1",
      toolCallId: "call_123",
      content: '{"success":true}',
      role: "tool",
      subagentId: "sub-2",
    } as ToolCallResultEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "tool-result-1");

    expect(message).toBeDefined();
    expect(message?.role).toBe("tool");
    expect((message as any).subagentId).toBe("sub-2");
  });

  it("should not overwrite an existing message's subagentId (first-writer-wins)", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m2",
      role: "assistant",
      subagentId: "owner",
    } as TextMessageStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call_456",
      toolCallName: "doSomethingElse",
      parentMessageId: "m2",
      subagentId: "intruder",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "call_456",
    } as ToolCallEndEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m2",
    } as TextMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "m2");

    expect(message).toBeDefined();
    expect((message as any).subagentId).toBe("owner");
  });

  it("should set subagentId on TOOL_CALL_START creation and not overwrite it on a later resolve to the same message", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    // No parentMessageId -> resolveOrCreateAssistantMessage creates a brand new
    // assistant message keyed by toolCallId ("call_1"), so wasCreated is true
    // and the positive `wasCreated && subagentId !== undefined` branch fires.
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call_1",
      toolCallName: "f",
      subagentId: "first",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "call_1",
    } as ToolCallEndEvent);
    // parentMessageId now points at the message created above, so this
    // resolves to the EXISTING message (wasCreated=false) — the guard must
    // block the overwrite regardless of the `=== undefined` sub-check.
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call_2",
      toolCallName: "g",
      parentMessageId: "call_1",
      subagentId: "second",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "call_2",
    } as ToolCallEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "call_1");

    expect(message).toBeDefined();
    expect((message as any).subagentId).toBe("first");
  });
});
