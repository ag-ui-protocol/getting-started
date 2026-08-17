import { AbstractAgent } from "../agent";
import { AgentSubscriber } from "../subscriber";
import {
  BaseEvent,
  Message,
  RunAgentInput,
  State,
  ToolCall,
  AssistantMessage,
} from "@ag-ui/core";
import { Observable, of } from "rxjs";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock uuid module
vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue("mock-uuid"),
}));

// Mock utils
vi.mock("@/utils", async () => {
  const actual = await vi.importActual<typeof import("@/utils")>("@/utils");
  return {
    ...actual,
    structuredClone_: (obj: any) => {
      if (obj === undefined) return undefined;
      const jsonString = JSON.stringify(obj);
      if (jsonString === undefined || jsonString === "undefined") return undefined;
      return JSON.parse(jsonString);
    },
  };
});

// Helper function to wait for async notifications to complete
const waitForAsyncNotifications = async () => {
  // Wait for the next tick of the event loop to ensure async operations complete
  await new Promise((resolve) => setImmediate(resolve));
};

// Mock the verify and chunks modules
vi.mock("@/verify", () => ({
  verifyEvents: vi.fn(() => (source$: Observable<any>) => source$),
}));

vi.mock("@/chunks", () => ({
  transformChunks: vi.fn(() => (source$: Observable<any>) => source$),
}));

// Create a test agent implementation
class TestAgent extends AbstractAgent {
  run(_input: RunAgentInput): Observable<BaseEvent> {
    return of();
  }
}

