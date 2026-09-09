import { Observable } from "rxjs";
import { AbstractAgent } from "../agent";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  RunStartedEvent,
  RunFinishedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  StepStartedEvent,
  StepFinishedEvent,
  AssistantMessage,
} from "@ag-ui/core";

// Mock agent implementation for testing concurrent events
class ConcurrentTestAgent extends AbstractAgent {
  public eventsToEmit: BaseEvent[] = [];
  public currentEventIndex = 0;

  constructor() {
    super();
    this.debug = false;
  }

  // Set the events this agent should emit
  setEventsToEmit(events: BaseEvent[]) {
    this.eventsToEmit = events;
    this.currentEventIndex = 0;
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      // Emit all the pre-configured events
      for (const event of this.eventsToEmit) {
        subscriber.next(event);
      }
      subscriber.complete();
    });
  }
}

describe("Agent concurrent operations integration", () => {
  let agent: ConcurrentTestAgent;

  beforeEach(() => {
    agent = new ConcurrentTestAgent();
  });

  // Test: Concurrent text messages through full agent pipeline
  it("should handle concurrent text messages through full agent pipeline", async () => {
    // Configure events for concurrent text messages
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg2",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg1",
        delta: "First message ",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg2",
        delta: "Second message ",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg1",
        delta: "content",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg2",
        delta: "content",
      } as TextMessageContentEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg2" } as TextMessageEndEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" } as TextMessageEndEvent,
      { type: EventType.RUN_FINISHED, threadId: "test", runId: "test" } as RunFinishedEvent,
    ];

    agent.setEventsToEmit(events);

    // Run the agent
    const result = await agent.runAgent();

    // Verify messages were created correctly
    expect(result.newMessages.length).toBe(2);

    const msg1 = result.newMessages.find((m) => m.id === "msg1");
    const msg2 = result.newMessages.find((m) => m.id === "msg2");

    expect(msg1).toBeDefined();
    expect(msg2).toBeDefined();
    expect(msg1?.content).toBe("First message content");
    expect(msg2?.content).toBe("Second message content");
    expect(msg1?.role).toBe("assistant");
    expect(msg2?.role).toBe("assistant");
  });

  // Test: Concurrent tool calls through full agent pipeline
  it("should handle concurrent tool calls through full agent pipeline", async () => {
    // Configure events for concurrent tool calls
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool1",
        toolCallName: "search",
        parentMessageId: "msg1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool2",
        toolCallName: "calculate",
        parentMessageId: "msg2",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool1",
        delta: '{"query":',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool2",
        delta: '{"expr":',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool1",
        delta: '"test"}',
      } as ToolCallArgsEvent,
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool2", delta: '"1+1"}' } as ToolCallArgsEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tool1" } as ToolCallEndEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tool2" } as ToolCallEndEvent,
      { type: EventType.RUN_FINISHED, threadId: "test", runId: "test" } as RunFinishedEvent,
    ];

    agent.setEventsToEmit(events);

    // Run the agent
    const result = await agent.runAgent();

    // Verify tool call messages were created correctly
    expect(result.newMessages.length).toBe(2);

    const msg1 = result.newMessages.find((m) => m.id === "msg1") as AssistantMessage;
    const msg2 = result.newMessages.find((m) => m.id === "msg2") as AssistantMessage;

    expect(msg1).toBeDefined();
    expect(msg2).toBeDefined();
    expect(msg1?.toolCalls?.length).toBe(1);
    expect(msg2?.toolCalls?.length).toBe(1);

    expect(msg1.toolCalls?.[0]?.id).toBe("tool1");
    expect(msg1.toolCalls?.[0]?.function.name).toBe("search");
    expect(msg1.toolCalls?.[0]?.function.arguments).toBe('{"query":"test"}');

    expect(msg2.toolCalls?.[0]?.id).toBe("tool2");
    expect(msg2.toolCalls?.[0]?.function.name).toBe("calculate");
    expect(msg2.toolCalls?.[0]?.function.arguments).toBe('{"expr":"1+1"}');
  });

  // Test: Mixed concurrent text messages and tool calls
  it("should handle mixed concurrent text messages and tool calls", async () => {
    // Configure events for mixed concurrent operations
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      { type: EventType.STEP_STARTED, stepName: "thinking" } as StepStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "thinking",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "search",
        toolCallName: "web_search",
        parentMessageId: "tool_msg",
      } as ToolCallStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "thinking",
        delta: "Let me search ",
      } as TextMessageContentEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "search",
        delta: '{"query":"',
      } as ToolCallArgsEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "thinking",
        delta: "for that...",
      } as TextMessageContentEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "search",
        delta: 'concurrent"}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "status",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "status",
        delta: "Processing...",
      } as TextMessageContentEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "thinking" } as TextMessageEndEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "search" } as ToolCallEndEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "status" } as TextMessageEndEvent,
      { type: EventType.STEP_FINISHED, stepName: "thinking" } as StepFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "test", runId: "test" } as RunFinishedEvent,
    ];

    agent.setEventsToEmit(events);

    // Run the agent
    const result = await agent.runAgent();

    // Verify all messages were created correctly
    expect(result.newMessages.length).toBe(3);

    const thinkingMsg = result.newMessages.find((m) => m.id === "thinking");
    const statusMsg = result.newMessages.find((m) => m.id === "status");
    const toolMsg = result.newMessages.find((m) => m.id === "tool_msg") as AssistantMessage;

    expect(thinkingMsg).toBeDefined();
    expect(statusMsg).toBeDefined();
    expect(toolMsg).toBeDefined();

    expect(thinkingMsg?.content).toBe("Let me search for that...");
    expect(statusMsg?.content).toBe("Processing...");
    expect(toolMsg?.toolCalls?.length).toBe(1);
    expect(toolMsg.toolCalls?.[0]?.function.name).toBe("web_search");
    expect(toolMsg.toolCalls?.[0]?.function.arguments).toBe('{"query":"concurrent"}');
  });

  // Test: Multiple tool calls on same message through full pipeline
  it("should handle multiple tool calls on same message through full pipeline", async () => {
    // Configure events for multiple tool calls on same message
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool1",
        toolCallName: "search",
        parentMessageId: "shared_msg",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool2",
        toolCallName: "calculate",
        parentMessageId: "shared_msg",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool3",
        toolCallName: "format",
        parentMessageId: "shared_msg",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool1",
        delta: '{"q":"a"}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool2",
        delta: '{"e":"b"}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool3",
        delta: '{"f":"c"}',
      } as ToolCallArgsEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tool2" } as ToolCallEndEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tool1" } as ToolCallEndEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tool3" } as ToolCallEndEvent,
      { type: EventType.RUN_FINISHED, threadId: "test", runId: "test" } as RunFinishedEvent,
    ];

    agent.setEventsToEmit(events);

    // Run the agent
    const result = await agent.runAgent();

    // Verify one message with three tool calls
    expect(result.newMessages.length).toBe(1);

    const sharedMsg = result.newMessages[0] as AssistantMessage;
    expect(sharedMsg.id).toBe("shared_msg");
    expect(sharedMsg.toolCalls?.length).toBe(3);

    const toolCallIds = sharedMsg.toolCalls?.map((tc) => tc.id).sort();
    expect(toolCallIds).toEqual(["tool1", "tool2", "tool3"]);

    const tool1 = sharedMsg.toolCalls?.find((tc) => tc.id === "tool1");
    const tool2 = sharedMsg.toolCalls?.find((tc) => tc.id === "tool2");
    const tool3 = sharedMsg.toolCalls?.find((tc) => tc.id === "tool3");

    expect(tool1?.function.name).toBe("search");
    expect(tool2?.function.name).toBe("calculate");
    expect(tool3?.function.name).toBe("format");

    expect(tool1?.function.arguments).toBe('{"q":"a"}');
    expect(tool2?.function.arguments).toBe('{"e":"b"}');
    expect(tool3?.function.arguments).toBe('{"f":"c"}');
  });

  // Test: Event ordering is preserved in message creation
  it("should preserve event ordering in message creation", async () => {
    // Configure events to test ordering
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg2",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg3",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg1",
        delta: "First",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg2",
        delta: "Second",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg3",
        delta: "Third",
      } as TextMessageContentEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg3" } as TextMessageEndEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" } as TextMessageEndEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg2" } as TextMessageEndEvent,
      { type: EventType.RUN_FINISHED, threadId: "test", runId: "test" } as RunFinishedEvent,
    ];

    agent.setEventsToEmit(events);

    // Run the agent
    const result = await agent.runAgent();

    // Verify all messages exist with correct content
    expect(result.newMessages.length).toBe(3);

    // Messages should be in the order they were started
    expect(result.newMessages[0].id).toBe("msg1");
    expect(result.newMessages[1].id).toBe("msg2");
    expect(result.newMessages[2].id).toBe("msg3");

    expect(result.newMessages[0].content).toBe("First");
    expect(result.newMessages[1].content).toBe("Second");
    expect(result.newMessages[2].content).toBe("Third");
  });

  // Test: High-frequency concurrent events through full pipeline
  it("should handle high-frequency concurrent events through full pipeline", async () => {
    const numMessages = 5;
    const numToolCalls = 5;
    const events: BaseEvent[] = [];

    // Build event sequence
    events.push({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    // Start all messages
    for (let i = 0; i < numMessages; i++) {
      events.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: `msg${i}`,
        role: "assistant",
      } as TextMessageStartEvent);
    }

    // Start all tool calls
    for (let i = 0; i < numToolCalls; i++) {
      events.push({
        type: EventType.TOOL_CALL_START,
        toolCallId: `tool${i}`,
        toolCallName: `tool_${i}`,
        parentMessageId: `tool_msg${i}`,
      } as ToolCallStartEvent);
    }

    // Add content to all messages
    for (let i = 0; i < numMessages; i++) {
      events.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `msg${i}`,
        delta: `Content ${i}`,
      } as TextMessageContentEvent);
    }

    // Add args to all tool calls
    for (let i = 0; i < numToolCalls; i++) {
      events.push({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: `tool${i}`,
        delta: `{"param":"value${i}"}`,
      } as ToolCallArgsEvent);
    }

    // End all messages
    for (let i = numMessages - 1; i >= 0; i--) {
      events.push({
        type: EventType.TEXT_MESSAGE_END,
        messageId: `msg${i}`,
      } as TextMessageEndEvent);
    }

    // End all tool calls
    for (let i = numToolCalls - 1; i >= 0; i--) {
      events.push({
        type: EventType.TOOL_CALL_END,
        toolCallId: `tool${i}`,
      } as ToolCallEndEvent);
    }

    events.push({
      type: EventType.RUN_FINISHED,
      threadId: "test",
      runId: "test",
    } as RunFinishedEvent);

    agent.setEventsToEmit(events);

    // Run the agent
    const result = await agent.runAgent();

    // Verify all messages and tool calls were processed
    expect(result.newMessages.length).toBe(numMessages + numToolCalls);

    // Verify text messages
    for (let i = 0; i < numMessages; i++) {
      const msg = result.newMessages.find((m) => m.id === `msg${i}`);
      expect(msg).toBeDefined();
      expect(msg?.content).toBe(`Content ${i}`);
    }

    // Verify tool call messages
    for (let i = 0; i < numToolCalls; i++) {
      const toolMsg = result.newMessages.find((m) => m.id === `tool_msg${i}`) as AssistantMessage;
      expect(toolMsg).toBeDefined();
      expect(toolMsg?.toolCalls?.length).toBe(1);
      expect(toolMsg.toolCalls?.[0]?.id).toBe(`tool${i}`);
      expect(toolMsg.toolCalls?.[0]?.function.arguments).toBe(`{"param":"value${i}"}`);
    }
  });

  // Test: Concurrent events with steps
  it("should handle concurrent events with lifecycle steps", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      { type: EventType.STEP_STARTED, stepName: "analysis" } as StepStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "thinking",
        role: "assistant",
      } as TextMessageStartEvent,
      { type: EventType.STEP_STARTED, stepName: "search" } as StepStartedEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "search_tool",
        toolCallName: "search",
        parentMessageId: "tool_msg",
      } as ToolCallStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "thinking",
        delta: "Analyzing...",
      } as TextMessageContentEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "search_tool",
        delta: '{"query":"test"}',
      } as ToolCallArgsEvent,
      { type: EventType.STEP_FINISHED, stepName: "search" } as StepFinishedEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "thinking" } as TextMessageEndEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "search_tool" } as ToolCallEndEvent,
      { type: EventType.STEP_FINISHED, stepName: "analysis" } as StepFinishedEvent,
      { type: EventType.RUN_FINISHED, threadId: "test", runId: "test" } as RunFinishedEvent,
    ];

    agent.setEventsToEmit(events);

    // Run the agent
    const result = await agent.runAgent();

    // Verify messages were created correctly even with concurrent steps
    expect(result.newMessages.length).toBe(2);

    const thinkingMsg = result.newMessages.find((m) => m.id === "thinking");
    const toolMsg = result.newMessages.find((m) => m.id === "tool_msg") as AssistantMessage;

    expect(thinkingMsg?.content).toBe("Analyzing...");
    expect(toolMsg?.toolCalls?.length).toBe(1);
    expect(toolMsg.toolCalls?.[0]?.function.name).toBe("search");
  });
});
