import { AbstractAgent } from "../agent";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageChunkEvent,
  RunStartedEvent,
  RunFinishedEvent,
} from "@ag-ui/core";
import { Observable, of } from "rxjs";

describe("AbstractAgent text message roles", () => {
  class TestAgent extends AbstractAgent {
    private events: BaseEvent[] = [];

    setEvents(events: BaseEvent[]) {
      this.events = events;
    }

    run(_input: RunAgentInput): Observable<BaseEvent> {
      return of(...this.events);
    }
  }

  // Text messages can have any role except "tool"
  const textMessageRoles = ["developer", "system", "assistant", "user"] as const;

  it.each(textMessageRoles)("should handle text messages with role '%s'", async (role) => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "test-run",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: `msg-${role}`,
        role: role,
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `msg-${role}`,
        delta: `Hello from ${role}`,
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: `msg-${role}`,
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "test-run",
      } as RunFinishedEvent,
    ];

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "test-run" });

    // Verify message was created with correct role
    expect(result.newMessages.length).toBe(1);
    expect(result.newMessages[0].role).toBe(role);
    expect(result.newMessages[0].content).toBe(`Hello from ${role}`);
    expect(agent.messages.length).toBe(1);
    expect(agent.messages[0].role).toBe(role);
  });

  it("should handle multiple messages with different roles in a single run", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "test-run",
      } as RunStartedEvent,
    ];

    // Add messages from different roles
    for (const role of textMessageRoles) {
      events.push(
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: `msg-${role}`,
          role: role,
        } as TextMessageStartEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: `msg-${role}`,
          delta: `Message from ${role}`,
        } as TextMessageContentEvent,
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: `msg-${role}`,
        } as TextMessageEndEvent,
      );
    }

    events.push({
      type: EventType.RUN_FINISHED,
      threadId: "test-thread",
      runId: "test-run",
    } as RunFinishedEvent);

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "test-run" });

    // Verify all messages were created with correct roles
    expect(result.newMessages.length).toBe(textMessageRoles.length);
    expect(agent.messages.length).toBe(textMessageRoles.length);

    textMessageRoles.forEach((role, index) => {
      expect(result.newMessages[index].role).toBe(role);
      expect(result.newMessages[index].content).toBe(`Message from ${role}`);
      expect(agent.messages[index].role).toBe(role);
    });
  });

  it("should handle text message chunks with different roles", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    // Test with chunks that specify role
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "test-run",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-user",
        role: "user",
        delta: "User chunk message",
      } as TextMessageChunkEvent,
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-system",
        role: "system",
        delta: "System chunk message",
      } as TextMessageChunkEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "test-run",
      } as RunFinishedEvent,
    ];

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "test-run" });

    // Verify messages were created from chunks
    expect(result.newMessages.length).toBe(2);
    expect(result.newMessages[0].role).toBe("user");
    expect(result.newMessages[0].content).toBe("User chunk message");
    expect(result.newMessages[1].role).toBe("system");
    expect(result.newMessages[1].content).toBe("System chunk message");
  });

  it("should default to 'assistant' role when not specified", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "test-run",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-default",
        // role not specified - should default to assistant
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-default",
        delta: "Default role message",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-default",
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "test-run",
      } as RunFinishedEvent,
    ];

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "test-run" });

    // Verify message was created with default 'assistant' role
    expect(result.newMessages.length).toBe(1);
    expect(result.newMessages[0].role).toBe("assistant");
    expect(result.newMessages[0].content).toBe("Default role message");
  });

  it("should preserve role when mixing regular and chunk events", async () => {
    const agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [],
    });

    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "test-run",
      } as RunStartedEvent,
      // Regular message with user role
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-1",
        role: "user",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "User message",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-1",
      } as TextMessageEndEvent,
      // Chunk message with developer role
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-2",
        role: "developer",
        delta: "Developer chunk",
      } as TextMessageChunkEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "test-run",
      } as RunFinishedEvent,
    ];

    agent.setEvents(events);
    const result = await agent.runAgent({ runId: "test-run" });

    // Verify both message types preserved their roles
    expect(result.newMessages.length).toBe(2);
    expect(result.newMessages[0].role).toBe("user");
    expect(result.newMessages[0].content).toBe("User message");
    expect(result.newMessages[1].role).toBe("developer");
    expect(result.newMessages[1].content).toBe("Developer chunk");
  });
});
