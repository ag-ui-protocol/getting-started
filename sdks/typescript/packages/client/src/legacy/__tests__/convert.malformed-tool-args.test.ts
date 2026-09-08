import { convertMessagesToLegacyFormat, convertToLegacyEvents } from "../convert";
import { of } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  BaseEvent,
  EventType,
  Message,
  MessagesSnapshotEvent,
  RunFinishedEvent,
} from "@ag-ui/core";
import { LegacyRunError, LegacyRuntimeProtocolEvent } from "../types";

const messagesWithMalformedToolArgs = (): Message[] => [
  {
    id: "msg-1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "broken_tool",
          // Malformed JSON as produced by a truncated / buggy server response
          arguments: '{"key": "value"',
        },
      },
    ],
  } as Message,
];

describe("convertMessagesToLegacyFormat - malformed tool call arguments (issue #2444)", () => {
  it("throws a descriptive error naming the offending tool call", () => {
    expect(() => convertMessagesToLegacyFormat(messagesWithMalformedToolArgs())).toThrow(/call-1/);
    expect(() => convertMessagesToLegacyFormat(messagesWithMalformedToolArgs())).toThrow(
      /broken_tool/,
    );
  });
});

describe("convertToLegacyEvents - malformed tool call arguments (issue #2444)", () => {
  it("surfaces a RunError on the stream instead of killing it", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: Date.now(),
        messages: messagesWithMalformedToolArgs(),
      } as MessagesSnapshotEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: Date.now(),
        threadId: "test-thread",
        runId: "test-run",
      } as RunFinishedEvent,
    ];

    const events = (await convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    const runError = events.find((event) => event.type === "RunError") as
      | LegacyRunError
      | undefined;

    expect(runError).toBeDefined();
    expect(runError!.message).toMatch(/call-1/);
    expect(runError!.message).toMatch(/broken_tool/);
  });
});
