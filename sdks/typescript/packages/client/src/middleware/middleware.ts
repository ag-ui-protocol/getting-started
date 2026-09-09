import { AbstractAgent } from "@/agent";
import { RunAgentInput, BaseEvent, Message } from "@ag-ui/core";
import { Observable, ReplaySubject } from "rxjs";
import { concatMap } from "rxjs/operators";
import { transformChunks } from "@/chunks";
import { defaultApplyEvents } from "@/apply";
import { structuredClone_ } from "@/utils";

export type MiddlewareFunction = (
  input: RunAgentInput,
  next: AbstractAgent,
) => Observable<BaseEvent>;

export interface EventWithState {
  event: BaseEvent;
  messages: Message[];
  // DEFERRED (PNI-272): tightening this to `unknown` is a breaking change for
  // consumers of a published package, not a lint repair. Left for a deliberate
  // API decision.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
}

export abstract class Middleware {
  abstract run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent>;

  /**
   * Runs the next agent in the chain with automatic chunk transformation.
   */
  protected runNext(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return next.run(input).pipe(
      transformChunks(false), // Always transform chunks to full events
    );
  }

  /**
   * Runs the next agent and tracks state, providing current messages and state with each event.
   * The messages and state represent the state AFTER the event has been applied.
   */
  protected runNextWithState(
    input: RunAgentInput,
    next: AbstractAgent,
  ): Observable<EventWithState> {
    let currentMessages = structuredClone_(input.messages || []);
    // `=== undefined`, not truthiness: State is any JSON value, so `false`,
    // `0`, `""` and `null` are states a run legitimately starts from. Only a
    // genuinely absent state defaults to the empty object.
    let currentState = structuredClone_(input.state === undefined ? {} : input.state);

    // Use a ReplaySubject to feed events one by one
    const eventSubject = new ReplaySubject<BaseEvent>();

    // Set up defaultApplyEvents to process events
    const mutations$ = defaultApplyEvents(input, eventSubject, next, []);

    // Subscribe to track state changes.
    //
    // The `error` handler is deliberately empty, and deliberately present.
    // This reducer is a PRIVATE bookkeeping copy: its only job is to keep
    // `currentMessages`/`currentState` current for the events handed back
    // below. No event reaching it today can make it fail — a producer-sent
    // RUN_ERROR is applied like any other event, and the three sequences the
    // reducer refuses outright are the unexpanded chunks, which `runNext`
    // above has already expanded. The handler guards the shape of this
    // subscription rather than a live failure: a next-only observer would make
    // RxJS treat any future reducer failure as UNHANDLED, reported to
    // `reportUnhandledError`, which rethrows from a macrotask and takes the
    // host process down with an `uncaughtException` — from a bookkeeping copy
    // whose failure the caller neither sees nor needs. The caller's own stream
    // is a separate subscription that succeeds or fails on its own terms, and
    // there is nothing left to track once this one has ended.
    mutations$.subscribe({
      next: (mutation) => {
        if (mutation.messages !== undefined) {
          currentMessages = mutation.messages;
        }
        if (mutation.state !== undefined) {
          currentState = mutation.state;
        }
      },
      error: () => {},
    });

    return this.runNext(input, next).pipe(
      concatMap(async (event) => {
        // Feed the event to defaultApplyEvents and wait for it to process
        eventSubject.next(event);

        // Give defaultApplyEvents a chance to process
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Return event with current state
        return {
          event,
          messages: structuredClone_(currentMessages),
          state: structuredClone_(currentState),
        };
      }),
    );
  }
}

// Wrapper class to convert a function into a Middleware instance
export class FunctionMiddleware extends Middleware {
  constructor(private fn: MiddlewareFunction) {
    super();
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.fn(input, next);
  }
}
