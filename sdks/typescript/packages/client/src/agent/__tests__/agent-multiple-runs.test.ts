import { AbstractAgent } from "../agent";
import { BaseEvent, EventType, Message, RunAgentInput, TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent, RunStartedEvent, RunFinishedEvent, ActivitySnapshotEvent } from "@ag-ui/core";
import { Observable, of } from "rxjs";

describe("AbstractAgent multiple runs", () => {
  class TestAgent extends AbstractAgent {
    private events: BaseEvent[] = [];

    setEvents(events: BaseEvent[]) {
      this.events = events;
    }

    run(_input: RunAgentInput): Observable<BaseEvent> {
      return of(...this.events);
    }
  }

  it("should accumulate messages across multiple sequential runs", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    // First run events
    const firstRunEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Hello from run 1",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-1",
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
      } as RunFinishedEvent,
    ];

    // Execute first run
    agent.setEvents(firstRunEvents);
    const result1 = await agent.runAgent({ runId: "run-1" });

    // Verify first run results
    expect(result1.newMessages.length).toBe(1);
    expect(result1.newMessages[0].content).toBe("Hello from run 1");
    expect(agent.messages.length).toBe(1);
    expect(agent.messages[0].content).toBe("Hello from run 1");

    // Second run events
    const secondRunEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-2",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-2",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-2",
        delta: "Hello from run 2",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-2",
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
      } as RunFinishedEvent,
    ];

    // Execute second run
    agent.setEvents(secondRunEvents);
    const result2 = await agent.runAgent({ runId: "run-2" });

    // Verify second run results
    expect(result2.newMessages.length).toBe(1);
    expect(result2.newMessages[0].content).toBe("Hello from run 2");

    // Verify messages are accumulated
    expect(agent.messages.length).toBe(2);
    expect(agent.messages[0].content).toBe("Hello from run 1");
    expect(agent.messages[1].content).toBe("Hello from run 2");
  });

  it("should handle three sequential runs with message accumulation", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    const messages = ["First message", "Second message", "Third message"];

    for (let i = 0; i < 3; i++) {
      const runEvents: BaseEvent[] = [
        {
          type: EventType.RUN_STARTED,
          threadId: "test-thread",
          runId: `run-${i + 1}`,
        } as RunStartedEvent,
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: `msg-${i + 1}`,
          role: "assistant",
        } as TextMessageStartEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: `msg-${i + 1}`,
          delta: messages[i],
        } as TextMessageContentEvent,
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: `msg-${i + 1}`,
        } as TextMessageEndEvent,
        {
          type: EventType.RUN_FINISHED,
        } as RunFinishedEvent,
      ];

      agent.setEvents(runEvents);
      const result = await agent.runAgent({ runId: `run-${i + 1}` });

      // Verify new messages for this run
      expect(result.newMessages.length).toBe(1);
      expect(result.newMessages[0].content).toBe(messages[i]);

      // Verify total accumulated messages
      expect(agent.messages.length).toBe(i + 1);
      for (let j = 0; j <= i; j++) {
        expect(agent.messages[j].content).toBe(messages[j]);
      }
    }

    // Final verification
    expect(agent.messages.length).toBe(3);
    expect(agent.messages.map(m => m.content)).toEqual(messages);
  });

  it("should handle multiple runs in a single event stream", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    // Create a single event stream with two runs
    const allEvents: BaseEvent[] = [
      // First run
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Message from run 1",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-1",
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
      } as RunFinishedEvent,
      // Second run
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-2",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-2",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-2",
        delta: "Message from run 2",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-2",
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
      } as RunFinishedEvent,
    ];

    // Execute with the combined event stream
    agent.setEvents(allEvents);
    const result = await agent.runAgent({ runId: "combined-run" });

    // Verify results
    expect(result.newMessages.length).toBe(2);
    expect(result.newMessages[0].content).toBe("Message from run 1");
    expect(result.newMessages[1].content).toBe("Message from run 2");

    // Verify all messages are accumulated
    expect(agent.messages.length).toBe(2);
    expect(agent.messages[0].content).toBe("Message from run 1");
    expect(agent.messages[1].content).toBe("Message from run 2");
  });

  it("should start with initial messages and accumulate new ones", async () => {
    const initialMessages: Message[] = [
      {
        id: "initial-1",
        role: "user",
        content: "Initial message",
      },
    ];

    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages,
    });

    // Run events
    const runEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Response message",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-1",
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
      } as RunFinishedEvent,
    ];

    agent.setEvents(runEvents);
    const result = await agent.runAgent({ runId: "run-1" });

    // Verify new messages don't include initial messages
    expect(result.newMessages.length).toBe(1);
    expect(result.newMessages[0].content).toBe("Response message");

    // Verify total messages include both initial and new
    expect(agent.messages.length).toBe(2);
    expect(agent.messages[0].content).toBe("Initial message");
    expect(agent.messages[1].content).toBe("Response message");
  });

  it("should retain activity messages across runs", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    const firstRunEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunStartedEvent,
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "PLAN",
        content: { tasks: ["task 1"] },
        replace: false,
      } as ActivitySnapshotEvent,
      {
        type: EventType.RUN_FINISHED,
      } as RunFinishedEvent,
    ];

    agent.setEvents(firstRunEvents);
    await agent.runAgent({ runId: "run-1" });

    expect(agent.messages.length).toBe(1);
    expect(agent.messages[0].role).toBe("activity");

    const secondRunEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-2",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-2",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-2",
        delta: "Hello from run 2",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-2",
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
      } as RunFinishedEvent,
    ];

    agent.setEvents(secondRunEvents);
    await agent.runAgent({ runId: "run-2" });

    expect(agent.messages.length).toBe(2);
    expect(agent.messages.some((message) => message.role === "activity" && message.id === "activity-1")).toBe(true);
  });
});
