import { Subject } from "rxjs";
import { toArray, catchError } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import { verifyEvents } from "../verify";
import {
  BaseEvent,
  EventType,
  AGUIError,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  StepStartedEvent,
  StepFinishedEvent,
} from "@ag-ui/core";

const runFinished = (threadId: string, runId: string): RunFinishedEvent => ({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
});

describe("verifyEvents multiple runs", () => {
  // Test: Basic multiple sequential runs
  it("should allow multiple sequential runs", async () => {
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

    // First run
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-1",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "Hello from run 1",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);
    source$.next(runFinished("test-thread-1", "test-run-1"));

    // Second run
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-2",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-2",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-2",
      delta: "Hello from run 2",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-2",
    } as TextMessageEndEvent);
    source$.next(runFinished("test-thread-1", "test-run-2"));

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(10);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect((result[0] as RunStartedEvent).runId).toBe("test-run-1");
    expect(result[4].type).toBe(EventType.RUN_FINISHED);
    expect(result[5].type).toBe(EventType.RUN_STARTED);
    expect((result[5] as RunStartedEvent).runId).toBe("test-run-2");
    expect(result[9].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Multiple runs with different message IDs
  it("should allow reusing message IDs across different runs", async () => {
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

    // First run with message ID "msg-1"
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-1",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);
    source$.next(runFinished("test-thread-1", "test-run-1"));

    // Second run reusing message ID "msg-1" (should be allowed)
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-2",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);
    source$.next(runFinished("test-thread-1", "test-run-2"));

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(8);
  });

  // Test: Multiple runs with tool calls
  it("should allow multiple runs with tool calls", async () => {
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

    // First run with tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-1",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "calculator",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-1",
      delta: '{"a": 1, "b": 2}',
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-1",
    } as ToolCallEndEvent);
    source$.next(runFinished("test-thread-1", "test-run-1"));

    // Second run with tool call (reusing toolCallId should be allowed)
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-2",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "weather",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-1",
      delta: '{"city": "NYC"}',
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-1",
    } as ToolCallEndEvent);
    source$.next(runFinished("test-thread-1", "test-run-2"));

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(10);
  });

  // Test: Multiple runs with steps
  it("should allow multiple runs with steps", async () => {
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

    // First run with steps
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-1",
    } as RunStartedEvent);
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "planning",
    } as StepStartedEvent);
    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "planning",
    } as StepFinishedEvent);
    source$.next(runFinished("test-thread-1", "test-run-1"));

    // Second run reusing step name (should be allowed)
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-2",
    } as RunStartedEvent);
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "planning",
    } as StepStartedEvent);
    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "planning",
    } as StepFinishedEvent);
    source$.next(runFinished("test-thread-1", "test-run-2"));

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(8);
  });

  // Test: Cannot start new run while current run is active
  it("should not allow new RUN_STARTED while run is active", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain("Cannot send 'RUN_STARTED' while a run is still active");
        subscription.unsubscribe();
      },
    });

    // Start first run
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-1",
    } as RunStartedEvent);

    // Try to start second run without finishing first (should fail)
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-2",
    } as RunStartedEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only first RUN_STARTED was processed
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: Three sequential runs
  it("should allow three sequential runs", async () => {
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

    // Three sequential runs
    for (let i = 1; i <= 3; i++) {
      source$.next({
        type: EventType.RUN_STARTED,
        threadId: "test-thread-1",
        runId: `test-run-${i}`,
      } as RunStartedEvent);
      source$.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: `msg-${i}`,
      } as TextMessageStartEvent);
      source$.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `msg-${i}`,
        delta: `Message from run ${i}`,
      } as TextMessageContentEvent);
      source$.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: `msg-${i}`,
      } as TextMessageEndEvent);
      source$.next(runFinished("test-thread-1", `test-run-${i}`));
    }

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed (5 events per run * 3 runs = 15 events)
    expect(result.length).toBe(15);

    // Verify run IDs are correct
    expect((result[0] as RunStartedEvent).runId).toBe("test-run-1");
    expect((result[5] as RunStartedEvent).runId).toBe("test-run-2");
    expect((result[10] as RunStartedEvent).runId).toBe("test-run-3");
  });

  // Test: RUN_ERROR still blocks subsequent events in the same run
  it("should still block events after RUN_ERROR within the same run", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain("The run has already errored with 'RUN_ERROR'");
        subscription.unsubscribe();
      },
    });

    // Start run and send error
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-1",
    } as RunStartedEvent);
    source$.next({
      type: EventType.RUN_ERROR,
      message: "Test error",
    } as RunErrorEvent);

    // Try to send another event (should fail)
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
    } as TextMessageStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify events before error were processed
    expect(events.length).toBe(2);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.RUN_ERROR);
  });

  // Test: A new run may start after a previous one errored
  it("should allow a new RUN_STARTED after RUN_ERROR", async () => {
    const source$ = new Subject<BaseEvent>();

    const promise = firstValueFrom(
      verifyEvents(false)(source$).pipe(
        toArray(),
        catchError((err) => {
          throw err;
        }),
      ),
    );

    // First run errors
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-1",
    } as RunStartedEvent);
    source$.next({
      type: EventType.RUN_ERROR,
      message: "Agent unreachable",
    } as RunErrorEvent);

    // Second run starts and succeeds
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-2",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);
    source$.next(runFinished("test-thread-1", "test-run-2"));

    source$.complete();

    const result = await promise;

    expect(result.length).toBe(6);
    expect(result[1].type).toBe(EventType.RUN_ERROR);
    expect((result[2] as RunStartedEvent).runId).toBe("test-run-2");
    expect(result[5].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Replaying a stored thread whose middle run errored
  it("should replay a thread containing an errored run without dropping later runs", async () => {
    const source$ = new Subject<BaseEvent>();

    const promise = firstValueFrom(
      verifyEvents(false)(source$).pipe(
        toArray(),
        catchError((err) => {
          throw err;
        }),
      ),
    );

    // Run 1 succeeded
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-1",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);
    source$.next(runFinished("test-thread-1", "test-run-1"));

    // Run 2 errored, mid-message, which is what a dropped connection looks like
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-2",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-2",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.RUN_ERROR,
      message: "Agent restarted",
    } as RunErrorEvent);

    // Run 3 succeeded, and reuses the message ID left open by the errored run
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-3",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-2",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-2",
    } as TextMessageEndEvent);
    source$.next(runFinished("test-thread-1", "test-run-3"));

    source$.complete();

    const result = await promise;

    // Every event in the thread is delivered, not just those up to the failure
    expect(result.length).toBe(11);
    expect((result[7] as RunStartedEvent).runId).toBe("test-run-3");
    expect(result[10].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Complex scenario with mixed events across runs
  it("should handle complex scenario with multiple runs and various event types", async () => {
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

    // First run: message + tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-1",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-1",
    } as ToolCallEndEvent);
    source$.next(runFinished("test-thread-1", "test-run-2"));

    // Second run: step + message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-1",
      runId: "test-run-2",
    } as RunStartedEvent);
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "analysis",
    } as StepStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-2",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-2",
    } as TextMessageEndEvent);
    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "analysis",
    } as StepFinishedEvent);
    source$.next(runFinished("test-thread-1", "test-run-2"));

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(12);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[5].type).toBe(EventType.RUN_FINISHED);
    expect(result[6].type).toBe(EventType.RUN_STARTED);
    expect(result[11].type).toBe(EventType.RUN_FINISHED);
  });
});
