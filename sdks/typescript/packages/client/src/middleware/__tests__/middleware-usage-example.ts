import { AbstractAgent } from "@/agent";
import {
  Middleware,
  FunctionMiddleware,
  MiddlewareFunction,
  FilterToolCallsMiddleware,
} from "@/middleware";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  TextMessageChunkEvent,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

/**
 * Example agent that emits a simple conversation flow.
 */
class ExampleAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as RunStartedEvent);

      subscriber.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "message-1",
        role: "assistant",
        delta: "Hello! Let me calculate that for you.",
      } as TextMessageChunkEvent);

      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        result: { answer: 42 },
      } as RunFinishedEvent);

      subscriber.complete();
    });
  }
}

/**
 * Example middleware that logs events as they pass through.
 */
class LoggingMiddleware extends Middleware {
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    console.log("Middleware input:", input);

    return next.run(input);
  }
}

/**
 * Example function-based middleware that modifies the result.
 */
const resultEnhancer: MiddlewareFunction = (input, next) => {
  return new Observable<BaseEvent>((subscriber) => {
    next.run(input).subscribe({
      next: (event) => {
        if (event.type === EventType.RUN_FINISHED) {
          subscriber.next({
            ...event,
            result: {
              ...(event as RunFinishedEvent).result,
              enhanced: true,
            },
          });
        } else {
          subscriber.next(event);
        }
      },
      error: (error) => subscriber.error(error),
      complete: () => subscriber.complete(),
    });
  });
};

const _input: RunAgentInput = {
  threadId: "example-thread",
  runId: "example-run",
  tools: [],
  context: [],
  forwardedProps: {},
  state: {},
  messages: [],
};

/**
 * Example usage demonstrating middleware chaining.
 */
async function runExample() {
  const agent = new ExampleAgent();

  // Function-based middleware
  agent.use(new FunctionMiddleware(resultEnhancer));

  // Class-based middleware
  agent.use(new LoggingMiddleware());

  // Built-in middleware to filter tool calls
  agent.use(new FilterToolCallsMiddleware({ disallowedToolCalls: ["calculator"] }));

  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    agent
      .runAgent(
        {},
        {
          onRunFinalized: ({ messages }) => {
            console.log("Final messages:", messages);
          },
          onRunFinishedEvent: (params) => {
            if (params.outcome === "success") {
              console.log("Run finished result:", params.result);
            } else {
              console.log("Run finished with interrupts:", params.interrupts);
            }
          },
        },
      )
      .then(({ newMessages, result }) => {
        console.log("New messages:", newMessages);
        console.log("Final result:", result);
        resolve();
      })
      .catch(reject);
  });

  return events;
}

runExample();
