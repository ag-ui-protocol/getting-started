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
    let currentState = structuredClone_(input.state || {});

    // Use a ReplaySubject to feed events one by one
    const eventSubject = new ReplaySubject<BaseEvent>();

    // Set up defaultApplyEvents to process events
    const mutations$ = defaultApplyEvents(input, eventSubject, next, []);

    // Subscribe to track state changes
    mutations$.subscribe((mutation) => {
      if (mutation.messages !== undefined) {
        currentMessages = mutation.messages;
      }
      if (mutation.state !== undefined) {
        currentState = mutation.state;
      }
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
