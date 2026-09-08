import { Subject } from "rxjs";
import { verifyEvents } from "../verify";
import {
  BaseEvent,
  EventType,
  AGUIError,
  RunStartedEvent,
  RunFinishedEvent,
  StepStartedEvent,
  StepFinishedEvent,
} from "@ag-ui/core";

describe("verifyEvents steps", () => {
  // Test: STEP_FINISHED must have matching name with STEP_STARTED
  it("should ensure step end has the same name as step start", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'STEP_FINISHED' for step "different-name" that was not started`,
        );
        subscription.unsubscribe();
      },
    });

    // Send valid sequence with a step start
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "test-step",
    } as StepStartedEvent);

    // Send step end with different name
    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "different-name",
    } as StepFinishedEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.STEP_STARTED);
  });

  // Test: Cannot end a step that wasn't started
  it("should not allow ending a step that wasn't started", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'STEP_FINISHED' for step "test-step" that was not started`,
        );
        subscription.unsubscribe();
      },
    });

    // Send valid sequence without a step start
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Send step end without a start
    source$.next({
      type: EventType.STEP_FINISHED,
      stepName: "test-step",
    } as StepFinishedEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: Cannot start a step with a name that's already active
  it("should not allow starting a step with a name that's already active", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(`Step "test-step" is already active for 'STEP_STARTED'`);
        subscription.unsubscribe();
      },
    });

    // Send valid sequence with a step start
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "test-step",
    } as StepStartedEvent);

    // Send another step start with the same name
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "test-step",
    } as StepStartedEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.STEP_STARTED);
  });

  // Test: All steps must be ended before RUN_FINISHED
  it("should require all steps to be ended before run ends", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(`Cannot send 'RUN_FINISHED' while steps are still active`);
        subscription.unsubscribe();
      },
    });

    // Send valid sequence with multiple steps
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
      type: EventType.STEP_FINISHED,
      stepName: "step1",
    } as StepFinishedEvent);
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "step2",
    } as StepStartedEvent);
    // Intentionally not finishing step2

    // Try to end the run with active steps
    source$.next({ type: EventType.RUN_FINISHED } as RunFinishedEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(4);
    expect(events[3].type).toBe(EventType.STEP_STARTED);
  });

  // Test: Valid sequence with properly nested steps
  it("should allow properly nested steps", async () => {
    const source$ = new Subject<BaseEvent>();

    // Set up subscription and collect events
    const events: BaseEvent[] = [];
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect.fail(`Should not have errored: ${err.message}`);
      },
    });

    // Send a valid sequence with nested steps
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
      type: EventType.STEP_FINISHED,
      stepName: "step1",
    } as StepFinishedEvent);

    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunFinishedEvent);

    // Complete the source and wait for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));
    subscription.unsubscribe();

    // Verify events were processed correctly
    expect(events.length).toBe(4);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.STEP_STARTED);
    expect(events[2].type).toBe(EventType.STEP_FINISHED);
    expect(events[3].type).toBe(EventType.RUN_FINISHED);
  });
});
