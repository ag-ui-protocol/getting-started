import { vi } from "vitest";
import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  AssistantMessage,
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
  RunStartedEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

describe("defaultApplyEvents with tool calls", () => {
  it("should handle a single tool call correctly", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();
    const initialState = {
      messages: [],
      state: {
        count: 0,
        text: "hello",
      },
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
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query": "',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: "test search",
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should have exactly 4 state updates:
    // 1. After TOOL_CALL_START
    // 2-4. After each TOOL_CALL_ARGS
    // And NO update after TOOL_CALL_END
    expect(stateUpdates.length).toBe(4);

    // First update: tool call created
    expect(stateUpdates[0].messages?.length).toBe(1);
    expect((stateUpdates[0].messages?.[0] as AssistantMessage).toolCalls?.length).toBe(1);
    expect((stateUpdates[0].messages?.[0] as AssistantMessage).toolCalls?.[0]?.id).toBe("tool1");
    expect((stateUpdates[0].messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.name).toBe(
      "search",
    );
    expect(
      (stateUpdates[0].messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.arguments,
    ).toBe("");

    // Second update: first args chunk added
    expect(
      (stateUpdates[1].messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.arguments,
    ).toBe('{"query": "');

    // Third update: second args chunk appended
    expect(
      (stateUpdates[2].messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.arguments,
    ).toBe('{"query": "test search');

    // Fourth update: third args chunk appended
    expect(
      (stateUpdates[3].messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.arguments,
    ).toBe('{"query": "test search"}');
  });

  it("places a tool result immediately after its tool call even when the result arrives after a trailing assistant text", async () => {
    // Reproduces the chat -> tool -> chat ordering hazard: the follow-up
    // assistant text streams before the tool result is recorded. Appending the
    // result would yield assistant(tool_call) -> text -> tool, which violates the
    // provider contract (assistant tool_call must be immediately followed by its
    // tool result) and surfaces as a 400 on the next turn.
    const events$ = new Subject<BaseEvent>();
    const initialState = {
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

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    // 1. assistant message with the tool call
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "get_weather",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);
    // 2. trailing assistant text streams BEFORE the result is recorded
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "text1",
      role: "assistant",
    } as any);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "text1",
      delta: "Here is the weather.",
    } as any);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "text1",
    } as any);
    // 3. tool result arrives last
    events$.next({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "res1",
      toolCallId: "tool1",
      content: "sunny",
    } as ToolCallResultEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalMessages = stateUpdates[stateUpdates.length - 1].messages ?? [];

    // Order must be assistant(tool_call) -> tool -> assistant(text)
    expect(finalMessages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);

    const ownerIndex = finalMessages.findIndex((m) =>
      (m as AssistantMessage).toolCalls?.some((tc) => tc.id === "tool1"),
    );
    expect(ownerIndex).toBe(0);
    // tool result sits directly after its owning assistant message
    expect(finalMessages[ownerIndex + 1]?.role).toBe("tool");
    expect((finalMessages[ownerIndex + 1] as any).toolCallId).toBe("tool1");
  });

  it("should handle multiple tool calls correctly", async () => {
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

    // Send events for two different tool calls
    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // First tool call
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Second tool call
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool2",
      toolCallName: "calculate",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool2",
      delta: '{"expression":"1+1"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool2",
    } as ToolCallEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should have exactly 4 state updates:
    // 1. After first TOOL_CALL_START
    // 2. After first TOOL_CALL_ARGS
    // 3. After second TOOL_CALL_START
    // 4. After second TOOL_CALL_ARGS
    expect(stateUpdates.length).toBe(4);

    // Check last state update for the correct tool calls
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages?.length).toBe(2);

    // First message should have first tool call
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.length).toBe(1);
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.[0]?.id).toBe("tool1");
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.name).toBe(
      "search",
    );
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.arguments).toBe(
      '{"query":"test"}',
    );

    // Second message should have second tool call
    expect((finalState.messages?.[1] as AssistantMessage).toolCalls?.length).toBe(1);
    expect((finalState.messages?.[1] as AssistantMessage).toolCalls?.[0]?.id).toBe("tool2");
    expect((finalState.messages?.[1] as AssistantMessage).toolCalls?.[0]?.function?.name).toBe(
      "calculate",
    );
    expect((finalState.messages?.[1] as AssistantMessage).toolCalls?.[0]?.function?.arguments).toBe(
      '{"expression":"1+1"}',
    );
  });

  it("should handle tool calls with parent message ID correctly", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();

    // Create initial state with an existing message
    const parentMessageId = "existing_message";
    const initialState: RunAgentInput = {
      messages: [
        {
          id: parentMessageId,
          role: "assistant",
          content: "I'll help you with that.",
          toolCalls: [],
        },
      ],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    // Create the observable stream
    const agent = createAgent(initialState.messages as Message[]);
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
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
      parentMessageId: parentMessageId,
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should have exactly 2 state updates
    expect(stateUpdates.length).toBe(2);

    // Check that the tool call was added to the existing message
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages?.length).toBe(1);
    expect(finalState.messages?.[0]?.id).toBe(parentMessageId);
    expect(finalState.messages?.[0]?.content).toBe("I'll help you with that.");
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.length).toBe(1);
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.[0]?.id).toBe("tool1");
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.name).toBe(
      "search",
    );
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.arguments).toBe(
      '{"query":"test"}',
    );
  });

  it("should handle errors and partial updates correctly", async () => {
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

    // Send events with errors in the tool args JSON
    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query',
    } as ToolCallArgsEvent); // Incomplete JSON
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: ':"test"}',
    } as ToolCallArgsEvent); // Completes the JSON
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should still have updates despite the JSON syntax error
    expect(stateUpdates.length).toBe(3);

    // Check the final JSON (should be valid now)
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.arguments).toBe(
      '{"query:"test"}',
    );
  });

  it("should handle advanced scenarios with multiple tools and text messages", async () => {
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

    // Send events with a mix of tool calls and text messages
    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // First tool call
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Second tool call
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool2",
      toolCallName: "calculate",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool2",
      delta: '{"expression":"1+1"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool2",
    } as ToolCallEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // Check for expected state updates
    expect(stateUpdates.length).toBe(4);

    // Check the final state for both tool calls
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages?.length).toBe(2);

    // Verify first tool call
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.length).toBe(1);
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.[0]?.id).toBe("tool1");
    expect((finalState.messages?.[0] as AssistantMessage).toolCalls?.[0]?.function?.name).toBe(
      "search",
    );

    // Verify second tool call
    expect((finalState.messages?.[1] as AssistantMessage).toolCalls?.length).toBe(1);
    expect((finalState.messages?.[1] as AssistantMessage).toolCalls?.[0]?.id).toBe("tool2");
    expect((finalState.messages?.[1] as AssistantMessage).toolCalls?.[0]?.function?.name).toBe(
      "calculate",
    );
  });

  it("should find parent via full-array search when tool result sits between two tool calls", async () => {
    // Regression test: when a TOOL_CALL_RESULT pushes a tool message (making
    // it the last message), the next TOOL_CALL_START with the same
    // parentMessageId must search the full array to find the existing parent
    // instead of creating a duplicate assistant message.
    const events$ = new Subject<BaseEvent>();
    const parentMessageId = "parent-1";
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

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // First tool call with parentMessageId
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "search",
      parentMessageId,
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-1",
      delta: '{"q":"a"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tc-1",
    } as ToolCallEndEvent);

    // Tool result — pushes a tool message, which becomes the last message
    events$.next({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "result-1",
      toolCallId: "tc-1",
      content: "found it",
    } as ToolCallResultEvent);

    // Second tool call with the SAME parentMessageId — should attach to
    // the existing assistant message, not create a duplicate
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-2",
      toolCallName: "analyze",
      parentMessageId,
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-2",
      delta: '{"data":"x"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tc-2",
    } as ToolCallEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalState = stateUpdates[stateUpdates.length - 1];

    // Should have exactly 2 messages: one assistant (with both tool calls) and one tool result
    expect(finalState.messages?.length).toBe(2);

    const assistantMsg = finalState.messages?.find(
      (m) => m.role === "assistant",
    ) as AssistantMessage;
    const toolMsg = finalState.messages?.find((m) => m.role === "tool");

    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.id).toBe(parentMessageId);
    expect(assistantMsg.toolCalls?.length).toBe(2);
    expect(assistantMsg.toolCalls?.[0]?.id).toBe("tc-1");
    expect(assistantMsg.toolCalls?.[1]?.id).toBe("tc-2");

    expect(toolMsg).toBeDefined();
    expect(toolMsg?.id).toBe("result-1");
  });

  it("should find parent via full-array search when multiple messages precede it", async () => {
    // Exercises the common case where the parent assistant message is NOT the
    // last message in the array and there are other messages before it.
    const events$ = new Subject<BaseEvent>();
    const parentMessageId = "assistant-1";
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

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // Build up: assistant message with first tool call, then a tool result
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "search",
      parentMessageId,
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-1",
      delta: '{"q":"a"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tc-1",
    } as ToolCallEndEvent);

    // Tool result pushes a tool message — now the assistant is no longer last
    events$.next({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "result-1",
      toolCallId: "tc-1",
      content: "found",
    } as ToolCallResultEvent);

    // Second tool result pushes another tool message
    events$.next({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "result-2",
      toolCallId: "tc-1",
      content: "more",
    } as ToolCallResultEvent);

    // New tool call with the same parentMessageId — parent is now 2 positions back
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-2",
      toolCallName: "analyze",
      parentMessageId,
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-2",
      delta: '{"x":1}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tc-2",
    } as ToolCallEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalState = stateUpdates[stateUpdates.length - 1];

    // Should have 3 messages: 1 assistant (with both tool calls) + 2 tool results
    expect(finalState.messages?.length).toBe(3);

    const assistantMsg = finalState.messages?.find(
      (m) => m.role === "assistant",
    ) as AssistantMessage;
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.id).toBe(parentMessageId);
    expect(assistantMsg.toolCalls?.length).toBe(2);
    expect(assistantMsg.toolCalls?.[0]?.id).toBe("tc-1");
    expect(assistantMsg.toolCalls?.[1]?.id).toBe("tc-2");
  });

  it("should fall back to toolCallId when parentMessageId collides with a non-assistant message", async () => {
    // When parentMessageId matches an existing message that is NOT an
    // assistant message (e.g. a tool message), the code must not create a
    // duplicate ID. Instead it falls back to toolCallId as the new message's ID.
    const events$ = new Subject<BaseEvent>();
    const collidingId = "shared-id";
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

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // First: create a tool result message that will occupy the collidingId
    // We'll simulate this by using a full tool-call cycle with a result
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-setup",
      toolCallName: "setup",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-setup",
      delta: "{}",
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tc-setup",
    } as ToolCallEndEvent);
    events$.next({
      type: EventType.TOOL_CALL_RESULT,
      messageId: collidingId,
      toolCallId: "tc-setup",
      content: "done",
    } as ToolCallResultEvent);

    // Now: send a TOOL_CALL_START whose parentMessageId collides with the tool message
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-collide",
      toolCallName: "collide",
      parentMessageId: collidingId,
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-collide",
      delta: '{"x":1}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tc-collide",
    } as ToolCallEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalState = stateUpdates[stateUpdates.length - 1];

    // The tool message should still have the collidingId
    const toolMsg = finalState.messages?.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.id).toBe(collidingId);

    // The new assistant message should have fallen back to toolCallId, not collidingId
    const assistantMsgs = finalState.messages?.filter(
      (m) => m.role === "assistant",
    ) as AssistantMessage[];
    const collidingAssistant = assistantMsgs.find((m) =>
      m.toolCalls?.some((tc) => tc.id === "tc-collide"),
    );
    expect(collidingAssistant).toBeDefined();
    expect(collidingAssistant!.id).toBe("tc-collide");
    expect(collidingAssistant!.id).not.toBe(collidingId);
  });

  it("should create new assistant message when parentMessageId is not found anywhere", async () => {
    // When TOOL_CALL_START arrives with a parentMessageId that doesn't match
    // any existing message, a new assistant message should be created with
    // id === parentMessageId (not toolCallId).
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

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "lookup",
      parentMessageId: "nonexistent-parent",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-1",
      delta: '{"key":"val"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tc-1",
    } as ToolCallEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalState = stateUpdates[stateUpdates.length - 1];

    expect(finalState.messages?.length).toBe(1);

    const msg = finalState.messages?.[0] as AssistantMessage;
    // The message id should be the parentMessageId, not the toolCallId
    expect(msg.id).toBe("nonexistent-parent");
    expect(msg.role).toBe("assistant");
    expect(msg.toolCalls?.length).toBe(1);
    expect(msg.toolCalls?.[0]?.id).toBe("tc-1");
    expect(msg.toolCalls?.[0]?.function?.name).toBe("lookup");
  });

  describe("TOOL_CALL_START idempotency", () => {
    const runInput: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    // The assistant message an interrupted run leaves behind: the tool call is
    // already in the agent's own message list, with its arguments fully
    // streamed, before the next run starts.
    const carriedOverAssistant = (): AssistantMessage => ({
      id: "msg-1",
      role: "assistant",
      toolCalls: [
        {
          id: "tc-1",
          type: "function",
          function: { name: "openPolicyException", arguments: '{"txId":"t-9"}' },
        },
      ],
    });

    it("does not append a second entry when the same TOOL_CALL_START is applied twice", async () => {
      const events$ = new Subject<BaseEvent>();
      const agent = createAgent([]);
      const result$ = defaultApplyEvents(runInput, events$, agent, []);
      const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

      // The exact same event reaching the reducer twice — a run re-sync
      // replaying it, or one stream delivered over two transports.
      const start = {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "search",
        parentMessageId: "msg-1",
      } as ToolCallStartEvent;

      events$.next({
        type: EventType.RUN_STARTED,
        threadId: "test",
        runId: "test",
      } as RunStartedEvent);
      events$.next(start);
      events$.next(start);
      events$.next({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc-1",
        delta: '{"query":"x"}',
      } as ToolCallArgsEvent);
      events$.next({ type: EventType.TOOL_CALL_END, toolCallId: "tc-1" } as ToolCallEndEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));
      events$.complete();

      const stateUpdates = await stateUpdatesPromise;
      const finalState = stateUpdates[stateUpdates.length - 1];

      expect(finalState.messages?.length).toBe(1);
      const msg = finalState.messages?.[0] as AssistantMessage;
      expect(msg.toolCalls?.length).toBe(1);
      expect(msg.toolCalls?.[0]?.id).toBe("tc-1");
      // The single surviving copy carries the arguments — without the guard the
      // deltas resolve to the first match and the second copy stays empty.
      expect(msg.toolCalls?.[0]?.function?.arguments).toBe('{"query":"x"}');
    });

    it("does not append a second entry for a tool call the agent carries from a previous run", async () => {
      const events$ = new Subject<BaseEvent>();
      const agent = createAgent([carriedOverAssistant()]);
      const result$ = defaultApplyEvents(runInput, events$, agent, []);
      const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

      events$.next({
        type: EventType.RUN_STARTED,
        threadId: "test",
        runId: "test",
      } as RunStartedEvent);
      events$.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "openPolicyException",
        parentMessageId: "msg-1",
      } as ToolCallStartEvent);
      // The result is what forces a state emission after the replayed start —
      // the replay itself is a no-op, and it mirrors the HITL flow where the
      // result lands once the user has responded.
      events$.next({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tm-1",
        toolCallId: "tc-1",
        content: "approved",
      } as ToolCallResultEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));
      events$.complete();

      const stateUpdates = await stateUpdatesPromise;
      const finalState = stateUpdates[stateUpdates.length - 1];

      expect(finalState.messages?.length).toBe(2);
      const msg = finalState.messages?.[0] as AssistantMessage;
      expect(msg.id).toBe("msg-1");
      expect(msg.toolCalls?.length).toBe(1);
      // Arguments streamed on the previous run survive — a start event carries
      // none, so overwriting them would blank the call out.
      expect(msg.toolCalls?.[0]?.function?.arguments).toBe('{"txId":"t-9"}');
    });

    it("does not create a stray assistant message when a replayed start names an unknown parent", async () => {
      // The dedupe has to run before the parent message is resolved: a replay
      // whose parentMessageId is no longer in state would otherwise create a
      // fresh assistant message to hang the duplicate off.
      const events$ = new Subject<BaseEvent>();
      const agent = createAgent([carriedOverAssistant()]);
      const result$ = defaultApplyEvents(runInput, events$, agent, []);
      const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

      events$.next({
        type: EventType.RUN_STARTED,
        threadId: "test",
        runId: "test",
      } as RunStartedEvent);
      events$.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "openPolicyException",
        parentMessageId: "msg-regenerated",
      } as ToolCallStartEvent);
      events$.next({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tm-1",
        toolCallId: "tc-1",
        content: "approved",
      } as ToolCallResultEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));
      events$.complete();

      const stateUpdates = await stateUpdatesPromise;
      const finalState = stateUpdates[stateUpdates.length - 1];

      expect(finalState.messages?.map((m) => m.id)).toEqual(["msg-1", "tm-1"]);
      const assistants = finalState.messages?.filter(
        (m) => m.role === "assistant",
      ) as AssistantMessage[];
      expect(assistants.length).toBe(1);
      expect(assistants[0].toolCalls?.length).toBe(1);
    });

    it("emits no state update at all for a replayed TOOL_CALL_START", async () => {
      // Idempotent means nothing changes — not "changes to the same value".
      // A spurious mutation would re-render every consumer of the transcript.
      const events$ = new Subject<BaseEvent>();
      const agent = createAgent([carriedOverAssistant()]);
      const result$ = defaultApplyEvents(runInput, events$, agent, []);
      const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

      events$.next({
        type: EventType.RUN_STARTED,
        threadId: "test",
        runId: "test",
      } as RunStartedEvent);
      events$.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "openPolicyException",
        parentMessageId: "msg-1",
      } as ToolCallStartEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));
      events$.complete();

      expect(await stateUpdatesPromise).toEqual([]);
    });

    it("updates the existing entry in place when a start reuses an id under a different name", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const events$ = new Subject<BaseEvent>();
        const agent = createAgent([]);
        const result$ = defaultApplyEvents(runInput, events$, agent, []);
        const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

        events$.next({
          type: EventType.RUN_STARTED,
          threadId: "test",
          runId: "test",
        } as RunStartedEvent);
        events$.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc-1",
          toolCallName: "search",
        } as ToolCallStartEvent);
        events$.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "tc-1",
          delta: '{"query":"x"}',
        } as ToolCallArgsEvent);
        events$.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc-1",
          toolCallName: "lookup",
        } as ToolCallStartEvent);

        await new Promise((resolve) => setTimeout(resolve, 10));
        events$.complete();

        const stateUpdates = await stateUpdatesPromise;
        const finalState = stateUpdates[stateUpdates.length - 1];

        expect(finalState.messages?.length).toBe(1);
        const msg = finalState.messages?.[0] as AssistantMessage;
        expect(msg.toolCalls?.length).toBe(1);
        expect(msg.toolCalls?.[0]?.function?.name).toBe("lookup");
        expect(msg.toolCalls?.[0]?.function?.arguments).toBe('{"query":"x"}');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("tc-1"));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
