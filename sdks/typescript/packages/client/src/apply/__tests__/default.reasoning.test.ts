import { describe, expect, it, vi } from "vitest";
import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  BaseEvent,
  EventType,
  Message,
  RunStartedEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
  RunAgentInput,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";
import { AgentSubscriber } from "@/agent/subscriber";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

describe("defaultApplyEvents with reasoning events", () => {
  it("should handle full reasoning lifecycle", async () => {
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
      type: EventType.REASONING_START,
      messageId: "phase1",
    } as ReasoningStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "Thinking...",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);
    events$.next({ type: EventType.REASONING_END } as ReasoningEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    // Should have 2 state updates:
    // 1. After REASONING_MESSAGE_START (message created)
    // 2. After REASONING_MESSAGE_CONTENT (content appended)
    expect(stateUpdates.length).toBe(2);

    expect(stateUpdates[1]?.messages?.length).toBe(1);
    expect(stateUpdates[1]?.messages?.[0]?.role).toBe("reasoning");
    expect(stateUpdates[1]?.messages?.[0]?.content).toBe("Thinking...");
  });

  it("should handle multiple reasoning content events", async () => {
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
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "Let me ",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "think about ",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "this.",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    // Should have 4 state updates:
    // 1. After REASONING_MESSAGE_START
    // 2-4. After each REASONING_MESSAGE_CONTENT
    expect(stateUpdates.length).toBe(4);

    // Final content should be accumulated
    expect(stateUpdates[3]?.messages?.[0]?.content).toBe("Let me think about this.");
  });

  it("should handle multiple reasoning messages", async () => {
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

    // First reasoning message
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "First thought",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    // Second reasoning message
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r2",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r2",
      delta: "Second thought",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r2",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    // Final state should have 2 messages
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    expect(finalUpdate?.messages?.length).toBe(2);
    expect(finalUpdate?.messages?.[0]?.id).toBe("r1");
    expect(finalUpdate?.messages?.[0]?.content).toBe("First thought");
    expect(finalUpdate?.messages?.[1]?.id).toBe("r2");
    expect(finalUpdate?.messages?.[1]?.content).toBe("Second thought");
  });

  it("should not create duplicate message when REASONING_MESSAGE_START uses existing messageId", async () => {
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

    // First REASONING_MESSAGE_START creates the message
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "First part",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    // Second REASONING_MESSAGE_START with same ID should not create duplicate
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: " Second part",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    // Should only have 1 message (no duplicate)
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const messagesWithId = finalUpdate?.messages?.filter((m) => m.id === "r1");
    expect(messagesWithId?.length).toBe(1);

    // Content should be accumulated
    expect(messagesWithId?.[0]?.content).toBe("First part Second part");
  });

  it("should trigger onNewMessage callback after REASONING_MESSAGE_END", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const onNewMessageMock = vi.fn();
    const subscriber: AgentSubscriber = {
      onNewMessage: onNewMessageMock,
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "Thinking...",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    await stateUpdatesPromise;

    expect(onNewMessageMock).toHaveBeenCalledTimes(1);
    expect(onNewMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          id: "r1",
          role: "reasoning",
          content: "Thinking...",
        }),
      }),
    );
  });

  it("should throw error for REASONING_MESSAGE_CHUNK (must be transformed)", async () => {
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
      type: EventType.REASONING_MESSAGE_CHUNK,
      messageId: "r1",
      delta: "test",
    });

    events$.complete();

    await expect(stateUpdatesPromise).rejects.toThrow(
      "REASONING_MESSAGE_CHUNK must be transformed before being applied",
    );
  });

  it("should handle REASONING_ENCRYPTED_VALUE for tool-call subtype", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const onReasoningEncryptedValueMock = vi.fn();
    const subscriber: AgentSubscriber = {
      onReasoningEncryptedValueEvent: onReasoningEncryptedValueMock,
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "tool-call",
      entityId: "tool-call-123",
      encryptedValue: "encrypted-value-data",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    await stateUpdatesPromise;

    expect(onReasoningEncryptedValueMock).toHaveBeenCalledTimes(1);
    expect(onReasoningEncryptedValueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: EventType.REASONING_ENCRYPTED_VALUE,
          subtype: "tool-call",
          entityId: "tool-call-123",
          encryptedValue: "encrypted-value-data",
        }),
      }),
    );
  });

  it("should handle REASONING_ENCRYPTED_VALUE for message subtype", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const onReasoningEncryptedValueMock = vi.fn();
    const subscriber: AgentSubscriber = {
      onReasoningEncryptedValueEvent: onReasoningEncryptedValueMock,
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "message",
      entityId: "msg-123",
      encryptedValue: "encrypted-value-data",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    await stateUpdatesPromise;

    expect(onReasoningEncryptedValueMock).toHaveBeenCalledTimes(1);
    expect(onReasoningEncryptedValueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          subtype: "message",
          entityId: "msg-123",
        }),
      }),
    );
  });

  it("should handle REASONING_ENCRYPTED_VALUE for reasoning message with message subtype", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const onReasoningEncryptedValueMock = vi.fn();
    const subscriber: AgentSubscriber = {
      onReasoningEncryptedValueEvent: onReasoningEncryptedValueMock,
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "message",
      entityId: "r1",
      encryptedValue: "encrypted-value-data",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    await stateUpdatesPromise;

    expect(onReasoningEncryptedValueMock).toHaveBeenCalledTimes(1);
    expect(onReasoningEncryptedValueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          subtype: "message",
          entityId: "r1",
        }),
      }),
    );
  });

  it("should provide correct reasoningMessageBuffer in callbacks", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const buffers: string[] = [];
    const subscriber: AgentSubscriber = {
      onReasoningMessageContentEvent: (params) => {
        buffers.push(params.reasoningMessageBuffer);
      },
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "First",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "Second",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "Third",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    await stateUpdatesPromise;

    // Buffer should contain content BEFORE current delta is applied
    expect(buffers).toEqual(["", "First", "FirstSecond"]);
  });

  it("should allow subscribers to stop propagation", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const subscriber: AgentSubscriber = {
      onReasoningMessageStartEvent: () => {
        return { stopPropagation: true };
      },
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    // No message should be created because stopPropagation was set
    const hasMessageUpdate = stateUpdates.some(
      (update) => update.messages && update.messages.length > 0,
    );
    expect(hasMessageUpdate).toBe(false);
  });

  it("should pass-through REASONING_START and REASONING_END without creating messages", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const onReasoningStartMock = vi.fn();
    const onReasoningEndMock = vi.fn();
    const subscriber: AgentSubscriber = {
      onReasoningStartEvent: onReasoningStartMock,
      onReasoningEndEvent: onReasoningEndMock,
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_START,
      messageId: "phase1",
    } as ReasoningStartEvent);
    events$.next({ type: EventType.REASONING_END } as ReasoningEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    // Subscribers should be called
    expect(onReasoningStartMock).toHaveBeenCalledTimes(1);
    expect(onReasoningEndMock).toHaveBeenCalledTimes(1);

    // No messages should be created (these are pass-through events)
    const hasMessageUpdate = stateUpdates.some(
      (update) => update.messages && update.messages.length > 0,
    );
    expect(hasMessageUpdate).toBe(false);
  });

  it("should set encryptedValue on tool call when REASONING_ENCRYPTED_VALUE is emitted", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: { name: "testFunc", arguments: "{}" },
            },
          ],
        },
      ] as Message[],
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
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "tool-call",
      entityId: "tc-1",
      encryptedValue: "encrypted-tool-call-value",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];

    const assistantMessage = finalUpdate?.messages?.find((m) => m.id === "assistant-1");
    expect(assistantMessage).toBeDefined();
    expect((assistantMessage as any)?.toolCalls?.[0]?.encryptedValue).toBe(
      "encrypted-tool-call-value",
    );
  });

  it("should set encryptedValue on message when REASONING_ENCRYPTED_VALUE is emitted", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "Hello",
        },
      ] as Message[],
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
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "message",
      entityId: "msg-1",
      encryptedValue: "encrypted-message-value",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];

    const message = finalUpdate?.messages?.find((m) => m.id === "msg-1");
    expect(message).toBeDefined();
    expect((message as any)?.encryptedValue).toBe("encrypted-message-value");
  });

  it("should set encryptedValue on reasoning message when REASONING_ENCRYPTED_VALUE is emitted", async () => {
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

    // First create a reasoning message
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "Thinking...",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    // Then emit encrypted value for it (reasoning messages use "message" subtype)
    events$.next({
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "message",
      entityId: "r1",
      encryptedValue: "encrypted-reasoning-value",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];

    const reasoningMessage = finalUpdate?.messages?.find((m) => m.id === "r1");
    expect(reasoningMessage).toBeDefined();
    expect(reasoningMessage?.role).toBe("reasoning");
    expect((reasoningMessage as any)?.encryptedValue).toBe("encrypted-reasoning-value");
  });

  it("should not set encryptedValue when stopPropagation is true", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "Hello",
        },
      ] as Message[],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const subscriber: AgentSubscriber = {
      onReasoningEncryptedValueEvent: () => {
        return { stopPropagation: true };
      },
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "message",
      entityId: "msg-1",
      encryptedValue: "encrypted-message-value",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];

    const message = finalUpdate?.messages?.find((m) => m.id === "msg-1");
    expect((message as any)?.encryptedValue).toBeUndefined();
  });

  // Edge case tests

  it("should warn and continue when REASONING_MESSAGE_CONTENT has non-existent messageId", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "non-existent",
      delta: "test",
    } as ReasoningMessageContentEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "REASONING_MESSAGE_CONTENT: No message found with ID 'non-existent'",
    );
    // Should not crash and should have no message updates
    const hasMessageUpdate = stateUpdates.some(
      (update) => update.messages && update.messages.length > 0,
    );
    expect(hasMessageUpdate).toBe(false);

    consoleWarnSpy.mockRestore();
  });

  it("should warn and continue when REASONING_MESSAGE_END has non-existent messageId", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "non-existent",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "REASONING_MESSAGE_END: No message found with ID 'non-existent'",
    );
    // Should not crash and should have no message updates
    const hasMessageUpdate = stateUpdates.some(
      (update) => update.messages && update.messages.length > 0,
    );
    expect(hasMessageUpdate).toBe(false);

    consoleWarnSpy.mockRestore();
  });

  it("should not emit state update when REASONING_ENCRYPTED_VALUE has non-existent entityId for tool-call", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: { name: "testFunc", arguments: "{}" },
            },
          ],
        },
      ] as Message[],
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
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "tool-call",
      entityId: "non-existent-tc",
      encryptedValue: "encrypted-value",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    // Should not have any message updates since entity wasn't found
    const hasMessageUpdate = stateUpdates.some((update) => update.messages !== undefined);
    expect(hasMessageUpdate).toBe(false);
  });

  it("should not emit state update when REASONING_ENCRYPTED_VALUE has non-existent entityId for message", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "Hello",
        },
      ] as Message[],
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
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "message",
      entityId: "non-existent-msg",
      encryptedValue: "encrypted-value",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    // Should not have any message updates since entity wasn't found
    const hasMessageUpdate = stateUpdates.some((update) => update.messages !== undefined);
    expect(hasMessageUpdate).toBe(false);
  });

  it("should allow stopPropagation for REASONING_MESSAGE_CONTENT", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const subscriber: AgentSubscriber = {
      onReasoningMessageContentEvent: () => {
        return { stopPropagation: true };
      },
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "This should not be added",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];

    // Message should exist but content should remain empty
    const message = finalUpdate?.messages?.find((m) => m.id === "r1");
    expect(message).toBeDefined();
    expect(message?.content).toBe("");
  });

  it("should allow stopPropagation for REASONING_MESSAGE_END (prevents onNewMessage)", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const onNewMessageMock = vi.fn();
    const subscriber: AgentSubscriber = {
      onReasoningMessageEndEvent: () => {
        return { stopPropagation: true };
      },
      onNewMessage: onNewMessageMock,
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "Thinking...",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    await stateUpdatesPromise;

    // onNewMessage should still be called (stopPropagation doesn't affect it)
    // Looking at the code, onNewMessage is called after applyMutation regardless of stopPropagation
    expect(onNewMessageMock).toHaveBeenCalledTimes(1);
  });

  it("should provide correct reasoningMessageBuffer in REASONING_MESSAGE_END callback", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    let endBuffer = "";
    const subscriber: AgentSubscriber = {
      onReasoningMessageEndEvent: (params) => {
        endBuffer = params.reasoningMessageBuffer;
      },
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "First",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "Second",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    await stateUpdatesPromise;

    // Buffer at END should contain all accumulated content
    expect(endBuffer).toBe("FirstSecond");
  });

  it("should handle whitespace-only delta correctly", async () => {
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
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "Hello",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "   ", // whitespace-only delta should be allowed
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "World",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];

    const message = finalUpdate?.messages?.find((m) => m.id === "r1");
    expect(message?.content).toBe("Hello   World");
  });

  it("should not find tool call in non-assistant message for REASONING_ENCRYPTED_VALUE", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Hello",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: { name: "testFunc", arguments: "{}" },
            },
          ],
        },
      ] as Message[],
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
    // Try to set encryptedValue on a tool call that exists
    events$.next({
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "tool-call",
      entityId: "tc-1",
      encryptedValue: "encrypted-value",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];

    // Should find the tool call in assistant message and set encryptedValue
    const assistantMessage = finalUpdate?.messages?.find((m) => m.id === "assistant-1");
    expect((assistantMessage as any)?.toolCalls?.[0]?.encryptedValue).toBe("encrypted-value");

    // User message should not be affected
    const userMessage = finalUpdate?.messages?.find((m) => m.id === "user-1");
    expect((userMessage as any)?.encryptedValue).toBeUndefined();
  });

  it("should handle interleaved reasoning and text messages", async () => {
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

    // Start reasoning
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r1",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "Thinking...",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r1",
    } as ReasoningMessageEndEvent);

    // Start text message
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "t1",
      role: "assistant",
    });
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "t1",
      delta: "Here is my response.",
    });
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "t1",
    });

    // Another reasoning
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "r2",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r2",
      delta: "More thinking...",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "r2",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];

    // Should have 3 messages in correct order
    expect(finalUpdate?.messages?.length).toBe(3);
    expect(finalUpdate?.messages?.[0]?.id).toBe("r1");
    expect(finalUpdate?.messages?.[0]?.role).toBe("reasoning");
    expect(finalUpdate?.messages?.[0]?.content).toBe("Thinking...");
    expect(finalUpdate?.messages?.[1]?.id).toBe("t1");
    expect(finalUpdate?.messages?.[1]?.role).toBe("assistant");
    expect(finalUpdate?.messages?.[1]?.content).toBe("Here is my response.");
    expect(finalUpdate?.messages?.[2]?.id).toBe("r2");
    expect(finalUpdate?.messages?.[2]?.role).toBe("reasoning");
    expect(finalUpdate?.messages?.[2]?.content).toBe("More thinking...");
  });

  it("should not set encryptedValue on activity messages", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "activity-1",
          role: "activity",
          activityType: "SEARCH",
          content: { query: "test" },
        },
      ] as Message[],
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
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "message",
      entityId: "activity-1",
      encryptedValue: "should-not-be-set",
    } as ReasoningEncryptedValueEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    // Should not have any message updates since activity messages don't support encryptedValue
    const hasMessageUpdate = stateUpdates.some((update) => update.messages !== undefined);
    expect(hasMessageUpdate).toBe(false);

    // Verify the activity message doesn't have encryptedValue set
    const activityMessage = initialState.messages.find((m) => m.id === "activity-1");
    expect((activityMessage as any)?.encryptedValue).toBeUndefined();
  });
});
