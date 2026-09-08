import { AbstractAgent } from "@/agent";
import { FilterToolCallsMiddleware } from "@/middleware/filter-tool-calls";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { Observable, Subject } from "rxjs";
import { toArray } from "rxjs/operators";

/**
 * Emits a run that starts a tool call and is then interrupted: no
 * TOOL_CALL_RESULT is ever produced for it.
 */
class InterruptedToolCallAgent extends AbstractAgent {
  constructor(
    private readonly toolCallId: string,
    private readonly toolCallName: string,
  ) {
    super();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: this.toolCallId,
        toolCallName: this.toolCallName,
        parentMessageId: "message-1",
      } as ToolCallStartEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: this.toolCallId,
        delta: "{}",
      } as ToolCallArgsEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_END,
        toolCallId: this.toolCallId,
      } as ToolCallEndEvent);
      // Interrupted: no TOOL_CALL_RESULT, no RUN_FINISHED.
      subscriber.complete();
    });
  }
}

/** Emits a complete tool call lifecycle. */
class CompleteToolCallAgent extends AbstractAgent {
  constructor(
    private readonly toolCallId: string,
    private readonly toolCallName: string,
  ) {
    super();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: this.toolCallId,
        toolCallName: this.toolCallName,
        parentMessageId: "message-1",
      } as ToolCallStartEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: this.toolCallId,
        delta: '{"a": 1}',
      } as ToolCallArgsEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_END,
        toolCallId: this.toolCallId,
      } as ToolCallEndEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tool-message-1",
        toolCallId: this.toolCallId,
        content: "ok",
      } as ToolCallResultEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

const makeInput = (runId: string): RunAgentInput => ({
  threadId: "thread-1",
  runId,
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

describe("FilterToolCallsMiddleware - run boundaries (issue #2443)", () => {
  it("does not carry blocked tool call IDs into the next run", async () => {
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["blocked_tool"],
    });
    const sharedToolCallId = "tool-call-1";

    // Run 1: blocked tool call, interrupted before TOOL_CALL_RESULT.
    await middleware
      .run(makeInput("run-1"), new InterruptedToolCallAgent(sharedToolCallId, "blocked_tool"))
      .pipe(toArray())
      .toPromise();

    // Run 2: the same tool call ID is reused by an allowed tool.
    const secondRunEvents = (await middleware
      .run(makeInput("run-2"), new CompleteToolCallAgent(sharedToolCallId, "allowed_tool"))
      .pipe(toArray())
      .toPromise()) as BaseEvent[];

    const types = secondRunEvents.map((event) => event.type);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
  });

  /*
   * Asserted through behaviour rather than through the set, because the set is no longer reachable
   * from the instance: each subscription owns one. Reusing the first run's ID after five
   * interrupted runs is what accumulation would break.
   */
  it("does not accumulate blocked tool call IDs across interrupted runs", async () => {
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["blocked_tool"],
    });

    for (let i = 0; i < 5; i++) {
      await middleware
        .run(makeInput(`run-${i}`), new InterruptedToolCallAgent(`tool-call-${i}`, "blocked_tool"))
        .pipe(toArray())
        .toPromise();
    }

    const events = (await middleware
      .run(makeInput("run-5"), new CompleteToolCallAgent("tool-call-0", "allowed_tool"))
      .pipe(toArray())
      .toPromise()) as BaseEvent[];

    const types = events.map((event) => event.type);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
  });

  /*
   * This replaces a test that asserted the opposite. It checked that starting the next run emptied
   * the set, which is the leak rather than the fix: the stalled run was still subscribed and those
   * IDs were the only thing filtering its remaining events. Per-subscription state means the next
   * run cannot reach them, so the stalled run keeps filtering. Covered end to end in
   * filter-tool-calls-per-run.test.ts; kept here as the boundary case it was filed as.
   */
  it("leaves a stalled run still filtering when the next run starts", async () => {
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["blocked_tool"],
    });

    const stalled = new Subject<BaseEvent>();
    class StalledAgent extends AbstractAgent {
      run(): Observable<BaseEvent> {
        return stalled.asObservable();
      }
    }

    const seen: BaseEvent[] = [];
    const subscription = middleware
      .run(makeInput("run-1"), new StalledAgent())
      .subscribe((event) => seen.push(event));

    stalled.next({
      type: EventType.RUN_STARTED,
      threadId: "thread-1",
      runId: "run-1",
    } as BaseEvent);
    stalled.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-call-1",
      toolCallName: "blocked_tool",
      parentMessageId: "message-1",
    } as ToolCallStartEvent);

    await middleware
      .run(makeInput("run-2"), new CompleteToolCallAgent("tool-call-2", "allowed_tool"))
      .pipe(toArray())
      .toPromise();

    stalled.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-call-1",
      delta: "{}",
    } as ToolCallArgsEvent);

    expect(seen.filter((event) => event.type === EventType.TOOL_CALL_ARGS)).toHaveLength(0);
    subscription.unsubscribe();
  });

  /*
   * Unsubscribing drops the set with the subscription, so there is nothing left to clear. Shown by
   * a later run reusing the abandoned ID for a tool that is allowed.
   */
  it("leaves nothing behind when a run is unsubscribed mid-stream", async () => {
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["blocked_tool"],
    });

    middleware
      .run(makeInput("run-1"), new InterruptedToolCallAgent("tool-call-1", "blocked_tool"))
      .subscribe()
      .unsubscribe();

    const events = (await middleware
      .run(makeInput("run-2"), new CompleteToolCallAgent("tool-call-1", "allowed_tool"))
      .pipe(toArray())
      .toPromise()) as BaseEvent[];

    expect(events.map((event) => event.type)).toContain(EventType.TOOL_CALL_RESULT);
  });
});
