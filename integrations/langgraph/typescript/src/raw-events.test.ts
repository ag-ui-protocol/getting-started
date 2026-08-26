import { EventType } from "@ag-ui/client";
import { Subscriber } from "rxjs";
import { describe, expect, it } from "vitest";

import { LangGraphAgent, ProcessedEvents } from "./agent";

function createAgent(emitRawEvents?: boolean) {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
    ...(emitRawEvents === undefined ? {} : { emitRawEvents }),
  });
  const events: ProcessedEvents[] = [];

  agent.subscriber = new Subscriber<ProcessedEvents>({
    next: (event: ProcessedEvents) => {
      events.push(event);
    },
    error: () => undefined,
    complete: () => undefined,
  });

  return { agent, events };
}

describe("LangGraphAgent emitRawEvents", () => {
  it("emits raw events and typed-event rawEvent data by default", () => {
    const { agent, events } = createAgent();
    const rawEvent = {
      type: EventType.RAW,
      event: { source: "langgraph" },
    } as const;
    const stateEvent = {
      type: EventType.STATE_SNAPSHOT,
      snapshot: { answer: 42 },
      rawEvent: { source: "langgraph" },
    } as const;

    expect(agent.dispatchEvent(rawEvent)).toBe(true);
    expect(agent.dispatchEvent(stateEvent)).toBe(true);
    expect(events).toEqual([rawEvent, stateEvent]);
  });

  it("suppresses raw events and removes rawEvent data when disabled", () => {
    const { agent, events } = createAgent(false);
    const stateEvent = {
      type: EventType.STATE_SNAPSHOT,
      snapshot: { answer: 42 },
      rawEvent: { source: "langgraph" },
    } as const;

    expect(
      agent.dispatchEvent({
        type: EventType.RAW,
        event: { source: "langgraph" },
      }),
    ).toBe(false);
    expect(agent.dispatchEvent(stateEvent)).toBe(true);
    expect(events).toEqual([
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { answer: 42 },
      },
    ]);
  });

  it("preserves metadata without mutating the source event when disabled", () => {
    const { agent, events } = createAgent(false);
    const metadata = {
      traceId: "trace-1",
      "ag-ui": { usage: { inputTokens: 3, outputTokens: 5 } },
    };
    const stateEvent = {
      type: EventType.STATE_SNAPSHOT,
      snapshot: { answer: 42 },
      rawEvent: { source: "langgraph" },
      metadata,
    } as const;

    agent.dispatchEvent(stateEvent);

    expect(events).toEqual([
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { answer: 42 },
        metadata,
      },
    ]);
    expect(stateEvent.rawEvent).toEqual({ source: "langgraph" });
  });

  it("retains disabled raw-event emission across clones", () => {
    const { agent } = createAgent(false);
    const clone = agent.clone();
    const events: ProcessedEvents[] = [];
    clone.subscriber = new Subscriber<ProcessedEvents>({
      next: (event: ProcessedEvents) => {
        events.push(event);
      },
      error: () => undefined,
      complete: () => undefined,
    });

    expect(
      clone.dispatchEvent({
        type: EventType.RAW,
        event: { source: "langgraph" },
      }),
    ).toBe(false);
    expect(events).toEqual([]);
  });
});
