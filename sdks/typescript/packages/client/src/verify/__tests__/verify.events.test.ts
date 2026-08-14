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

const defaultRunContext = { threadId: "test-thread-id", runId: "test-run-id" };
const finishedEvent: RunFinishedEvent = { type: EventType.RUN_FINISHED, ...defaultRunContext };

describe("verifyEvents general validation", () => {
  // Test: Event IDs must match their parent events (e.g. TEXT_MESSAGE_CONTENT must have same ID as TEXT_MESSAGE_START)
  it("should ensure message content has the same ID as message start", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found with ID 'different-id'. Start a text message with 'TEXT_MESSAGE_START' first.`,
        );
        subscription.unsubscribe();
      },
    });

    // Send valid sequence with a message start
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
    } as TextMessageStartEvent);

    // Send message content with different ID
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "different-id",
      delta: "test content",
    } as TextMessageContentEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // Test: Cannot end a message that wasn't started
  it("should not allow ending a message that wasn't started", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TEXT_MESSAGE_END' event: No active text message found with ID 'msg1'. A 'TEXT_MESSAGE_START' event must be sent first.`,
        );
        subscription.unsubscribe();
      },
    });

    // Send valid sequence without a message start
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Send message end without a start
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: TOOL_CALL_ARGS must have matching ID with TOOL_CALL_START
  it("should ensure tool call args has the same ID as tool call start", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TOOL_CALL_ARGS' event: No active tool call found with ID 'different-id'. Start a tool call with 'TOOL_CALL_START' first.`,
        );
        subscription.unsubscribe();
      },
    });

    // Send valid sequence with a tool call start
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

    // Send tool call args with different ID
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "different-id",
      delta: "test args",
    } as ToolCallArgsEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TOOL_CALL_START);
  });

  // Test: Cannot end a tool call that wasn't started
  it("should not allow ending a tool call that wasn't started", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TOOL_CALL_END' event: No active tool call found with ID 't1'. A 'TOOL_CALL_START' event must be sent first.`,
        );
        subscription.unsubscribe();
      },
    });

    // Send valid sequence without a tool call start
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Send tool call end without a start
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

  // Test: Properly handle CUSTOM and RAW in any context
  it("should allow CUSTOM and RAW in any context", async () => {
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

    // Send a sequence with meta and raw events at different places
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.CUSTOM,
      name: "Exit",
      value: undefined,
    } as CustomEvent);
    source$.next({
      type: EventType.RAW,
      event: {
        type: "test_rawEvent",
        content: "test",
      },
    } as RawEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);
    source$.next(finishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(6);
    expect(result[1].type).toBe(EventType.CUSTOM);
    expect(result[2].type).toBe(EventType.RAW);
  });

  // Test: Properly handle STATE_SNAPSHOT, STATE_DELTA, and MESSAGES_SNAPSHOT
  it("should allow state-related events in appropriate contexts", async () => {
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

    // Send a sequence with state events at different places
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        state: "initial",
        data: { foo: "bar" },
      },
    } as StateSnapshotEvent);
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "step1",
    } as StepStartedEvent);
    source$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ role: "user", content: "test" }],
    } as MessagesSnapshotEvent);
    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "step1",
    } as StepFinishedEvent);
    source$.next({
      type: EventType.STATE_DELTA,
      delta: [{ op: "add", path: "/result", value: "success" }],
    } as StateDeltaEvent);
    source$.next(finishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(7);
    expect(result[1].type).toBe(EventType.STATE_SNAPSHOT);
    expect(result[3].type).toBe(EventType.MESSAGES_SNAPSHOT);
    expect(result[5].type).toBe(EventType.STATE_DELTA);
  });

  // Test: Complex valid sequence with multiple message types
  it("should allow complex valid sequences with multiple message types", async () => {
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

    // Send a complex but valid sequence
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "step1",
    } as StepStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "msg1 content",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "t1 args",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
    } as ToolCallEndEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg2",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg2",
      delta: "msg2 content",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg2",
    } as TextMessageEndEvent);
    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "step1",
    } as StepFinishedEvent);
    source$.next(finishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(13);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[12].type).toBe(EventType.RUN_FINISHED);
  });
});

describe("verifyEvents events", () => {
  // Test: TEXT_MESSAGE_CONTENT requires TEXT_MESSAGE_START with matching ID
  it("should require TEXT_MESSAGE_START before TEXT_MESSAGE_CONTENT with the same ID", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found with ID 'different-id'. Start a text message with 'TEXT_MESSAGE_START' first.`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
    } as TextMessageStartEvent);

    // Try to send a message content event with a different message ID
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "different-id",
      delta: "test content",
    } as TextMessageContentEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // Test: TEXT_MESSAGE_END requires TEXT_MESSAGE_START with matching ID
  it("should require TEXT_MESSAGE_START before TEXT_MESSAGE_END with the same ID", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TEXT_MESSAGE_END' event: No active text message found with ID 'msg1'. A 'TEXT_MESSAGE_START' event must be sent first.`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run without starting a message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Try to send a message end event without a matching start
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: TOOL_CALL_ARGS requires TOOL_CALL_START with matching ID
  it("should require TOOL_CALL_START before TOOL_CALL_ARGS with the same ID", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TOOL_CALL_ARGS' event: No active tool call found with ID 'different-id'. Start a tool call with 'TOOL_CALL_START' first.`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a tool call
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

    // Try to send a tool args event with a different tool ID
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "different-id",
      delta: "test args",
    } as ToolCallArgsEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TOOL_CALL_START);
  });

  // Test: TOOL_CALL_END requires TOOL_CALL_START with matching ID
  it("should require TOOL_CALL_START before TOOL_CALL_END with the same ID", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TOOL_CALL_END' event: No active tool call found with ID 't1'. A 'TOOL_CALL_START' event must be sent first.`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run without starting a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Try to end a tool call without a matching start
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

  // Test: Special events (RAW, CUSTOM, etc.) are allowed outside of tool calls
  it("should allow special events outside of tool calls", async () => {
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

    // Send a valid sequence with special events
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Meta event
    source$.next({
      type: EventType.CUSTOM,
      name: "Exit",
      value: undefined,
    } as CustomEvent);

    // Raw event
    source$.next({
      type: EventType.RAW,
      event: {
        type: "raw_data",
        content: "test",
      },
    } as RawEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);
    source$.next(finishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(6);
    expect(result[1].type).toBe(EventType.CUSTOM);
    expect(result[2].type).toBe(EventType.RAW);
  });

  // Test: STATE_SNAPSHOT is allowed
  it("should allow STATE_SNAPSHOT events", async () => {
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

    // Send a valid sequence with a state snapshot
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        state: "test_state",
        data: { foo: "bar" },
      },
    } as StateSnapshotEvent);

    source$.next(finishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify both events were processed
    expect(result.length).toBe(3);
    expect(result[1].type).toBe(EventType.STATE_SNAPSHOT);
  });
});
