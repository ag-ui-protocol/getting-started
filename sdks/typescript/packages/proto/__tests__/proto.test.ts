import { encode, decode } from "../src/proto";
import {
  BaseEvent,
  EventType,
  StateDeltaEvent,
  ToolCallStartEvent,
  MessagesSnapshotEvent,
} from "@ag-ui/core";
import { describe, it, expect } from "vitest";
import * as protoEvents from "../src/generated/events";

describe("Proto", () => {
  it("should encode events", () => {
    const event: BaseEvent = {
      type: EventType.TOOL_CALL_START,
      timestamp: Date.now(),
      toolCallId: "call-1",
      toolCallName: "test-tool",
    };
    const encoded = encode(event);
    expect(encoded).toBeInstanceOf(Uint8Array);
  });
  it("should handle state delta events encoding", () => {
    const event: StateDeltaEvent = {
      type: EventType.STATE_DELTA,
      timestamp: Date.now(),
      delta: [{ op: "add", path: "/foo", value: "bar" }],
    };
    const encoded = encode(event);
    expect(encoded).toBeInstanceOf(Uint8Array);
  });
  // Test for round-trip encoding/decoding
  it("should correctly round-trip encode/decode an event", () => {
    const originalEvent: ToolCallStartEvent = {
      type: EventType.TOOL_CALL_START,
      toolCallId: "123",
      toolCallName: "test",
    };
    const encoded = encode(originalEvent);
    const decoded = decode(encoded);
    expect(decoded.type).toBe(originalEvent.type);
    expect(decoded.timestamp).toBe(originalEvent.timestamp);
  });
  // Test for StateDeltaEvent round-trip
  it("should correctly round-trip encode/decode a StateDeltaEvent event", () => {
    const originalEvent: StateDeltaEvent = {
      type: EventType.STATE_DELTA,
      timestamp: 1698765432123,
      delta: [
        { op: "add", path: "/foo", value: "bar" },
        { op: "remove", path: "/baz" },
      ],
    };
    const encoded = encode(originalEvent);
    const decoded = decode(encoded) as StateDeltaEvent;

    expect(decoded.type).toBe(originalEvent.type);
    expect(decoded.timestamp).toBe(originalEvent.timestamp);
    expect(decoded.delta).toHaveLength(originalEvent.delta.length);
    // Check delta operations
    expect(decoded.delta[0].op).toBe(originalEvent.delta[0].op);
    expect(decoded.delta[0].path).toBe(originalEvent.delta[0].path);
    expect((decoded.delta[0] as { value?: unknown }).value).toBe(
      (originalEvent.delta[0] as { value?: unknown }).value,
    );
    expect(decoded.delta[1].op).toBe(originalEvent.delta[1].op);
    expect(decoded.delta[1].path).toBe(originalEvent.delta[1].path);
  });
  // Test for complex values
  it("should correctly handle complex values in StateDeltaEvent events", () => {
    const complexValue = {
      nested: {
        array: [1, 2, 3],
        object: { key: "value" },
      },
      boolean: true,
      number: 42,
    };
    const originalEvent: StateDeltaEvent = {
      type: EventType.STATE_DELTA,
      timestamp: 1698765432123,
      delta: [{ op: "add", path: "/complex", value: complexValue }],
    };
    const encoded = encode(originalEvent);
    const decoded = decode(encoded) as StateDeltaEvent;
    expect((decoded.delta[0] as { value?: unknown }).value).toEqual(complexValue);
  });
  it("should correctly encode/decode a MessagesSnapshotEvent event with tool calls", () => {
    const originalEvent: MessagesSnapshotEvent = {
      type: EventType.MESSAGES_SNAPSHOT,
      timestamp: 1698765432123,
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Hello, can you help me with something?",
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "I'll help you analyze that data.",
          toolCalls: [
            {
              id: "tool-call-1",
              type: "function",
              function: {
                name: "analyze_data",
                arguments: JSON.stringify({
                  dataset: "sales_q2",
                  metrics: ["revenue", "growth"],
                }),
              },
            },
            {
              id: "tool-call-2",
              type: "function",
              function: {
                name: "generate_chart",
                arguments: JSON.stringify({
                  chartType: "bar",
                  data: "processed_data",
                }),
              },
            },
          ],
        },
      ],
    };

    const encoded = encode(originalEvent);
    const decoded = decode(encoded) as MessagesSnapshotEvent;

    // Verify basic event properties
    expect(decoded.type).toBe(originalEvent.type);
    expect(decoded.timestamp).toBe(originalEvent.timestamp);

    // Verify messages array
    expect(decoded.messages).toHaveLength(originalEvent.messages.length);

    // Verify first message (user)
    expect(decoded.messages[0].id).toBe(originalEvent.messages[0].id);
    expect(decoded.messages[0].role).toBe(originalEvent.messages[0].role);
    expect(decoded.messages[0].content).toBe(originalEvent.messages[0].content);

    // Verify second message (assistant with tool calls)
    expect(decoded.messages[1].id).toBe(originalEvent.messages[1].id);
    expect(decoded.messages[1].role).toBe(originalEvent.messages[1].role);
    expect(decoded.messages[1].content).toBe(originalEvent.messages[1].content);

    // Verify tool calls
    expect((decoded.messages[1] as any).toolCalls).toBeDefined();
    expect((decoded.messages[1] as any).toolCalls).toHaveLength(
      (originalEvent.messages[1] as any).toolCalls!.length,
    );

    // Verify first tool call
    expect((decoded.messages[1] as any).toolCalls![0].id).toBe(
      (originalEvent.messages[1] as any).toolCalls![0].id,
    );
    expect((decoded.messages[1] as any).toolCalls![0].type).toBe(
      (originalEvent.messages[1] as any).toolCalls![0].type,
    );
    expect((decoded.messages[1] as any).toolCalls![0].function.name).toBe(
      (originalEvent.messages[1] as any).toolCalls![0].function.name,
    );

    // Parse and compare JSON arguments
    const decodedArgs1 = JSON.parse((decoded.messages[1] as any).toolCalls![0].function.arguments);
    const originalArgs1 = JSON.parse(
      (originalEvent.messages[1] as any).toolCalls![0].function.arguments,
    );
    expect(decodedArgs1).toEqual(originalArgs1);

    // Verify second tool call
    expect((decoded.messages[1] as any).toolCalls![1].id).toBe(
      (originalEvent.messages[1] as any).toolCalls![1].id,
    );
    expect((decoded.messages[1] as any).toolCalls![1].function.name).toBe(
      (originalEvent.messages[1] as any).toolCalls![1].function.name,
    );

    const decodedArgs2 = JSON.parse((decoded.messages[1] as any).toolCalls![1].function.arguments);
    const originalArgs2 = JSON.parse(
      (originalEvent.messages[1] as any).toolCalls![1].function.arguments,
    );
    expect(decodedArgs2).toEqual(originalArgs2);
  });

  // Test for the "Invalid event" error case
  it("should throw an error when decoding an invalid event", () => {
    // Create an empty Event message without any oneof field set
    const emptyEvent = protoEvents.Event.create({});
    const encodedEmpty = protoEvents.Event.encode(emptyEvent).finish();

    // Attempt to decode the empty event should throw an error
    expect(() => decode(encodedEmpty)).toThrow("Invalid event");
  });
});
