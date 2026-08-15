import { convertToLegacyEvents } from "../convert";
import { of } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  BaseEvent,
  EventType,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  CustomEvent,
} from "@ag-ui/core";
import { LegacyRuntimeProtocolEvent } from "../types";

describe("convertToLegacyEvents - State Management", () => {
  it("should handle state updates from complete tool call arguments", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "user",
            tool: "update_user",
            tool_argument: "data",
          },
        ],
      } as CustomEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-1",
        toolCallName: "update_user",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-1",
        delta: '{"data": {"name": "John", "age": 30}}',
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

    expect(events).toHaveLength(5);
    expect(events[0].type).toBe("MetaEvent");
    expect(events[1].type).toBe("ActionExecutionStart");
    expect(events[2].type).toBe("ActionExecutionArgs");
    expect(events[3].type).toBe("AgentStateMessage");
    expect(events[4].type).toBe("ActionExecutionEnd");

    // Verify state update
    const stateEvent = events.find((e) => e.type === "AgentStateMessage");
    expect(stateEvent).toBeDefined();
    if (stateEvent?.type === "AgentStateMessage") {
      expect(JSON.parse(stateEvent.state)).toEqual({
        user: { name: "John", age: 30 },
      });
    }
  });

  it("should handle partial state updates from incomplete JSON", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "settings",
            tool: "update_settings",
            tool_argument: "config",
          },
        ],
      } as CustomEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-2",
        toolCallName: "update_settings",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-2",
        delta: '{"config": {"theme": "dark", "fontSize": 14',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-2",
        delta: ', "notifications": true}}',
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

    // Verify intermediate state update
    const stateEvents = events.filter((e) => e.type === "AgentStateMessage");
    expect(stateEvents).toHaveLength(2);
    if (stateEvents[0]?.type === "AgentStateMessage") {
      expect(JSON.parse(stateEvents[0].state)).toEqual({
        settings: { theme: "dark", fontSize: 14 },
      });
    }
    if (stateEvents[1]?.type === "AgentStateMessage") {
      expect(JSON.parse(stateEvents[1].state)).toEqual({
        settings: { theme: "dark", fontSize: 14, notifications: true },
      });
    }
  });

  it("should handle state updates with nested objects", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "profile",
            tool: "update_profile",
            tool_argument: "data",
          },
        ],
      } as CustomEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-3",
        toolCallName: "update_profile",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-3",
        delta:
          '{"data": {"personal": {"name": "Alice", "age": 25}, "preferences": {"theme": "light"}}}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "call-3",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    const stateEvent = events.find((e) => e.type === "AgentStateMessage");
    expect(stateEvent).toBeDefined();
    if (stateEvent?.type === "AgentStateMessage") {
      expect(JSON.parse(stateEvent.state)).toEqual({
        profile: {
          personal: { name: "Alice", age: 25 },
          preferences: { theme: "light" },
        },
      });
    }
  });

  it("should handle state updates with arrays", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "tasks",
            tool: "update_tasks",
            tool_argument: "list",
          },
        ],
      } as CustomEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-4",
        toolCallName: "update_tasks",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-4",
        delta: '{"list": {"items": ["task1", "task2", "task3"]}}',
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

    const stateEvent = events.find((e) => e.type === "AgentStateMessage");
    expect(stateEvent).toBeDefined();
    if (stateEvent?.type === "AgentStateMessage") {
      expect(JSON.parse(stateEvent.state)).toEqual({
        tasks: { items: ["task1", "task2", "task3"] },
      });
    }
  });

  it("should handle empty state updates", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "empty",
            tool: "clear_state",
            tool_argument: "data",
          },
        ],
      } as CustomEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-5",
        toolCallName: "clear_state",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-5",
        delta: '{"data": {}}',
      } as ToolCallArgsEvent,
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

    const stateEvent = events.find((e) => e.type === "AgentStateMessage");
    expect(stateEvent).toBeDefined();
    if (stateEvent?.type === "AgentStateMessage") {
      expect(JSON.parse(stateEvent.state)).toEqual({
        empty: {},
      });
    }
  });

  it("should handle invalid state updates (malformed JSON)", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "invalid",
            tool: "update_invalid",
            tool_argument: "data",
          },
        ],
      } as CustomEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-6",
        toolCallName: "update_invalid",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-6",
        delta: '{"data": {"invalid": "json"', // Incomplete JSON
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

    const stateEvent = events.find((e) => e.type === "AgentStateMessage");
    expect(stateEvent).toBeDefined();
    if (stateEvent?.type === "AgentStateMessage") {
      expect(JSON.parse(stateEvent.state)).toEqual({
        invalid: { invalid: "json" }, // The JSON is actually valid when wrapped in data object
      });
    }
  });

  it("should handle state rollback scenarios", async () => {
    const mockEvents: BaseEvent[] = [
      // First update
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "counter",
            tool: "increment",
            tool_argument: "value",
          },
        ],
      } as CustomEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-7",
        toolCallName: "increment",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-7",
        delta: '{"value": 1}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "call-7",
      } as ToolCallEndEvent,
      // Second update (rollback)
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "counter",
            tool: "decrement",
            tool_argument: "value",
          },
        ],
      } as CustomEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "call-8",
        toolCallName: "decrement",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "call-8",
        delta: '{"value": 0}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "call-8",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    const stateEvents = events.filter((e) => e.type === "AgentStateMessage");
    expect(stateEvents).toHaveLength(2);
    if (stateEvents[0]?.type === "AgentStateMessage") {
      expect(JSON.parse(stateEvents[0].state)).toEqual({
        counter: 1, // The value is directly assigned
      });
    }
    if (stateEvents[1]?.type === "AgentStateMessage") {
      expect(JSON.parse(stateEvents[1].state)).toEqual({
        counter: 0, // The value is directly assigned
      });
    }
  });
});