describe("Agent Mutations", () => {
  let agent: TestAgent;
  let mockSubscriber: AgentSubscriber;

  beforeEach(() => {
    vi.clearAllMocks();

    agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [
        {
          id: "initial-msg",
          role: "user",
          content: "Initial message",
        },
      ],
      initialState: { counter: 0 },
    });

    mockSubscriber = {
      onMessagesChanged: vi.fn(),
      onStateChanged: vi.fn(),
      onNewMessage: vi.fn(),
      onNewToolCall: vi.fn(),
    };

    agent.subscribe(mockSubscriber);
  });

  describe("addMessage", () => {
    it("should add a user message and fire appropriate events", async () => {
      const userMessage: Message = {
        id: "user-msg-1",
        role: "user",
        content: "Hello world",
      };

      agent.addMessage(userMessage);

      // Message should be added immediately
      expect(agent.messages).toHaveLength(2);
      expect(agent.messages[1]).toBe(userMessage);

      // Wait for async notifications
      await waitForAsyncNotifications();

      // Should fire onNewMessage and onMessagesChanged
      expect(mockSubscriber.onNewMessage).toHaveBeenCalledWith({
        message: userMessage,
        messages: agent.messages,
        state: agent.state,
        agent,
      });

      expect(mockSubscriber.onMessagesChanged).toHaveBeenCalledWith({
        messages: agent.messages,
        state: agent.state,
        agent,
      });

      // Should NOT fire onNewToolCall for user messages
      expect(mockSubscriber.onNewToolCall).not.toHaveBeenCalled();
    });

    it("should add an assistant message without tool calls", async () => {
      const assistantMessage: Message = {
        id: "assistant-msg-1",
        role: "assistant",
        content: "How can I help you?",
      };

      agent.addMessage(assistantMessage);

      // Wait for async notifications
      await waitForAsyncNotifications();

      expect(mockSubscriber.onNewMessage).toHaveBeenCalledWith({
        message: assistantMessage,
        messages: agent.messages,
        state: agent.state,
        agent,
      });

      expect(mockSubscriber.onMessagesChanged).toHaveBeenCalledWith({
        messages: agent.messages,
        state: agent.state,
        agent,
      });

      // Should NOT fire onNewToolCall when no tool calls
      expect(mockSubscriber.onNewToolCall).not.toHaveBeenCalled();
    });

    it("should add an assistant message with tool calls and fire onNewToolCall", async () => {
      const toolCalls: ToolCall[] = [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"location": "New York"}',
          },
        },
        {
          id: "call-2",
          type: "function",
          function: {
            name: "search_web",
            arguments: '{"query": "latest news"}',
          },
        },
      ];

      const assistantMessage: Message = {
        id: "assistant-msg-2",
        role: "assistant",
        content: "Let me help you with that.",
        toolCalls,
      };

      agent.addMessage(assistantMessage);

      // Wait for async notifications
      await waitForAsyncNotifications();

      expect(mockSubscriber.onNewMessage).toHaveBeenCalledWith({
        message: assistantMessage,
        messages: agent.messages,
        state: agent.state,
        agent,
      });

      // Should fire onNewToolCall for each tool call
      expect(mockSubscriber.onNewToolCall).toHaveBeenCalledTimes(2);

      expect(mockSubscriber.onNewToolCall).toHaveBeenNthCalledWith(1, {
        toolCall: toolCalls[0],
        messages: agent.messages,
        state: agent.state,
        agent,
      });

      expect(mockSubscriber.onNewToolCall).toHaveBeenNthCalledWith(2, {
        toolCall: toolCalls[1],
        messages: agent.messages,
        state: agent.state,
        agent,
      });

      expect(mockSubscriber.onMessagesChanged).toHaveBeenCalledWith({
        messages: agent.messages,
        state: agent.state,
        agent,
      });
    });
  });

  describe("addMessages", () => {
    it("should add multiple messages and fire events correctly", async () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "user",
          content: "First message",
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "Second message",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "test_tool",
                arguments: '{"param": "value"}',
              },
            },
          ],
        },
        {
          id: "msg-3",
          role: "user",
          content: "Third message",
        },
      ];

      const initialLength = agent.messages.length;
      agent.addMessages(messages);

      // Messages should be added immediately
      expect(agent.messages).toHaveLength(initialLength + 3);

      // Wait for async notifications
      await waitForAsyncNotifications();

      // Should fire onNewMessage for each message
      expect(mockSubscriber.onNewMessage).toHaveBeenCalledTimes(3);

      // Should fire onNewToolCall only for the assistant message with tool calls
      expect(mockSubscriber.onNewToolCall).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onNewToolCall).toHaveBeenCalledWith({
        toolCall: (messages[1] as AssistantMessage).toolCalls![0],
        messages: agent.messages,
        state: agent.state,
        agent,
      });

      // Should fire onMessagesChanged only once at the end
      expect(mockSubscriber.onMessagesChanged).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onMessagesChanged).toHaveBeenCalledWith({
        messages: agent.messages,
        state: agent.state,
        agent,
      });
    });

    it("should handle empty array gracefully", async () => {
      const initialLength = agent.messages.length;
      agent.addMessages([]);

      expect(agent.messages).toHaveLength(initialLength);

      // Wait for async notifications
      await waitForAsyncNotifications();

      // Should still fire onMessagesChanged even for empty array
      expect(mockSubscriber.onMessagesChanged).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onNewMessage).not.toHaveBeenCalled();
      expect(mockSubscriber.onNewToolCall).not.toHaveBeenCalled();
    });
  });

  describe("setMessages", () => {
    it("should replace messages and fire onMessagesChanged only", async () => {
      const newMessages: Message[] = [
        {
          id: "new-msg-1",
          role: "user",
          content: "New conversation start",
        },
        {
          id: "new-msg-2",
          role: "assistant",
          content: "Assistant response",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "some_tool",
                arguments: "{}",
              },
            },
          ],
        },
      ];

      const originalMessage = agent.messages[0];
      agent.setMessages(newMessages);

      // Messages should be replaced immediately
      expect(agent.messages).toHaveLength(2);
      expect(agent.messages).not.toContain(originalMessage); // Original message should be gone
      expect(agent.messages[0]).toEqual(newMessages[0]);
      expect(agent.messages[1]).toEqual(newMessages[1]);

      // Wait for async notifications
      await waitForAsyncNotifications();

      // Should ONLY fire onMessagesChanged
      expect(mockSubscriber.onMessagesChanged).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onMessagesChanged).toHaveBeenCalledWith({
        messages: agent.messages,
        state: agent.state,
        agent,
      });

      // Should NOT fire onNewMessage or onNewToolCall
      expect(mockSubscriber.onNewMessage).not.toHaveBeenCalled();
      expect(mockSubscriber.onNewToolCall).not.toHaveBeenCalled();
    });

    it("should handle empty messages array", async () => {
      agent.setMessages([]);

      expect(agent.messages).toHaveLength(0);

      // Wait for async notifications
      await waitForAsyncNotifications();

      expect(mockSubscriber.onMessagesChanged).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onNewMessage).not.toHaveBeenCalled();
      expect(mockSubscriber.onNewToolCall).not.toHaveBeenCalled();
    });
  });

  describe("setState", () => {
    it("should replace state and fire onStateChanged only", async () => {
      const newState: State = {
        counter: 100,
        isActive: true,
        data: { key: "value" },
      };

      agent.setState(newState);

      // State should be replaced immediately
      expect(agent.state).toEqual(newState);
      expect(agent.state).not.toBe(newState); // Should be a clone

      // Wait for async notifications
      await waitForAsyncNotifications();

      // Should ONLY fire onStateChanged
      expect(mockSubscriber.onStateChanged).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onStateChanged).toHaveBeenCalledWith({
        messages: agent.messages,
        state: agent.state,
        agent,
      });

      // Should NOT fire other events
      expect(mockSubscriber.onMessagesChanged).not.toHaveBeenCalled();
      expect(mockSubscriber.onNewMessage).not.toHaveBeenCalled();
      expect(mockSubscriber.onNewToolCall).not.toHaveBeenCalled();
    });

    it("should handle empty state object", async () => {
      agent.setState({});

      expect(agent.state).toEqual({});

      // Wait for async notifications
      await waitForAsyncNotifications();

      expect(mockSubscriber.onStateChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe("execution order", () => {
    it("should execute subscriber notifications in registration order", async () => {
      const callOrder: string[] = [];

      const firstSubscriber: AgentSubscriber = {
        onNewMessage: vi.fn().mockImplementation(() => {
          callOrder.push("first-newMessage");
        }),
        onMessagesChanged: vi.fn().mockImplementation(() => {
          callOrder.push("first-messagesChanged");
        }),
      };

      const secondSubscriber: AgentSubscriber = {
        onNewMessage: vi.fn().mockImplementation(() => {
          callOrder.push("second-newMessage");
        }),
        onMessagesChanged: vi.fn().mockImplementation(() => {
          callOrder.push("second-messagesChanged");
        }),
      };

      // Clear the default subscriber and add our test subscribers
      agent.subscribers = [];
      agent.subscribe(firstSubscriber);
      agent.subscribe(secondSubscriber);

      const message: Message = {
        id: "test-msg",
        role: "user",
        content: "Test message",
      };

      agent.addMessage(message);

      // Wait for all async operations to complete by polling until all calls are made
      while (callOrder.length < 4) {
        await waitForAsyncNotifications();
      }

      // Verify sequential execution order
      expect(callOrder).toEqual([
        "first-newMessage",
        "second-newMessage",
        "first-messagesChanged",
        "second-messagesChanged",
      ]);
    });
  });

  describe("multiple subscribers", () => {
    it("should notify all subscribers for each event", async () => {
      const subscriber2: AgentSubscriber = {
        onNewMessage: vi.fn(),
        onMessagesChanged: vi.fn(),
        onNewToolCall: vi.fn(),
      };

      const subscriber3: AgentSubscriber = {
        onNewMessage: vi.fn(),
        onMessagesChanged: vi.fn(),
      };

      agent.subscribe(subscriber2);
      agent.subscribe(subscriber3);

      const message: Message = {
        id: "test-msg",
        role: "assistant",
        content: "Test",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "test", arguments: "{}" },
          },
        ],
      };

      agent.addMessage(message);

      // Wait for async notifications
      await waitForAsyncNotifications();

      // All subscribers should receive notifications
      [mockSubscriber, subscriber2, subscriber3].forEach((sub) => {
        expect(sub.onNewMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            message,
            agent,
          }),
        );
        expect(sub.onMessagesChanged).toHaveBeenCalled();
      });

      // Only subscribers with onNewToolCall should receive tool call events
      expect(mockSubscriber.onNewToolCall).toHaveBeenCalled();
      expect(subscriber2.onNewToolCall).toHaveBeenCalled();
      // subscriber3 doesn't have onNewToolCall method, so it shouldn't be called
      expect(subscriber3.onNewToolCall).toBeUndefined();
    });
  });
});
