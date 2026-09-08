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

const input = (runId: string): RunAgentInput =>
  ({
    threadId: "thread-1",
    runId,
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }) as unknown as RunAgentInput;

const runStarted = (runId: string): BaseEvent =>
  ({ type: EventType.RUN_STARTED, threadId: "thread-1", runId }) as BaseEvent;

const toolCall = (id: string, name: string): BaseEvent[] => [
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: id,
    toolCallName: name,
    parentMessageId: "message-1",
  } as ToolCallStartEvent,
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: "{}" } as ToolCallArgsEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: id } as ToolCallEndEvent,
  {
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: id,
    messageId: `result-${id}`,
    content: "ok",
  } as ToolCallResultEvent,
];

/** Replays a fixed script, so one subscription can carry two runs. */
class ScriptedAgent extends AbstractAgent {
  constructor(private readonly script: BaseEvent[]) {
    super();
  }
  run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of this.script) subscriber.next(event);
      subscriber.complete();
    });
  }
}

/** Hands back a subject so a run can be left open on purpose. */
class OpenAgent extends AbstractAgent {
  constructor(private readonly subject: Subject<BaseEvent>) {
    super();
  }
  run(): Observable<BaseEvent> {
    return this.subject.asObservable();
  }
}

describe("FilterToolCallsMiddleware keeps blocked IDs per run", () => {
  /*
   * Two runs down one subscription. `run()` is called once, so anything that resets only there
   * never fires for the second run. The reused ID is the point: `banned` is blocked in run one,
   * then the same ID belongs to `allowed` in run two and its events must survive.
   */
  it("does not carry a blocked ID from one run into the next on the same stream", async () => {
    const middleware = new FilterToolCallsMiddleware({ disallowedToolCalls: ["banned"] });
    const script = [
      runStarted("run-1"),
      ...toolCall("call-1", "banned").slice(0, 3), // interrupted, no result
      runStarted("run-2"),
      ...toolCall("call-1", "allowed"),
    ];

    const events = await new Promise<BaseEvent[]>((resolve) => {
      middleware.run(input("run-1"), new ScriptedAgent(script)).pipe(toArray()).subscribe(resolve);
    });

    const secondRunStart = events.findIndex((e) => (e as any).runId === "run-2");
    const second = events.slice(secondRunStart);
    expect(second.filter((e) => e.type === EventType.TOOL_CALL_START)).toHaveLength(1);
    expect(second.filter((e) => e.type === EventType.TOOL_CALL_ARGS)).toHaveLength(1);
    expect(second.filter((e) => e.type === EventType.TOOL_CALL_END)).toHaveLength(1);
    expect(second.filter((e) => e.type === EventType.TOOL_CALL_RESULT)).toHaveLength(1);
  });

  /*
   * A stalled run that is still subscribed when the next one starts. With one set on the instance,
   * the second run's start clears it and the first run's blocked events start coming through.
   */
  it("does not let a later run clear the state protecting an earlier one", async () => {
    const middleware = new FilterToolCallsMiddleware({ disallowedToolCalls: ["banned"] });
    const stalled = new Subject<BaseEvent>();
    const blocked = toolCall("call-1", "banned");

    const seen: BaseEvent[] = [];
    const subscription = middleware
      .run(input("run-1"), new OpenAgent(stalled))
      .subscribe((event) => seen.push(event));

    stalled.next(runStarted("run-1"));
    stalled.next(blocked[0]); // blocked START

    // A second run begins and finishes while the first is still open.
    await new Promise<void>((resolve) => {
      middleware
        .run(
          input("run-2"),
          new ScriptedAgent([runStarted("run-2"), ...toolCall("call-2", "allowed")]),
        )
        .pipe(toArray())
        .subscribe(() => resolve());
    });

    // The first run's remaining blocked events must still be filtered.
    stalled.next(blocked[1]); // ARGS
    stalled.next(blocked[2]); // END
    stalled.next(blocked[3]); // RESULT

    expect(seen.filter((e) => e.type === EventType.TOOL_CALL_ARGS)).toHaveLength(0);
    expect(seen.filter((e) => e.type === EventType.TOOL_CALL_END)).toHaveLength(0);
    expect(seen.filter((e) => e.type === EventType.TOOL_CALL_RESULT)).toHaveLength(0);
    subscription.unsubscribe();
  });

  /* Two subscriptions to one returned Observable must not share a set either. */
  it("keeps two subscriptions to the same run independent", async () => {
    const middleware = new FilterToolCallsMiddleware({ disallowedToolCalls: ["banned"] });
    const stream = middleware.run(
      input("run-1"),
      new ScriptedAgent([runStarted("run-1"), ...toolCall("call-1", "banned")]),
    );

    const first = await new Promise<BaseEvent[]>((r) => stream.pipe(toArray()).subscribe(r));
    const second = await new Promise<BaseEvent[]>((r) => stream.pipe(toArray()).subscribe(r));

    for (const events of [first, second]) {
      expect(events.filter((e) => e.type === EventType.TOOL_CALL_START)).toHaveLength(0);
      expect(events.filter((e) => e.type === EventType.TOOL_CALL_RESULT)).toHaveLength(0);
    }
  });
});
