import { Observable, Subject, firstValueFrom, of } from "rxjs";
import { toArray } from "rxjs/operators";
import { describe, it, expect } from "vitest";
import { verifyEvents } from "../verify";
import { AbstractAgent } from "@/agent";
import {
  AGUIError,
  BaseEvent,
  EventType,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
} from "@ag-ui/core";

const runStarted = (): RunStartedEvent =>
  ({
    type: EventType.RUN_STARTED,
    threadId: "test-thread-id",
    runId: "test-run-id",
  }) as RunStartedEvent;

const runFinished = (): RunFinishedEvent =>
  ({
    type: EventType.RUN_FINISHED,
    threadId: "test-thread-id",
    runId: "test-run-id",
  }) as RunFinishedEvent;

const messageStart = (messageId = "msg_1"): TextMessageStartEvent =>
  ({
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
  }) as TextMessageStartEvent;

const messageContent = (
  messageId = "msg_1",
  delta = "Transferring $50,0",
): TextMessageContentEvent =>
  ({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta,
  }) as TextMessageContentEvent;

const messageEnd = (messageId = "msg_1"): TextMessageEndEvent =>
  ({
    type: EventType.TEXT_MESSAGE_END,
    messageId,
  }) as TextMessageEndEvent;

/** Run a fixed list of events through verifyEvents and resolve with the outcome. */
const verify = async (events: BaseEvent[]): Promise<{ ok: boolean; error?: any }> => {
  const source$ = new Subject<BaseEvent>();
  const promise = firstValueFrom(verifyEvents()(source$).pipe(toArray()))
    .then(() => ({ ok: true }) as const)
    .catch((error) => ({ ok: false, error }) as const);

  for (const event of events) {
    source$.next(event);
  }
  source$.complete();

  return promise;
};

class FixedEventsAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super();
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return of(...this.events);
  }
}

describe("verifyEvents unterminated runs", () => {
  // The six stream shapes from issue #2300, plus the empty stream.

  it("accepts a fully terminated run (shape 1)", async () => {
    const outcome = await verify([
      runStarted(),
      messageStart(),
      messageContent(),
      messageEnd(),
      runFinished(),
    ]);
    expect(outcome.ok).toBe(true);
  });

  it("rejects RUN_FINISHED while a text message is still open (shape 2)", async () => {
    const outcome = await verify([runStarted(), messageStart(), messageContent(), runFinished()]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(AGUIError);
    expect(outcome.error.message).toContain(
      "Cannot send 'RUN_FINISHED' while text messages are still active",
    );
  });

  it("rejects a duplicate terminator (shape 3)", async () => {
    const outcome = await verify([
      runStarted(),
      messageStart(),
      messageContent(),
      messageEnd(),
      runFinished(),
      runFinished(),
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(AGUIError);
  });

  it("rejects a stream truncated mid-message (shape 4)", async () => {
    const outcome = await verify([runStarted(), messageStart(), messageContent()]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(AGUIError);
    expect(outcome.error.message).toContain(
      "The stream ended without 'RUN_FINISHED' or 'RUN_ERROR'",
    );
  });

  it("rejects a stream that ends after a complete message but with no terminator (shape 5)", async () => {
    const outcome = await verify([runStarted(), messageStart(), messageContent(), messageEnd()]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(AGUIError);
    expect(outcome.error.message).toContain(
      "The stream ended without 'RUN_FINISHED' or 'RUN_ERROR'",
    );
  });

  it("rejects a stream containing only RUN_STARTED (shape 6)", async () => {
    const outcome = await verify([runStarted()]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(AGUIError);
    expect(outcome.error.message).toContain(
      "The stream ended without 'RUN_FINISHED' or 'RUN_ERROR'",
    );
  });

  it("rejects an empty stream with a distinct message", async () => {
    const outcome = await verify([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(AGUIError);
    expect(outcome.error.message).toContain("The stream ended without emitting 'RUN_STARTED'");
  });

  it("still accepts a run terminated by RUN_ERROR", async () => {
    const outcome = await verify([
      runStarted(),
      messageStart(),
      messageContent(),
      { type: EventType.RUN_ERROR, message: "boom" } as RunErrorEvent,
    ]);
    expect(outcome.ok).toBe(true);
  });

  it("still accepts a bare RUN_ERROR stream", async () => {
    const outcome = await verify([{ type: EventType.RUN_ERROR, message: "boom" } as RunErrorEvent]);
    expect(outcome.ok).toBe(true);
  });

  it("rejects when the last of several sequential runs is unterminated", async () => {
    const outcome = await verify([
      runStarted(),
      messageStart("msg_1"),
      messageEnd("msg_1"),
      runFinished(),
      runStarted(),
      messageStart("msg_2"),
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(AGUIError);
    expect(outcome.error.message).toContain(
      "The stream ended without 'RUN_FINISHED' or 'RUN_ERROR'",
    );
  });
});

describe("AbstractAgent surfaces an unterminated run (#2300)", () => {
  it("rejects runAgent(), fires onRunFailed, and does not commit the truncated message", async () => {
    const agent = new FixedEventsAgent([runStarted(), messageStart(), messageContent()]);

    let runFailedCalls = 0;
    let runErrorEventCalls = 0;

    await expect(
      agent.runAgent(
        {},
        {
          onRunFailed: () => {
            runFailedCalls++;
          },
          onRunErrorEvent: () => {
            runErrorEventCalls++;
          },
        },
      ),
    ).rejects.toBeInstanceOf(AGUIError);

    expect(runFailedCalls).toBe(1);
    expect(runErrorEventCalls).toBe(0);
    expect(agent.messages.some((message) => message.id === "msg_1")).toBe(false);
  });

  it("resolves normally for a correctly terminated run", async () => {
    const agent = new FixedEventsAgent([
      runStarted(),
      messageStart(),
      messageContent("msg_1", "hello"),
      messageEnd(),
      runFinished(),
    ]);

    let runFailedCalls = 0;
    const result = await agent.runAgent(
      {},
      {
        onRunFailed: () => {
          runFailedCalls++;
        },
      },
    );

    expect(runFailedCalls).toBe(0);
    expect(result.newMessages.map((m) => m.id)).toEqual(["msg_1"]);
    expect(agent.messages.some((message) => message.id === "msg_1")).toBe(true);
  });
});
