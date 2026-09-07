import { describe, it, expect } from "vitest";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  BaseEvent,
  EventType,
  RunAgentInput,
  Message,
} from "@ag-ui/client";
import { A2AMiddlewareAgent } from "./index";

class StubOrchestrationAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super();
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      for (const event of this.events) {
        observer.next(event);
      }
      observer.complete();
    });
  }
}

const TOOL_CALL_ID = "call-1";
const TOOL_NAME = "send_message_to_a2a_agent";

const orchestrationEvents = (): BaseEvent[] => [
  { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as BaseEvent,
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: TOOL_CALL_ID,
    toolCallName: TOOL_NAME,
  } as BaseEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: TOOL_CALL_ID } as BaseEvent,
  { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" } as BaseEvent,
];

const assistantMessageWithArgs = (args: string): Message =>
  ({
    id: "msg-1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: TOOL_CALL_ID,
        type: "function",
        function: { name: TOOL_NAME, arguments: args },
      },
    ],
  }) as Message;

const makeInput = (): RunAgentInput =>
  ({
    threadId: "t1",
    runId: "r1",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }) as RunAgentInput;

/**
 * Collects the events emitted by the middleware, resolving on terminal
 * completion or error. Rejects if the stream neither completes nor errors,
 * which is the "hang" symptom of issue #2444.
 */
const collect = (agent: A2AMiddlewareAgent, timeoutMs = 2000) =>
  new Promise<{ events: BaseEvent[]; error?: unknown; completed: boolean }>(
    (resolve, reject) => {
      const events: BaseEvent[] = [];
      const timer = setTimeout(
        () => reject(new Error("stream neither completed nor errored (hang)")),
        timeoutMs,
      );
      agent.run(makeInput()).subscribe({
        next: (event) => events.push(event),
        error: (error) => {
          clearTimeout(timer);
          resolve({ events, error, completed: false });
        },
        complete: () => {
          clearTimeout(timer);
          resolve({ events, completed: true });
        },
      });
    },
  );

describe("A2AMiddlewareAgent error handling (issue #2444)", () => {
  it("surfaces a RUN_ERROR when the pending tool call arguments are malformed JSON", async () => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
    });
    agent.messages = [assistantMessageWithArgs('{"agentName": "some-agent"')];

    const result = await collect(agent);

    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect(runError, "expected a RUN_ERROR event on the stream").toBeDefined();
    expect((runError as any).message).toMatch(new RegExp(TOOL_CALL_ID));
  });

  // Valid JSON is not the same thing as usable arguments. `JSON.parse("null")` succeeds, so the
  // parse guard lets it through and reading a field off the result throws where nothing is
  // catching yet: inside the synchronous `.map` callback, before `Promise.all` and its
  // `.catch(failRun)` exist. The stream then hangs rather than erroring.
  it.each([
    ["null", "null"],
    ["a bare number", "42"],
    ["a string", '"just a string"'],
    ["an array", "[]"],
  ])(
    "surfaces a RUN_ERROR when the tool call arguments parse to %s",
    async (_label, args) => {
      const agent = new A2AMiddlewareAgent({
        agentUrls: [],
        orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
      });
      agent.messages = [assistantMessageWithArgs(args)];

      const result = await collect(agent);

      const runError = result.events.find(
        (e) => e.type === EventType.RUN_ERROR,
      );
      expect(
        runError,
        "expected a RUN_ERROR event on the stream",
      ).toBeDefined();
      expect((runError as any).message).toMatch(new RegExp(TOOL_CALL_ID));
    },
  );

  // An object that parses cleanly can still be unusable. Without the agentName check these reach
  // the agent lookup as `undefined`, which fails with a message naming the wrong problem.
  it.each([
    ["is absent", "{}"],
    ["is not a string", '{"agentName": 123}'],
    ["is empty", '{"agentName": ""}'],
  ])("surfaces a RUN_ERROR when agentName %s", async (_label, args) => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
    });
    agent.messages = [assistantMessageWithArgs(args)];

    const result = await collect(agent);

    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect(runError, "expected a RUN_ERROR event on the stream").toBeDefined();
    expect((runError as any).message).toMatch(/agentName/);
  });

  // The task becomes the message body and the sender takes a string. Reachable before this change
  // only because the parsed value was `any`.
  it.each([
    ["is absent", '{"agentName": "some-agent"}'],
    ["is not a string", '{"agentName": "some-agent", "task": {"a": 1}}'],
  ])("surfaces a RUN_ERROR when task %s", async (_label, args) => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
    });
    agent.messages = [assistantMessageWithArgs(args)];

    const result = await collect(agent);

    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect(runError, "expected a RUN_ERROR event on the stream").toBeDefined();
    expect((runError as any).message).toMatch(/task/);
  });

  it("surfaces a RUN_ERROR when the A2A call rejects", async () => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
    });
    agent.messages = [
      assistantMessageWithArgs(
        JSON.stringify({ agentName: "missing-agent", task: "hi" }),
      ),
    ];

    const result = await collect(agent);

    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect(runError, "expected a RUN_ERROR event on the stream").toBeDefined();
    expect((runError as any).message).toMatch(/missing-agent/);
  });
});
