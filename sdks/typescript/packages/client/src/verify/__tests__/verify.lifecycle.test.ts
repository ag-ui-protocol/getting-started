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
} from "@ag-ui/core";

describe("verifyEvents lifecycle", () => {
  // Test: RUN_STARTED must be the first event
  it("should require RUN_STARTED as the first event", async () => {
    const source$ = new Subject<BaseEvent>();
    const result$ = verifyEvents(false)(source$).pipe(
      catchError((err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain("First event must be 'RUN_STARTED'");
        throw err;
      }),
    );

    // Set up subscription
    const promise = firstValueFrom(result$).catch((e) => e);

    // Send an event that is not RUN_STARTED
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect it to be an error
    const result = await promise;
    expect(result).toBeInstanceOf(AGUIError);
  });

  // Test: Multiple RUN_STARTED events are not allowed
  it("should not allow multiple RUN_STARTED events", async () => {
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

    // Send first RUN_STARTED (should be accepted)
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Send second RUN_STARTED (should be rejected)
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify one event was processed before the error
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: No events should be allowed after RUN_FINISHED (except RUN_ERROR)
  it("should not allow events after RUN_FINISHED (except RUN_ERROR)", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          "Cannot send event type 'TEXT_MESSAGE_START': The run has already finished with 'RUN_FINISHED'",
        );
        subscription.unsubscribe();
      },
    });

    // Send valid sequence then RUN_FINISHED
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
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);
    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test",
      runId: "test",
    } as RunFinishedEvent);

    // Send another event after RUN_FINISHED (should be rejected)
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "2",
    } as TextMessageStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the events before RUN_FINISHED were processed
    expect(events.length).toBe(4);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[3].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: RUN_ERROR is allowed after RUN_FINISHED
  it("should allow RUN_ERROR after RUN_FINISHED", async () => {
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

    // Send valid sequence ending with RUN_FINISHED followed by RUN_ERROR
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
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);
    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test",
      runId: "test",
    } as RunFinishedEvent);
    source$.next({
      type: EventType.RUN_ERROR,
      message: "Test error",
    } as RunErrorEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed including the RUN_ERROR after RUN_FINISHED
    expect(result.length).toBe(5);
    expect(result[4].type).toBe(EventType.RUN_ERROR);
  });

  // Test: RUN_ERROR can happen at any time (even as the first event)
  it("should allow RUN_ERROR at any time (even as first event)", async () => {
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

    // Send RUN_ERROR as the first event
    source$.next({
      type: EventType.RUN_ERROR,
      message: "Test error",
    } as RunErrorEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify the RUN_ERROR was accepted as first event
    expect(result.length).toBe(1);
    expect(result[0].type).toBe(EventType.RUN_ERROR);
  });

  // Test: No events should be allowed after RUN_ERROR
  it("should not allow any events after RUN_ERROR", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          "Cannot send event type 'TEXT_MESSAGE_START': The run has already errored with 'RUN_ERROR'. No further events can be sent.",
        );
        subscription.unsubscribe();
      },
    });

    // Send valid sequence then RUN_ERROR
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.RUN_ERROR,
      message: "Test error",
    } as RunErrorEvent);

    // Send another event after RUN_ERROR (should be rejected)
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the events before RUN_ERROR were processed
    expect(events.length).toBe(2);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.RUN_ERROR);
  });

  // Test: Valid sequence of events is allowed
  it("should allow a valid sequence of events", async () => {
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

    // Send a valid sequence
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
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);
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
    expect(result.length).toBe(8);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[7].type).toBe(EventType.RUN_FINISHED);
  });
});
