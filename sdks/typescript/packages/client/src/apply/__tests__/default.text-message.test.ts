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
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  RunAgentInput,
  RunFinishedEvent,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

describe("defaultApplyEvents with text messages", () => {
  it("should handle text message events correctly", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    // Create the observable stream
    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);

    // Collect all emitted state updates in an array
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Send events
    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
    } as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Hello ",
    } as TextMessageContentEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "world!",
    } as TextMessageContentEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should have exactly 3 state updates:
    // 1. After TEXT_MESSAGE_START
    // 2. After first TEXT_MESSAGE_CONTENT
    // 3. After second TEXT_MESSAGE_CONTENT
    // And NO update after TEXT_MESSAGE_END
    expect(stateUpdates.length).toBe(3);

    // First update: empty message added
    expect(stateUpdates[0]?.messages?.length).toBe(1);
    expect(stateUpdates[0]?.messages?.[0]?.id).toBe("msg1");
    expect(stateUpdates[0]?.messages?.[0]?.content).toBe("");

    // Second update: first content chunk added
    expect(stateUpdates[1]?.messages?.length).toBe(1);
    expect(stateUpdates[1]?.messages?.[0]?.content).toBe("Hello ");

    // Third update: second content chunk appended
    expect(stateUpdates[2]?.messages?.length).toBe(1);
    expect(stateUpdates[2]?.messages?.[0]?.content).toBe("Hello world!");

    // Verify the last update came from TEXT_MESSAGE_CONTENT, not TEXT_MESSAGE_END
    expect(stateUpdates.length).toBe(3);
  });

  it("should handle multiple text messages correctly", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    // Create the observable stream
    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);

    // Collect all emitted state updates in an array
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Send events for two different messages
    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // First message
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
    } as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "First message",
    } as TextMessageContentEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second message
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg2",
      role: "user",
    } as unknown as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg2",
      delta: "Second message",
    } as TextMessageContentEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg2",
    } as TextMessageEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should have exactly 4 state updates:
    // 1. After first TEXT_MESSAGE_START
    // 2. After first TEXT_MESSAGE_CONTENT
    // 3. After second TEXT_MESSAGE_START
    // 4. After second TEXT_MESSAGE_CONTENT
    // And NO updates after either TEXT_MESSAGE_END
    expect(stateUpdates.length).toBe(4);

    // First update: first empty message added
    expect(stateUpdates[0]?.messages?.length).toBe(1);
    expect(stateUpdates[0]?.messages?.[0]?.id).toBe("msg1");
    expect(stateUpdates[0]?.messages?.[0]?.role).toBe("assistant");
    expect(stateUpdates[0]?.messages?.[0]?.content).toBe("");

    // Second update: first message content added
    expect(stateUpdates[1]?.messages?.length).toBe(1);
    expect(stateUpdates[1]?.messages?.[0]?.content).toBe("First message");

    // Third update: second empty message added
    expect(stateUpdates[2]?.messages?.length).toBe(2);
    expect(stateUpdates[2]?.messages?.[0]?.id).toBe("msg1");
    expect(stateUpdates[2]?.messages?.[0]?.content).toBe("First message");
    expect(stateUpdates[2]?.messages?.[1]?.id).toBe("msg2");
    expect(stateUpdates[2]?.messages?.[1]?.role).toBe("user");
    expect(stateUpdates[2]?.messages?.[1]?.content).toBe("");

    // Fourth update: second message content added
    expect(stateUpdates[3]?.messages?.length).toBe(2);
    expect(stateUpdates[3]?.messages?.[0]?.content).toBe("First message");
    expect(stateUpdates[3]?.messages?.[1]?.content).toBe("Second message");

    // Verify no additional updates after either TEXT_MESSAGE_END
    expect(stateUpdates.length).toBe(4);
  });

  it("should not create duplicate message when TEXT_MESSAGE_START uses same ID as TOOL_CALL_START parentMessageId", async () => {
    // This tests the scenario where:
    // 1. TOOL_CALL_START creates a message with parentMessageId "msg1"
    // 2. TEXT_MESSAGE_START comes with messageId "msg1" (same ID)
    // The fix ensures TEXT_MESSAGE_START doesn't create a duplicate message

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

    const sharedMessageId = "d0b45a7f-d877-4a59-a6db-e11365066393";

    // Send events mimicking the real-world scenario
    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // Tool call with parentMessageId creates a message with that ID
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call_123",
      toolCallName: "updateWorkingMemory",
      parentMessageId: sharedMessageId,
    } as ToolCallStartEvent);

    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "call_123",
      delta: '{"memory":{}}',
    } as ToolCallArgsEvent);

    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "call_123",
    } as ToolCallEndEvent);

    // Tool result (separate message)
    events$.next({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "tool-result-1",
      toolCallId: "call_123",
      content: '{"success":true}',
      role: "tool",
    } as ToolCallResultEvent);

    // Text message with SAME messageId as the tool call's parentMessageId
    // This should NOT create a duplicate message
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: sharedMessageId,
      role: "assistant",
    } as TextMessageStartEvent);

    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: sharedMessageId,
      delta: "Here is the response",
    } as TextMessageContentEvent);

    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: sharedMessageId,
    } as TextMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    // Get the final messages state
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const finalMessages = finalUpdate?.messages;

    // Verify there are no duplicate messages with the same ID
    const messagesWithSharedId = finalMessages?.filter((m) => m.id === sharedMessageId);
    expect(messagesWithSharedId?.length).toBe(1);

    // The message should have both toolCalls AND content
    const sharedMessage = messagesWithSharedId?.[0];
    expect(sharedMessage?.role).toBe("assistant");
    expect((sharedMessage as any)?.toolCalls?.length).toBe(1);
    expect((sharedMessage as any)?.toolCalls?.[0]?.function?.name).toBe("updateWorkingMemory");
    expect(sharedMessage?.content).toBe("Here is the response");

    // Total messages should be 2: the assistant message (with tool call + content) and the tool result
    expect(finalMessages?.length).toBe(2);
  });

  it("should set name on message when TEXT_MESSAGE_START has name", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
      forwardedProps: {},
    };

    const agent = createAgent([]);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread",
      runId: "test-run",
    } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
      name: "research-agent",
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
    events$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test-thread",
      runId: "test-run",
    } as RunFinishedEvent);

    events$.complete();
    const stateUpdates = await stateUpdatesPromise;

    // Find the update where the message was created (TEXT_MESSAGE_START)
    const msgUpdate = stateUpdates.find((u) => u.messages?.some((m) => m.id === "msg1"));
    expect(msgUpdate).toBeDefined();
    const msg = msgUpdate!.messages!.find((m) => m.id === "msg1");
    expect((msg as any).name).toBe("research-agent");
  });

  it("should not set name on message when TEXT_MESSAGE_START has no name", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
      forwardedProps: {},
    };

    const agent = createAgent([]);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread",
      runId: "test-run",
    } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
    } as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);
    events$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test-thread",
      runId: "test-run",
    } as RunFinishedEvent);

    events$.complete();
    const stateUpdates = await stateUpdatesPromise;

    const msgUpdate = stateUpdates.find((u) => u.messages?.some((m) => m.id === "msg1"));
    expect(msgUpdate).toBeDefined();
    const msg = msgUpdate!.messages!.find((m) => m.id === "msg1");
    expect((msg as any).name).toBeUndefined();
  });
});
