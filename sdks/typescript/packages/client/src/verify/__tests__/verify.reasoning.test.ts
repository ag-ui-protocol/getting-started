/**
 * Open/close discipline on reasoning spans and reasoning messages.
 *
 * The verifier held this for text messages and tool calls but not for
 * reasoning: the set it maintained for reasoning ids was written and cleared
 * and never once read, so a content event with no opener, a message never
 * closed, and a span closed without ever being opened all passed.
 *
 * Spans and messages are separate namespaces — the specification says a span's
 * identifier "namespaces nothing" and the messages inside carry their own ids —
 * so they are bracketed independently, and one id may legitimately name both.
 */
import { from, firstValueFrom, lastValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import { verifyEvents } from "../verify";
import {
  BaseEvent,
  EventType,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/core";

const RUN_STARTED = {
  type: EventType.RUN_STARTED,
  threadId: "t",
  runId: "r",
} as RunStartedEvent;
const RUN_FINISHED = {
  type: EventType.RUN_FINISHED,
  threadId: "t",
  runId: "r",
} as RunFinishedEvent;

const accept = (events: BaseEvent[]) =>
  firstValueFrom(verifyEvents(false)(from(events)).pipe(toArray()));

const reject = (events: BaseEvent[], message: RegExp) =>
  expect(lastValueFrom(verifyEvents(false)(from(events)))).rejects.toThrow(message);

describe("reasoning message bracketing", () => {
  it("accepts a well-formed span around a well-formed message", async () => {
    const events: BaseEvent[] = [
      RUN_STARTED,
      { type: EventType.REASONING_START, messageId: "span-1" } as BaseEvent,
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "msg-1",
        role: "reasoning",
      } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "msg-1", delta: "x" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "msg-1" } as BaseEvent,
      { type: EventType.REASONING_END, messageId: "span-1" } as BaseEvent,
      RUN_FINISHED,
    ];
    expect(await accept(events)).toHaveLength(events.length);
  });

  it("accepts a span and its message sharing one id", async () => {
    // The span's id namespaces nothing, so reusing it for the message inside
    // is legal — and is what several integrations do.
    const events: BaseEvent[] = [
      RUN_STARTED,
      { type: EventType.REASONING_START, messageId: "r1" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1" } as BaseEvent,
      { type: EventType.REASONING_END, messageId: "r1" } as BaseEvent,
      RUN_FINISHED,
    ];
    expect(await accept(events)).toHaveLength(events.length);
  });

  it("rejects REASONING_MESSAGE_CONTENT with no opener", async () => {
    await reject(
      [
        RUN_STARTED,
        { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "msg-1", delta: "x" } as BaseEvent,
      ],
      /No active reasoning message found with ID 'msg-1'/,
    );
  });

  it("rejects REASONING_MESSAGE_END with no opener", async () => {
    await reject(
      [RUN_STARTED, { type: EventType.REASONING_MESSAGE_END, messageId: "msg-1" } as BaseEvent],
      /No active reasoning message found with ID 'msg-1'/,
    );
  });

  it("rejects REASONING_MESSAGE_CONTENT after the message closed", async () => {
    await reject(
      [
        RUN_STARTED,
        { type: EventType.REASONING_MESSAGE_START, messageId: "msg-1", role: "reasoning" } as BaseEvent,
        { type: EventType.REASONING_MESSAGE_END, messageId: "msg-1" } as BaseEvent,
        { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "msg-1", delta: "x" } as BaseEvent,
      ],
      /No active reasoning message found with ID 'msg-1'/,
    );
  });

  it("rejects re-opening a reasoning message that is already open", async () => {
    await reject(
      [
        RUN_STARTED,
        { type: EventType.REASONING_MESSAGE_START, messageId: "msg-1", role: "reasoning" } as BaseEvent,
        { type: EventType.REASONING_MESSAGE_START, messageId: "msg-1", role: "reasoning" } as BaseEvent,
      ],
      /A reasoning message with ID 'msg-1' is already in progress/,
    );
  });

  it("allows re-opening a reasoning message that was closed", async () => {
    const events: BaseEvent[] = [
      RUN_STARTED,
      { type: EventType.REASONING_MESSAGE_START, messageId: "msg-1", role: "reasoning" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "msg-1" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_START, messageId: "msg-1", role: "reasoning" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "msg-1" } as BaseEvent,
      RUN_FINISHED,
    ];
    expect(await accept(events)).toHaveLength(events.length);
  });
});

describe("reasoning span bracketing", () => {
  it("rejects re-opening a span that is already open", async () => {
    await reject(
      [
        RUN_STARTED,
        { type: EventType.REASONING_START, messageId: "span-1" } as BaseEvent,
        { type: EventType.REASONING_START, messageId: "span-1" } as BaseEvent,
      ],
      /A reasoning span with ID 'span-1' is already in progress/,
    );
  });

  it("rejects closing a span nobody opened", async () => {
    await reject(
      [RUN_STARTED, { type: EventType.REASONING_END, messageId: "span-1" } as BaseEvent],
      /No active reasoning span found with ID 'span-1'/,
    );
  });
});

describe("RUN_FINISHED while reasoning is still open", () => {
  it("rejects an unclosed reasoning message", async () => {
    await reject(
      [
        RUN_STARTED,
        { type: EventType.REASONING_MESSAGE_START, messageId: "msg-1", role: "reasoning" } as BaseEvent,
        RUN_FINISHED,
      ],
      /while reasoning messages are still active: msg-1/,
    );
  });

  it("rejects an unclosed reasoning span", async () => {
    await reject(
      [
        RUN_STARTED,
        { type: EventType.REASONING_START, messageId: "span-1" } as BaseEvent,
        RUN_FINISHED,
      ],
      /while reasoning spans are still active: span-1/,
    );
  });

  it("lets the next run start clean after a run that left reasoning open", async () => {
    // Bracketing state is per-run, like every other entity's.
    const events: BaseEvent[] = [
      RUN_STARTED,
      { type: EventType.REASONING_START, messageId: "span-1" } as BaseEvent,
      { type: EventType.RUN_ERROR, message: "gave up mid-thought" } as BaseEvent,
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r2" } as RunStartedEvent,
      { type: EventType.REASONING_START, messageId: "span-1" } as BaseEvent,
      { type: EventType.REASONING_END, messageId: "span-1" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r2" } as RunFinishedEvent,
    ];
    expect(await accept(events)).toHaveLength(events.length);
  });
});
