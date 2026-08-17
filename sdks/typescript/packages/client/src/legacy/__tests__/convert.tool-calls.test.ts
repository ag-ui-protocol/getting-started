import { convertToLegacyEvents } from "../convert";
import { of } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  BaseEvent,
  EventType,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
} from "@ag-ui/core";
import { LegacyRuntimeProtocolEvent } from "../types";

describe("convertToLegacyEvents - Tool Call Sequences", () => {
  it("should handle basic tool call lifecycle (start → args → end)", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-1",
        toolCallName: "test_tool",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-1",
        delta: '{"key": "value"}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "call-1",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("ActionExecutionStart");
    expect(events[1].type).toBe("ActionExecutionArgs");
    expect(events[2].type).toBe("ActionExecutionEnd");
  });

  it("should handle partial/chunked tool call arguments", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-2",
        toolCallName: "test_tool",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-2",
        delta: '{"complex',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-2",
        delta: '": "object",',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-2",
        delta: '"value": 123}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "call-2",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(5);
    expect(events[0].type).toBe("ActionExecutionStart");
    expect(events[1].type).toBe("ActionExecutionArgs");
    expect(events[2].type).toBe("ActionExecutionArgs");
    expect(events[3].type).toBe("ActionExecutionArgs");
    expect(events[4].type).toBe("ActionExecutionEnd");

    // Verify the chunked arguments
    const argsEvents = events.filter((e) => e.type === "ActionExecutionArgs");
    expect(argsEvents[0].args).toBe('{"complex');
    expect(argsEvents[1].args).toBe('": "object",');
    expect(argsEvents[2].args).toBe('"value": 123}');
  });

  it("should handle multiple tool calls in sequence", async () => {
    const mockEvents: BaseEvent[] = [
      // First tool call
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-3",
        toolCallName: "first_tool",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-3",
        delta: '{"first": true}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "call-3",
      } as ToolCallEndEvent,
      // Second tool call
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-4",
        toolCallName: "second_tool",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-4",
        delta: '{"second": true}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "call-4",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(6);

    // Verify first tool call
    expect(events[0].type).toBe("ActionExecutionStart");
    expect(events[1].type).toBe("ActionExecutionArgs");
    expect(events[2].type).toBe("ActionExecutionEnd");

    // Verify second tool call
    expect(events[3].type).toBe("ActionExecutionStart");
    expect(events[4].type).toBe("ActionExecutionArgs");
    expect(events[5].type).toBe("ActionExecutionEnd");
  });

  it("should handle tool calls without arguments", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-5",
        toolCallName: "no_args_tool",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "call-5",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("ActionExecutionStart");
    expect(events[1].type).toBe("ActionExecutionEnd");
  });

  it("should handle tool calls with invalid/malformed arguments", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-6",
        toolCallName: "invalid_args_tool",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-6",
        delta: '{"invalid": "json"', // Incomplete JSON
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "call-6",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("ActionExecutionStart");
    expect(events[1].type).toBe("ActionExecutionArgs");
    if (events[1].type === "ActionExecutionArgs") {
      expect(events[1].args).toBe('{"invalid": "json"'); // Should pass through invalid JSON as-is
    }
    expect(events[2].type).toBe("ActionExecutionEnd");
  });
});
