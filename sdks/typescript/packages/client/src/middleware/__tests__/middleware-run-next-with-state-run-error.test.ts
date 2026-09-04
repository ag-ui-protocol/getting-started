/**
 * `runNextWithState` must survive a stream that FAILS.
 *
 * The helper subscribes to its own private `defaultApplyEvents` reducer purely
 * to track messages and state. That subscription used to be next-only, which
 * was safe only while the reducer could not error. It can now: a producer-sent
 * RUN_ERROR ends the reducer with `throwError(runFailure(event))`. An observer
 * with no error handler makes RxJS report the failure as unhandled, which it
 * rethrows from a macrotask — an `uncaughtException` escaping a library that
 * was, on the caller's own stream, failing the run correctly at the same time.
 */
import { AbstractAgent } from "@/agent";
import { Middleware } from "@/middleware";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable, of } from "rxjs";

class FailingAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return of<BaseEvent[]>([
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent,
      { type: EventType.RUN_ERROR, message: "producer failed" } as BaseEvent,
    ]).pipe((source) => new Observable<BaseEvent>((subscriber) => {
      source.subscribe({
        next: (events) => events.forEach((event) => subscriber.next(event)),
        complete: () => subscriber.complete(),
        error: (error) => subscriber.error(error),
      });
    }));
  }
}

class StateTrackingMiddleware extends Middleware {
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.runNextWithState(input, next).pipe(
      (source) =>
        new Observable<BaseEvent>((subscriber) => {
          source.subscribe({
            next: ({ event }) => subscriber.next(event),
            complete: () => subscriber.complete(),
            error: (error) => subscriber.error(error),
          });
        }),
    );
  }
}

class MiddlewareAgent extends AbstractAgent {
  constructor() {
    super();
    this.debug = false;
    this.use(new StateTrackingMiddleware());
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new FailingAgent().run(input);
  }
}

/**
 * Runs `body` with every `uncaughtException` listener detached, so an escaping
 * error is captured here instead of failing the whole vitest worker, and
 * returns whatever escaped.
 */
async function escaping(body: () => Promise<unknown>): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const installed = process.listeners("uncaughtException");
  installed.forEach((listener) => process.off("uncaughtException", listener));
  const capture = (error: unknown) => escaped.push(error);
  process.on("uncaughtException", capture);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await body().catch(() => {});
    // RxJS reports an unhandled error from a macrotask; give it one to run in.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    errors.mockRestore();
    process.off("uncaughtException", capture);
    installed.forEach((listener) => process.on("uncaughtException", listener));
  }
  return escaped;
}

describe("runNextWithState over a producer-sent RUN_ERROR", () => {
  it("fails the run without letting the failure escape as an uncaught exception", async () => {
    const agent = new MiddlewareAgent();
    let rejection: Error | undefined;
    const escaped = await escaping(async () => {
      await agent.runAgent({ runId: "r1" }).catch((error: Error) => {
        rejection = error;
      });
    });

    expect(rejection?.message).toContain("producer failed");
    expect(escaped).toEqual([]);
  });
});
