import { AbstractAgent } from "@/agent";
import { Middleware } from "@/middleware";
import { BaseEvent, EventType, Message, RunAgentInput, TextMessageChunkEvent } from "@ag-ui/core";
import { Observable } from "rxjs";

describe("Middleware chained runNextWithState", () => {
  /**
   * A minimal agent that emits: RUN_STARTED → TEXT_MESSAGE_CHUNK → RUN_FINISHED.
   *
   * TEXT_MESSAGE_CHUNK is used so that runNextWithState's internal runNext
   * (which applies transformChunks(false)) expands it into
   * TEXT_MESSAGE_START + TEXT_MESSAGE_CONTENT + TEXT_MESSAGE_END,
   * giving defaultApplyEvents a messages.find() call to exercise.
   */
  class SimpleTextAgent extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });

        subscriber.next({
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: "message-1",
          role: "assistant",
          delta: "Hello",
        } as TextMessageChunkEvent);

        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        });

        subscriber.complete();
      });
    }
  }

  /**
   * A middleware that calls runNextWithState and captures the messages array
   * at the RUN_FINISHED event into this.captured.
   */
  class CapturingMiddleware extends Middleware {
    captured: Message[] = [];

    run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
      return this.runNextWithState(input, next).pipe((source) => {
        return new Observable<BaseEvent>((subscriber) => {
          source.subscribe({
            next: ({ event, messages }) => {
              if (event.type === EventType.RUN_FINISHED) {
                this.captured = messages;
              }
              subscriber.next(event);
            },
            complete: () => subscriber.complete(),
            error: (err) => subscriber.error(err),
          });
        });
      });
    }
  }

  const input: RunAgentInput = {
    threadId: "test-thread",
    runId: "test-run",
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
    messages: [],
  };

  it("outer middleware correctly tracks messages when chained with an inner runNextWithState middleware", async () => {
    const realAgent = new SimpleTextAgent();
    const innerMiddleware = new CapturingMiddleware();
    const outerMiddleware = new CapturingMiddleware();

    // Mirror the reduceRight chain builder in agent.ts:133-139.
    // Each wrapper delegates .messages and .state back through the chain via getters,
    // so every layer transparently resolves to the real agent's state.
    const outerWrapper = {
      run: (i: RunAgentInput) => innerMiddleware.run(i, realAgent),
      get messages() {
        return realAgent.messages;
      },
      get state() {
        return realAgent.state;
      },
    } as AbstractAgent;

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      outerMiddleware.run(input, outerWrapper).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
        error: (err) => reject(err),
      });
    });

    // inner middleware: next is a real AbstractAgent (has .messages = []) → always worked
    expect(innerMiddleware.captured).toHaveLength(1);
    expect(innerMiddleware.captured[0]).toMatchObject({ role: "assistant", content: "Hello" });

    // outer middleware: next was a plain wrapper (no .messages) → broken before fix
    // Fix: chain builder wrappers now delegate .messages and .state via getters,
    // so every wrapper transparently resolves to the real agent's state.
    expect(outerMiddleware.captured).toHaveLength(1);
    expect(outerMiddleware.captured[0]).toMatchObject({ role: "assistant", content: "Hello" });
  });
});
