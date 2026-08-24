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
  RawEvent,
  CustomEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
} from "@ag-ui/core";

describe("verifyEvents text messages", () => {
  // Test: Cannot send TEXT_MESSAGE_CONTENT before TEXT_MESSAGE_START
  it("should not allow TEXT_MESSAGE_CONTENT before TEXT_MESSAGE_START", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found with ID '1'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Try to send content without starting a text message
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 1",
    } as TextMessageContentEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: Cannot send TEXT_MESSAGE_END before TEXT_MESSAGE_START
  it("should not allow TEXT_MESSAGE_END before TEXT_MESSAGE_START", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TEXT_MESSAGE_END' event: No active text message found with ID '1'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Try to end a text message without starting it
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: Should allow TEXT_MESSAGE_CONTENT inside a text message
  it("should allow TEXT_MESSAGE_CONTENT inside a text message", async () => {
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

    // Send a valid sequence with text message content
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 1",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 2",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
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
    expect(result.length).toBe(6);
    expect(result[1].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[2].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(result[3].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(result[4].type).toBe(EventType.TEXT_MESSAGE_END);
  });

  // Test: Should allow RAW inside a text message
  it("should allow RAW inside a text message", async () => {
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

    // Send a valid sequence with a raw event inside a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "test content",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.RAW,
      event: {
        type: "raw_data",
        content: "test",
      },
    } as RawEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
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
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.RAW);
  });

  // Test: Should allow CUSTOM inside a text message
  it("should allow CUSTOM inside a text message", async () => {
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

    // Send a valid sequence with a custom event inside a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "test content",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.CUSTOM,
      name: "test_event",
      value: "test_value",
    } as CustomEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
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
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.CUSTOM);
  });

  // Test: Should allow STATE_SNAPSHOT inside a text message
  it("should allow STATE_SNAPSHOT inside a text message", async () => {
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

    // Send a valid sequence with a state snapshot inside a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "test content",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        state: "test_state",
        data: { foo: "bar" },
      },
    } as StateSnapshotEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
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
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.STATE_SNAPSHOT);
  });

  // Test: Should allow STATE_DELTA inside a text message
  it("should allow STATE_DELTA inside a text message", async () => {
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

    // Send a valid sequence with a state delta inside a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "test content",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.STATE_DELTA,
      delta: [{ op: "add", path: "/result", value: "success" }],
    } as StateDeltaEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
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
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.STATE_DELTA);
  });

  // Test: Should allow MESSAGES_SNAPSHOT inside a text message
  it("should allow MESSAGES_SNAPSHOT inside a text message", async () => {
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

    // Send a valid sequence with a messages snapshot inside a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "test content",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ role: "user", content: "test", id: "test-id" }],
    } as MessagesSnapshotEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
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
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.MESSAGES_SNAPSHOT);
  });

  // Test: Should allow lifecycle events (STEP_STARTED/STEP_FINISHED) during text messages
  it("should allow lifecycle events during text messages", async () => {
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

    // Send a valid sequence with lifecycle events inside a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "test-step",
    } as StepStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "test content",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "test-step",
    } as StepFinishedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
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
    expect(result.length).toBe(7);
    expect(result[2].type).toBe(EventType.STEP_STARTED);
    expect(result[4].type).toBe(EventType.STEP_FINISHED);
  });

  // Test: Should allow tool calls to start during text messages
  it("should allow tool calls to start during text messages", async () => {
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

    // Send a valid sequence with tool calls inside a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "Starting search...",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "Search completed.",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
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
    expect(result.length).toBe(9);
    expect(result[3].type).toBe(EventType.TOOL_CALL_START);
    expect(result[4].type).toBe(EventType.TOOL_CALL_ARGS);
    expect(result[5].type).toBe(EventType.TOOL_CALL_END);
  });

  // Test: Sequential text messages
  it("should allow multiple sequential text messages", async () => {
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

    // Send a valid sequence with multiple text messages
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // First text message
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 1",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);

    // Second text message
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "2",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "2",
      delta: "content 2",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "2",
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
    expect(result[1].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[2].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(result[3].type).toBe(EventType.TEXT_MESSAGE_END);
    expect(result[4].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[5].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(result[6].type).toBe(EventType.TEXT_MESSAGE_END);
  });

  // Test: Text message at run boundaries
  it("should allow text messages immediately after RUN_STARTED and before RUN_FINISHED", async () => {
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

    // Send text message immediately after run start and before run end
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 1",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
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
    expect(result.length).toBe(5);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[1].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[3].type).toBe(EventType.TEXT_MESSAGE_END);
    expect(result[4].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Starting text message before RUN_STARTED
  it("should not allow starting a text message before RUN_STARTED", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain("First event must be 'RUN_STARTED'");
        subscription.unsubscribe();
      },
    });

    // Try to start a text message before RUN_STARTED
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify no events were processed
    expect(events.length).toBe(0);
  });
});
