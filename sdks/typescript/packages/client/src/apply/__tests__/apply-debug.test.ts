import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { Subject, firstValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  BaseEvent,
  EventType,
  Message,
  RunStartedEvent,
  TextMessageStartEvent,
  TextMessageEndEvent,
  RunFinishedEvent,
  RunAgentInput,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";
import { createDebugLogger } from "@/debug-logger";
import { AgentSubscriber } from "@/agent/subscriber";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

const createInput = (): RunAgentInput => ({
  messages: [],
  state: {},
  threadId: "test-thread",
  runId: "test-run",
  tools: [],
  context: [],
});

describe("defaultApplyEvents debug logging", () => {
  let debugSpy: MockInstance<typeof console.debug>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no debug logs when logger is undefined", async () => {
    const events$ = new Subject<BaseEvent>();
    const input = createInput();
    const agent = createAgent();
    const result$ = defaultApplyEvents(input, events$, agent, [], undefined);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
    } as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);
    events$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test-thread",
      runId: "test-run",
    } as RunFinishedEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();
    await stateUpdatesPromise;

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("event applied log: [APPLY] Event applied: with type and subscriber count (summary mode)", async () => {
    const logger = createDebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    })!;

    const events$ = new Subject<BaseEvent>();
    const input = createInput();
    const agent = createAgent();
    const subscribers: AgentSubscriber[] = [{}]; // One empty subscriber
    const result$ = defaultApplyEvents(input, events$, agent, subscribers, logger);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
    } as TextMessageStartEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();
    await stateUpdatesPromise;

    const appliedCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0] === "[APPLY] Event applied:",
    );

    // Both events should be "applied"
    expect(appliedCalls.length).toBe(2);
    expect(appliedCalls[0][1]).toEqual({
      type: EventType.RUN_STARTED,
      subscribers: 1,
    });
    expect(appliedCalls[1][1]).toEqual({
      type: EventType.TEXT_MESSAGE_START,
      subscribers: 1,
    });
  });

  it("event applied log with verbose: full JSON payload", async () => {
    const logger = createDebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: true,
    })!;

    const events$ = new Subject<BaseEvent>();
    const input = createInput();
    const agent = createAgent();
    const result$ = defaultApplyEvents(input, events$, agent, [], logger);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();
    await stateUpdatesPromise;

    const appliedCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0] === "[APPLY] Event applied:",
    );

    expect(appliedCalls.length).toBe(1);
    // In verbose mode, should be JSON string
    expect(typeof appliedCalls[0][1]).toBe("string");
    const parsed = JSON.parse(appliedCalls[0][1]);
    expect(parsed.type).toBe(EventType.RUN_STARTED);
  });

  it("event dropped log: [APPLY] Event dropped: with type and reason when subscriber calls stopPropagation", async () => {
    const logger = createDebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    })!;

    const events$ = new Subject<BaseEvent>();
    const input = createInput();
    const agent = createAgent();
    const subscribers: AgentSubscriber[] = [
      {
        onEvent: () => {
          return { stopPropagation: true };
        },
      },
    ];
    const result$ = defaultApplyEvents(input, events$, agent, subscribers, logger);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      threadId: "test",
      runId: "test",
    } as RunStartedEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();
    await stateUpdatesPromise;

    const droppedCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0] === "[APPLY] Event dropped:",
    );

    expect(droppedCalls.length).toBe(1);
    expect(droppedCalls[0][1]).toEqual({
      type: EventType.RUN_STARTED,
      reason: "stopPropagation by subscriber",
    });
  });
});
