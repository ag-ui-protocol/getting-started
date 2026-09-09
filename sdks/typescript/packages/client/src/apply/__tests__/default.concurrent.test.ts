import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import { defaultApplyEvents } from "../default";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  RunStartedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  Message,
  AssistantMessage,
} from "@ag-ui/core";
import { AbstractAgent } from "../../agent";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
    agentId: "test-agent",
  }) as unknown as AbstractAgent;

describe("defaultApplyEvents concurrent operations", () => {
  // Test: Concurrent text messages should create separate messages
  it("should handle concurrent text messages correctly", async () => {
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

    // Send events for concurrent text messages
    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // Start two concurrent text messages
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
    } as TextMessageStartEvent);

    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg2",
      role: "assistant",
    } as TextMessageStartEvent);

    // Send content for both messages
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "First message content",
    } as TextMessageContentEvent);

    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg2",
      delta: "Second message content",
    } as TextMessageContentEvent);

    // End messages in reverse order
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg2",
    } as TextMessageEndEvent);

    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // Verify we have the expected number of state updates
    expect(stateUpdates.length).toBeGreaterThan(0);

    // Check final state has both messages
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages?.length).toBe(2);

    // Verify messages have correct IDs and content
    const msg1 = finalState.messages?.find((m) => m.id === "msg1");
    const msg2 = finalState.messages?.find((m) => m.id === "msg2");

    expect(msg1).toBeDefined();
    expect(msg2).toBeDefined();
    expect(msg1?.content).toBe("First message content");
    expect(msg2?.content).toBe("Second message content");
    expect(msg1?.role).toBe("assistant");
    expect(msg2?.role).toBe("assistant");
  });

  // Test: Concurrent tool calls should create separate tool calls
  it("should handle concurrent tool calls correctly", async () => {
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

    // Send events for concurrent tool calls
    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // Start two concurrent tool calls
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
      parentMessageId: "msg1",
    } as ToolCallStartEvent);

    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool2",
      toolCallName: "calculate",
      parentMessageId: "msg2",
    } as ToolCallStartEvent);

    // Send args for both tool calls
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test search"}',
    } as ToolCallArgsEvent);

    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool2",
      delta: '{"expression":"1+1"}',
    } as ToolCallArgsEvent);

    // End tool calls in reverse order
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool2",
    } as ToolCallEndEvent);

    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // Verify we have the expected number of state updates
    expect(stateUpdates.length).toBeGreaterThan(0);

    // Check final state has both messages with tool calls
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages?.length).toBe(2);

    // Verify tool calls are properly attached to messages
    const msg1 = finalState.messages?.find((m) => m.id === "msg1") as AssistantMessage;
    const msg2 = finalState.messages?.find((m) => m.id === "msg2") as AssistantMessage;

    expect(msg1).toBeDefined();
    expect(msg2).toBeDefined();
    expect(msg1?.toolCalls?.length).toBe(1);
    expect(msg2?.toolCalls?.length).toBe(1);

    // Verify tool call details
    expect(msg1.toolCalls?.[0]?.id).toBe("tool1");
    expect(msg1.toolCalls?.[0]?.function.name).toBe("search");
    expect(msg1.toolCalls?.[0]?.function.arguments).toBe('{"query":"test search"}');

    expect(msg2.toolCalls?.[0]?.id).toBe("tool2");
    expect(msg2.toolCalls?.[0]?.function.name).toBe("calculate");
    expect(msg2.toolCalls?.[0]?.function.arguments).toBe('{"expression":"1+1"}');
  });

  // Test: Mixed concurrent messages and tool calls
  it("should handle mixed concurrent text messages and tool calls", async () => {
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

    // Send mixed concurrent events
    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // Start a text message
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "thinking_msg",
      role: "assistant",
    } as TextMessageStartEvent);

    // Start a tool call while message is active
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "search_tool",
      toolCallName: "web_search",
      parentMessageId: "tool_msg",
    } as ToolCallStartEvent);

    // Add content to text message
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "thinking_msg",
      delta: "Let me search for that information...",
    } as TextMessageContentEvent);

    // Add args to tool call
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "search_tool",
      delta: '{"query":"concurrent events"}',
    } as ToolCallArgsEvent);

    // Start another text message
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "status_msg",
      role: "assistant",
    } as TextMessageStartEvent);

    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "status_msg",
      delta: "Processing your request...",
    } as TextMessageContentEvent);

    // End everything in mixed order
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "thinking_msg",
    } as TextMessageEndEvent);

    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "search_tool",
    } as ToolCallEndEvent);

    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "status_msg",
    } as TextMessageEndEvent);

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // Check final state
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages?.length).toBe(3);

    // Verify all messages are present
    const thinkingMsg = finalState.messages?.find((m) => m.id === "thinking_msg");
    const toolMsg = finalState.messages?.find((m) => m.id === "tool_msg") as AssistantMessage;
    const statusMsg = finalState.messages?.find((m) => m.id === "status_msg");

    expect(thinkingMsg).toBeDefined();
    expect(toolMsg).toBeDefined();
    expect(statusMsg).toBeDefined();

    expect(thinkingMsg?.content).toBe("Let me search for that information...");
    expect(statusMsg?.content).toBe("Processing your request...");
    expect(toolMsg?.toolCalls?.length).toBe(1);
    expect(toolMsg.toolCalls?.[0]?.function.name).toBe("web_search");
  });

  // Test: Multiple tool calls on the same message
  it("should handle multiple tool calls on the same parent message", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();

    // Create initial state with an existing message
    const parentMessageId = "parent_msg";
    const initialState: RunAgentInput = {
      messages: [
        {
          id: parentMessageId,
          role: "assistant",
          content: "I'll help you with multiple tools.",
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
    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);

    // Collect all emitted state updates in an array
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Send events for multiple tool calls on the same message
    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // Start multiple tool calls concurrently with the same parent message
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
      parentMessageId: parentMessageId,
    } as ToolCallStartEvent);

    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool2",
      toolCallName: "calculate",
      parentMessageId: parentMessageId,
    } as ToolCallStartEvent);

    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool3",
      toolCallName: "format",
      parentMessageId: parentMessageId,
    } as ToolCallStartEvent);

    // Send args for all tool calls
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);

    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool2",
      delta: '{"expression":"2*3"}',
    } as ToolCallArgsEvent);

    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool3",
      delta: '{"format":"json"}',
    } as ToolCallArgsEvent);

    // End all tool calls
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool2",
    } as ToolCallEndEvent);

    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool3",
    } as ToolCallEndEvent);

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // Check final state - should still have only one message with 3 tool calls
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages?.length).toBe(1);

    const parentMsg = finalState.messages?.[0] as AssistantMessage;
    expect(parentMsg.id).toBe(parentMessageId);
    expect(parentMsg.toolCalls?.length).toBe(3);

    // Verify all tool calls are present
    const toolCallIds = parentMsg.toolCalls?.map((tc) => tc.id).sort();
    expect(toolCallIds).toEqual(["tool1", "tool2", "tool3"]);

    // Verify tool call details
    const searchTool = parentMsg.toolCalls?.find((tc) => tc.id === "tool1");
    const calcTool = parentMsg.toolCalls?.find((tc) => tc.id === "tool2");
    const formatTool = parentMsg.toolCalls?.find((tc) => tc.id === "tool3");

    expect(searchTool?.function.name).toBe("search");
    expect(calcTool?.function.name).toBe("calculate");
    expect(formatTool?.function.name).toBe("format");

    expect(searchTool?.function.arguments).toBe('{"query":"test"}');
    expect(calcTool?.function.arguments).toBe('{"expression":"2*3"}');
    expect(formatTool?.function.arguments).toBe('{"format":"json"}');
  });

  // Test: High-frequency concurrent events
  it("should handle high-frequency concurrent events", async () => {
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

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // Create many concurrent messages and tool calls
    const numMessages = 10;
    const numToolCalls = 10;

    // Start all messages
    for (let i = 0; i < numMessages; i++) {
      events$.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: `msg${i}`,
        role: "assistant",
      } as TextMessageStartEvent);
    }

    // Start all tool calls
    for (let i = 0; i < numToolCalls; i++) {
      events$.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: `tool${i}`,
        toolCallName: `tool_${i}`,
        parentMessageId: `tool_msg${i}`,
      } as ToolCallStartEvent);
    }

    // Send content for all messages
    for (let i = 0; i < numMessages; i++) {
      events$.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `msg${i}`,
        delta: `Content for message ${i}`,
      } as TextMessageContentEvent);
    }

    // Send args for all tool calls
    for (let i = 0; i < numToolCalls; i++) {
      events$.next({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: `tool${i}`,
        delta: `{"param${i}":"value${i}"}`,
      } as ToolCallArgsEvent);
    }

    // End all in reverse order
    for (let i = numMessages - 1; i >= 0; i--) {
      events$.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: `msg${i}`,
      } as TextMessageEndEvent);
    }

    for (let i = numToolCalls - 1; i >= 0; i--) {
      events$.next({
        type: EventType.TOOL_CALL_END,
        toolCallId: `tool${i}`,
      } as ToolCallEndEvent);
    }

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // Check final state
    const finalState = stateUpdates[stateUpdates.length - 1];

    // Should have numMessages + numToolCalls messages total
    expect(finalState.messages?.length).toBe(numMessages + numToolCalls);

    // Verify all text messages are present with correct content
    for (let i = 0; i < numMessages; i++) {
      const msg = finalState.messages?.find((m) => m.id === `msg${i}`);
      expect(msg).toBeDefined();
      expect(msg?.content).toBe(`Content for message ${i}`);
      expect(msg?.role).toBe("assistant");
    }

    // Verify all tool call messages are present with correct tool calls
    for (let i = 0; i < numToolCalls; i++) {
      const toolMsg = finalState.messages?.find((m) => m.id === `tool_msg${i}`) as AssistantMessage;
      expect(toolMsg).toBeDefined();
      expect(toolMsg?.toolCalls?.length).toBe(1);
      expect(toolMsg.toolCalls?.[0]?.id).toBe(`tool${i}`);
      expect(toolMsg.toolCalls?.[0]?.function.name).toBe(`tool_${i}`);
      expect(toolMsg.toolCalls?.[0]?.function.arguments).toBe(`{"param${i}":"value${i}"}`);
    }
  });

  // Test: Interleaved content and args updates
  it("should handle interleaved content and args updates correctly", async () => {
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

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // Start concurrent message and tool call
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
    } as TextMessageStartEvent);

    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
      parentMessageId: "tool_msg1",
    } as ToolCallStartEvent);

    // Interleave content and args updates
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Searching ",
    } as TextMessageContentEvent);

    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"que',
    } as ToolCallArgsEvent);

    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "for ",
    } as TextMessageContentEvent);

    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: 'ry":"',
    } as ToolCallArgsEvent);

    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "information...",
    } as TextMessageContentEvent);

    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: 'test"}',
    } as ToolCallArgsEvent);

    // End both
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // Check final state
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages?.length).toBe(2);

    // Verify text message content is assembled correctly
    const textMsg = finalState.messages?.find((m) => m.id === "msg1");
    expect(textMsg?.content).toBe("Searching for information...");

    // Verify tool call args are assembled correctly
    const toolMsg = finalState.messages?.find((m) => m.id === "tool_msg1") as AssistantMessage;
    expect(toolMsg?.toolCalls?.[0]?.function.arguments).toBe('{"query":"test"}');
  });
});
