import { Subject } from "rxjs";
import { toArray, catchError } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import { verifyEvents } from "../verify";
import {
  BaseEvent,
  EventType,
  AGUIError,
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
} from "@ag-ui/core";

describe("verifyEvents concurrent operations", () => {
  // Test: Concurrent text messages with different IDs should be allowed
  it("should allow concurrent text messages with different IDs", async () => {
    const source$ = new Subject<BaseEvent>();

    // Set up subscription and collect events
    const promise = firstValueFrom(
      verifyEvents(false)(source$).pipe(
        toArray(),
        catchError((err) => {
          throw err;
        }),
      ),
    );

    // Send concurrent text messages
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Start first message
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
    } as TextMessageStartEvent);

    // Start second message before first one ends
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg2",
    } as TextMessageStartEvent);

    // Content for both messages
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Content for message 1",
    } as TextMessageContentEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg2",
      delta: "Content for message 2",
    } as TextMessageContentEvent);

    // End messages in different order
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg2",
    } as TextMessageEndEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test",
      runId: "test",
    } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(8);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[1].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[2].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[7].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Concurrent tool calls with different IDs should be allowed
  it("should allow concurrent tool calls with different IDs", async () => {
    const source$ = new Subject<BaseEvent>();

    // Set up subscription and collect events
    const promise = firstValueFrom(
      verifyEvents(false)(source$).pipe(
        toArray(),
        catchError((err) => {
          throw err;
        }),
      ),
    );

    // Send concurrent tool calls
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Start first tool call
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);

    // Start second tool call before first one ends
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool2",
      toolCallName: "calculate",
    } as ToolCallStartEvent);

    // Args for both tool calls
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);

    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool2",
      delta: '{"expression":"1+1"}',
    } as ToolCallArgsEvent);

    // End tool calls in different order
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool2",
    } as ToolCallEndEvent);

    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test",
      runId: "test",
    } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(8);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[1].type).toBe(EventType.TOOL_CALL_START);
    expect(result[2].type).toBe(EventType.TOOL_CALL_START);
    expect(result[7].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Overlapping text messages and tool calls should be allowed
  it("should allow overlapping text messages and tool calls", async () => {
    const source$ = new Subject<BaseEvent>();

    // Set up subscription and collect events
    const promise = firstValueFrom(
      verifyEvents(false)(source$).pipe(
        toArray(),
        catchError((err) => {
          throw err;
        }),
      ),
    );

    // Send overlapping text messages and tool calls
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Start a text message
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
    } as TextMessageStartEvent);

    // Start a tool call while message is active
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);

    // Send content for both
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Thinking...",
    } as TextMessageContentEvent);

    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);

    // Start another message while tool call is active
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg2",
    } as TextMessageStartEvent);

    // End in various orders
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg2",
      delta: "Based on the search...",
    } as TextMessageContentEvent);

    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg2",
    } as TextMessageEndEvent);

    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test",
      runId: "test",
    } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(11);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[10].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Steps and other lifecycle events should be allowed during concurrent messages/tool calls
  it("should allow lifecycle events during concurrent messages and tool calls", async () => {
    const source$ = new Subject<BaseEvent>();

    // Set up subscription and collect events
    const promise = firstValueFrom(
      verifyEvents(false)(source$).pipe(
        toArray(),
        catchError((err) => {
          throw err;
        }),
      ),
    );

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Start a step
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "search_step",
    } as StepStartedEvent);

    // Start messages and tool calls within the step
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
    } as TextMessageStartEvent);

    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);

    // Lifecycle events should be allowed
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "analysis_step",
    } as StepStartedEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Searching...",
    } as TextMessageContentEvent);

    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);

    // End everything
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "analysis_step",
    } as StepFinishedEvent);

    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "search_step",
    } as StepFinishedEvent);

    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test",
      runId: "test",
    } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(12);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[11].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Should reject duplicate message ID starts
  it("should reject starting a text message with an ID already in progress", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TEXT_MESSAGE_START' event: A text message with ID 'msg1' is already in progress`,
        );
        subscription.unsubscribe();
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
    } as TextMessageStartEvent);

    // Try to start the same message ID again
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
    } as TextMessageStartEvent);

    // Complete the source and wait for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
  });

  // Test: Should reject duplicate tool call ID starts
  it("should reject starting a tool call with an ID already in progress", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TOOL_CALL_START' event: A tool call with ID 'tool1' is already in progress`,
        );
        subscription.unsubscribe();
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);

    // Try to start the same tool call ID again
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "calculate",
    } as ToolCallStartEvent);

    // Complete the source and wait for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
  });

  // Test: Should reject content for non-existent message ID
  it("should reject content for non-existent message ID", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found with ID 'nonexistent'`,
        );
        subscription.unsubscribe();
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Try to send content for a message that was never started
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "nonexistent",
      delta: "test content",
    } as TextMessageContentEvent);

    // Complete the source and wait for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
  });

  // Test: Should reject args for non-existent tool call ID
  it("should reject args for non-existent tool call ID", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TOOL_CALL_ARGS' event: No active tool call found with ID 'nonexistent'`,
        );
        subscription.unsubscribe();
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Try to send args for a tool call that was never started
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "nonexistent",
      delta: '{"test":"value"}',
    } as ToolCallArgsEvent);

    // Complete the source and wait for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
  });

  // Test: Should reject RUN_FINISHED while messages are still active
  it("should reject RUN_FINISHED while text messages are still active", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'RUN_FINISHED' while text messages are still active: msg1, msg2`,
        );
        subscription.unsubscribe();
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
    } as TextMessageStartEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg2",
    } as TextMessageStartEvent);

    // Try to finish run while messages are still active
    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test",
      runId: "test",
    } as RunFinishedEvent);

    // Complete the source and wait for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(3);
  });

  // Test: Should reject RUN_FINISHED while tool calls are still active
  it("should reject RUN_FINISHED while tool calls are still active", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'RUN_FINISHED' while tool calls are still active: tool1, tool2`,
        );
        subscription.unsubscribe();
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);

    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool2",
      toolCallName: "calculate",
    } as ToolCallStartEvent);

    // Try to finish run while tool calls are still active
    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test",
      runId: "test",
    } as RunFinishedEvent);

    // Complete the source and wait for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(3);
  });

  // Test: Complex concurrent scenario with high frequency events
  it("should handle complex concurrent scenario with many overlapping events", async () => {
    const source$ = new Subject<BaseEvent>();

    // Set up subscription and collect events
    const promise = firstValueFrom(
      verifyEvents(false)(source$).pipe(
        toArray(),
        catchError((err) => {
          throw err;
        }),
      ),
    );

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Start multiple concurrent messages and tool calls
    const messageIds = ["msg1", "msg2", "msg3", "msg4", "msg5"];
    const toolCallIds = ["tool1", "tool2", "tool3", "tool4", "tool5"];

    // Start all messages
    for (const msgId of messageIds) {
      source$.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: msgId,
      } as TextMessageStartEvent);
    }

    // Start all tool calls
    for (const toolId of toolCallIds) {
      source$.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: toolId,
        toolCallName: "test_tool",
      } as ToolCallStartEvent);
    }

    // Send content/args in random order
    for (let i = 0; i < 3; i++) {
      for (const msgId of messageIds) {
        source$.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: msgId,
          delta: `Content ${i} for ${msgId}`,
        } as TextMessageContentEvent);
      }

      for (const toolId of toolCallIds) {
        source$.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolId,
          delta: `{"step":${i}}`,
        } as ToolCallArgsEvent);
      }
    }

    // End all in reverse order
    for (const msgId of [...messageIds].reverse()) {
      source$.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: msgId,
      } as TextMessageEndEvent);
    }

    for (const toolId of [...toolCallIds].reverse()) {
      source$.next({
        type: EventType.TOOL_CALL_END,
        toolCallId: toolId,
      } as ToolCallEndEvent);
    }

    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test",
      runId: "test",
    } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify we have the expected number of events:
    // 1 RUN_STARTED + 5 MSG_START + 5 TOOL_START + 15 MSG_CONTENT + 15 TOOL_ARGS + 5 MSG_END + 5 TOOL_END + 1 RUN_FINISHED = 52
    expect(result.length).toBe(52);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[51].type).toBe(EventType.RUN_FINISHED);
  });
});
