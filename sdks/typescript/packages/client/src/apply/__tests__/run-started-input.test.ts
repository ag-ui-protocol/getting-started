import { AbstractAgent } from "../../agent/agent";
import {
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
  RunStartedEvent,
  RunFinishedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
} from "@ag-ui/core";
import { Observable, of } from "rxjs";
import { AgentSubscriber } from "../../agent/subscriber";

describe("RunStartedEvent with input.messages", () => {
  class TestAgent extends AbstractAgent {
    private events: BaseEvent[] = [];

    setEvents(events: BaseEvent[]) {
      this.events = events;
    }

    run(_input: RunAgentInput): Observable<BaseEvent> {
      return of(...this.events);
    }
  }

  it("should add messages from RunStartedEvent.input that are not already present", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
        input: {
          threadId: "test-thread",
          runId: "run-1",
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: "Hello",
            },
            {
              id: "msg-2",
              role: "user",
              content: "How are you?",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunFinishedEvent,
    ];

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "run-1" });

    // Verify both messages were added
    expect(agent.messages.length).toBe(2);
    expect(agent.messages[0].id).toBe("msg-1");
    expect(agent.messages[0].content).toBe("Hello");
    expect(agent.messages[1].id).toBe("msg-2");
    expect(agent.messages[1].content).toBe("How are you?");

    // Verify they appear in newMessages
    expect(result.newMessages.length).toBe(2);
  });

  it("should not duplicate messages that already exist (by ID)", async () => {
    const initialMessages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content: "Existing message",
      },
    ];

    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages,
    });

    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
        input: {
          threadId: "test-thread",
          runId: "run-1",
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: "Duplicate message (should be ignored)",
            },
            {
              id: "msg-2",
              role: "user",
              content: "New message",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunFinishedEvent,
    ];

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "run-1" });

    // Verify only the new message was added
    expect(agent.messages.length).toBe(2);
    expect(agent.messages[0].id).toBe("msg-1");
    expect(agent.messages[0].content).toBe("Existing message"); // Original content preserved
    expect(agent.messages[1].id).toBe("msg-2");
    expect(agent.messages[1].content).toBe("New message");

    // Verify only the new message appears in newMessages
    expect(result.newMessages.length).toBe(1);
    expect(result.newMessages[0].id).toBe("msg-2");
  });

  it("should handle RunStartedEvent without input field", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
        // No input field
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunFinishedEvent,
    ];

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "run-1" });

    // Verify no errors and messages remain empty
    expect(agent.messages.length).toBe(0);
    expect(result.newMessages.length).toBe(0);
  });

  it("should handle RunStartedEvent with input but no messages", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
        input: {
          threadId: "test-thread",
          runId: "run-1",
          messages: [], // Empty messages array
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunFinishedEvent,
    ];

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "run-1" });

    // Verify no errors and messages remain empty
    expect(agent.messages.length).toBe(0);
    expect(result.newMessages.length).toBe(0);
  });

  it("should respect stopPropagation from subscribers", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    // Create a subscriber that stops propagation
    const stopPropagationSubscriber: AgentSubscriber = {
      onRunStartedEvent: () => {
        return { stopPropagation: true };
      },
    };

    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
        input: {
          threadId: "test-thread",
          runId: "run-1",
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: "Should not be added",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunFinishedEvent,
    ];

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "run-1" }, stopPropagationSubscriber);

    // Verify messages were NOT added due to stopPropagation
    expect(agent.messages.length).toBe(0);
    expect(result.newMessages.length).toBe(0);
  });

  it("should add messages before other events in the same run", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
        input: {
          threadId: "test-thread",
          runId: "run-1",
          messages: [
            {
              id: "msg-from-input",
              role: "user",
              content: "From input",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-streamed",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-streamed",
        delta: "Streamed response",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-streamed",
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunFinishedEvent,
    ];

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "run-1" });

    // Verify message order: input message first, then streamed message
    expect(agent.messages.length).toBe(2);
    expect(agent.messages[0].id).toBe("msg-from-input");
    expect(agent.messages[0].content).toBe("From input");
    expect(agent.messages[1].id).toBe("msg-streamed");
    expect(agent.messages[1].content).toBe("Streamed response");

    expect(result.newMessages.length).toBe(2);
  });

  it("should handle multiple runs with input.messages", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    // First run with one message
    const firstRunEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-1",
        input: {
          threadId: "test-thread",
          runId: "run-1",
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: "First message",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "run-1",
      } as RunFinishedEvent,
    ];

    agent.setEvents(firstRunEvents);
    const result1 = await agent.runAgent({ runId: "run-1" });

    expect(agent.messages.length).toBe(1);
    expect(agent.messages[0].id).toBe("msg-1");
    expect(result1.newMessages.length).toBe(1);

    // Second run with three messages (one duplicate, two new)
    const secondRunEvents: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "run-2",
        input: {
          threadId: "test-thread",
          runId: "run-2",
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: "First message (duplicate)",
            },
            {
              id: "msg-2",
              role: "user",
              content: "Second message",
            },
            {
              id: "msg-3",
              role: "user",
              content: "Third message",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "run-2",
      } as RunFinishedEvent,
    ];

    agent.setEvents(secondRunEvents);
    const result2 = await agent.runAgent({ runId: "run-2" });

    // Verify only new messages were added
    expect(agent.messages.length).toBe(3);
    expect(agent.messages[0].id).toBe("msg-1");
    expect(agent.messages[0].content).toBe("First message"); // Original content preserved
    expect(agent.messages[1].id).toBe("msg-2");
    expect(agent.messages[1].content).toBe("Second message");
    expect(agent.messages[2].id).toBe("msg-3");
    expect(agent.messages[2].content).toBe("Third message");

    // Verify only the two new messages appear in newMessages for the second run
    expect(result2.newMessages.length).toBe(2);
    expect(result2.newMessages[0].id).toBe("msg-2");
    expect(result2.newMessages[1].id).toBe("msg-3");
  });
});
