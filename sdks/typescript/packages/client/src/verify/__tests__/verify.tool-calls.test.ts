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

describe("verifyEvents tool calls", () => {
  // Test: Cannot send TOOL_CALL_ARGS before TOOL_CALL_START
  it("should not allow TOOL_CALL_ARGS before TOOL_CALL_START", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TOOL_CALL_ARGS' event: No active tool call found with ID 't1'`,
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

    // Try to send args without starting a tool call
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args",
    } as ToolCallArgsEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: Cannot send TOOL_CALL_END before TOOL_CALL_START
  it("should not allow TOOL_CALL_END before TOOL_CALL_START", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TOOL_CALL_END' event: No active tool call found with ID 't1'`,
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

    // Try to end a tool call without starting it
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
    } as ToolCallEndEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: Should allow TOOL_CALL_ARGS and TOOL_CALL_END inside a tool call
  it("should allow TOOL_CALL_ARGS and TOOL_CALL_END inside a tool call", async () => {
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

    // Send a valid sequence with tool call events
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args 1",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args 2",
    } as ToolCallArgsEvent); // Multiple args allowed
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
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
    expect(result.length).toBe(6);
    expect(result[1].type).toBe(EventType.TOOL_CALL_START);
    expect(result[2].type).toBe(EventType.TOOL_CALL_ARGS);
    expect(result[3].type).toBe(EventType.TOOL_CALL_ARGS);
    expect(result[4].type).toBe(EventType.TOOL_CALL_END);
  });

  // Test: Should allow RAW inside a tool call
  it("should allow RAW inside a tool call", async () => {
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

    // Send a valid sequence with a raw event inside a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.RAW,
      event: {
        type: "raw_data",
        content: "test",
      },
    } as RawEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
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
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.RAW);
  });

  // Test: Should allow CUSTOM inside a tool call
  it("should allow CUSTOM inside a tool call", async () => {
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

    // Send a valid sequence with a custom event inside a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.CUSTOM,
      name: "test_event",
      value: "test_value",
    } as CustomEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
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
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.CUSTOM);
  });

  // Test: Should allow STATE_SNAPSHOT inside a tool call
  it("should allow STATE_SNAPSHOT inside a tool call", async () => {
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

    // Send a valid sequence with a state snapshot inside a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        state: "test_state",
        data: { foo: "bar" },
      },
    } as StateSnapshotEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
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
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.STATE_SNAPSHOT);
  });

  // Test: Should allow STATE_DELTA inside a tool call
  it("should allow STATE_DELTA inside a tool call", async () => {
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

    // Send a valid sequence with a state delta inside a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.STATE_DELTA,
      delta: [{ op: "add", path: "/result", value: "success" }],
    } as StateDeltaEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
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
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.STATE_DELTA);
  });

  // Test: Should allow MESSAGES_SNAPSHOT inside a tool call
  it("should allow MESSAGES_SNAPSHOT inside a tool call", async () => {
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

    // Send a valid sequence with a messages snapshot inside a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ role: "user", content: "test", id: "test-id" }],
    } as MessagesSnapshotEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
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
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.MESSAGES_SNAPSHOT);
  });

  // Test: Should allow lifecycle events (STEP_STARTED/STEP_FINISHED) during tool calls
  it("should allow lifecycle events during tool calls", async () => {
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

    // Send a valid sequence with lifecycle events inside a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "test-step",
    } as StepStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "test-step",
    } as StepFinishedEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
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
    expect(result.length).toBe(7);
    expect(result[2].type).toBe(EventType.STEP_STARTED);
    expect(result[4].type).toBe(EventType.STEP_FINISHED);
  });

  // Test: Should allow text messages to start during tool calls
  it("should allow text messages to start during tool calls", async () => {
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

    // Send a valid sequence with text messages inside a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "Preparing...",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Tool is processing...",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "Completed.",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
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
    expect(result.length).toBe(9);
    expect(result[3].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[4].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(result[5].type).toBe(EventType.TEXT_MESSAGE_END);
  });

  // Test: Sequential tool calls
  it("should allow multiple sequential tool calls", async () => {
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

    // Send a valid sequence with multiple tool calls
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // First tool call
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
    } as ToolCallEndEvent);

    // Second tool call
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t2",
      toolCallName: "calculate",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t2",
      delta: '{"expression":"1+1"}',
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t2",
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
    expect(result[1].type).toBe(EventType.TOOL_CALL_START);
    expect(result[2].type).toBe(EventType.TOOL_CALL_ARGS);
    expect(result[3].type).toBe(EventType.TOOL_CALL_END);
    expect(result[4].type).toBe(EventType.TOOL_CALL_START);
    expect(result[5].type).toBe(EventType.TOOL_CALL_ARGS);
    expect(result[6].type).toBe(EventType.TOOL_CALL_END);
  });

  // Test: Tool call at run boundaries
  it("should allow tool calls immediately after RUN_STARTED and before RUN_FINISHED", async () => {
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

    // Send tool call immediately after run start and before run end
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
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
    expect(result.length).toBe(5);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[1].type).toBe(EventType.TOOL_CALL_START);
    expect(result[3].type).toBe(EventType.TOOL_CALL_END);
    expect(result[4].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Starting tool call before RUN_STARTED
  it("should not allow starting a tool call before RUN_STARTED", async () => {
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

    // Try to start a tool call before RUN_STARTED
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify no events were processed
    expect(events.length).toBe(0);
  });
});
