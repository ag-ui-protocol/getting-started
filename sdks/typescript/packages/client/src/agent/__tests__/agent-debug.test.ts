import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { AbstractAgent } from "../agent";
import { DebugLogger } from "@/debug-logger";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  RunStartedEvent,
  RunFinishedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
} from "@ag-ui/core";
import { Observable, of } from "rxjs";

// Mock uuid module
vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue("mock-uuid"),
}));

// Mock utils
vi.mock("@/utils", async () => {
  const actual = await vi.importActual<typeof import("@/utils")>("@/utils");
  return {
    ...actual,
    structuredClone_: (obj: any) => {
      if (obj === undefined) return undefined;
      const jsonString = JSON.stringify(obj);
      if (jsonString === undefined || jsonString === "undefined") return undefined;
      return JSON.parse(jsonString);
    },
  };
});

class TestAgent extends AbstractAgent {
  private eventsToEmit: BaseEvent[] = [];

  setEventsToEmit(events: BaseEvent[]) {
    this.eventsToEmit = events;
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return of(...this.eventsToEmit);
  }
}

describe("Agent construction debug config", () => {
  it("debug: undefined -> debugLogger is undefined", () => {
    const agent = new TestAgent({ debug: undefined });
    expect(agent.debugLogger).toBeUndefined();
  });

  it("debug: false -> debugLogger is undefined", () => {
    const agent = new TestAgent({ debug: false });
    expect(agent.debugLogger).toBeUndefined();
  });

  it("debug: true -> debugLogger is DebugLogger instance, all config true", () => {
    const agent = new TestAgent({ debug: true });
    expect(agent.debugLogger).toBeInstanceOf(DebugLogger);
    expect(agent.debug).toEqual({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: true,
    });
  });

  it("debug: { events: true } -> debugLogger is DebugLogger instance with correct config", () => {
    const agent = new TestAgent({ debug: { events: true } });
    expect(agent.debugLogger).toBeInstanceOf(DebugLogger);
    expect(agent.debug).toEqual({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    });
  });

  it("setting debug = true after construction enables logging", () => {
    const agent = new TestAgent({ debug: false });
    expect(agent.debugLogger).toBeUndefined();

    agent.debug = true;
    expect(agent.debugLogger).toBeInstanceOf(DebugLogger);
    expect(agent.debug).toEqual({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: true,
    });
  });

  it("setting debug = false after construction disables logging", () => {
    const agent = new TestAgent({ debug: true });
    expect(agent.debugLogger).toBeInstanceOf(DebugLogger);

    agent.debug = false;
    expect(agent.debugLogger).toBeUndefined();
    expect(agent.debug).toEqual({
      enabled: false,
      events: false,
      lifecycle: false,
      verbose: false,
    });
  });
});

describe("Agent run lifecycle logging", () => {
  let debugSpy: MockInstance<typeof console.debug>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("with debug: true, logs [LIFECYCLE] Run started: with agentId and threadId", async () => {
    const agent = new TestAgent({
      agentId: "test-agent",
      threadId: "thread-1",
      debug: true,
    });
    agent.setEventsToEmit([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-1",
      } as RunFinishedEvent,
    ]);

    await agent.runAgent();

    const startedCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0] === "[LIFECYCLE] Run started:",
    );
    expect(startedCalls.length).toBe(1);
    expect(startedCalls[0][1]).toMatchObject({
      agentId: "test-agent",
      threadId: "thread-1",
    });
  });

  it("with debug: true, logs [LIFECYCLE] Run finished: with agentId and threadId", async () => {
    const agent = new TestAgent({
      agentId: "test-agent",
      threadId: "thread-1",
      debug: true,
    });
    agent.setEventsToEmit([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-1",
      } as RunFinishedEvent,
    ]);

    await agent.runAgent();

    const finishedCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0] === "[LIFECYCLE] Run finished:",
    );
    expect(finishedCalls.length).toBe(1);
    expect(finishedCalls[0][1]).toMatchObject({
      agentId: "test-agent",
      threadId: "thread-1",
    });
  });

  it("with debug: false, no lifecycle logs", async () => {
    const agent = new TestAgent({
      agentId: "test-agent",
      threadId: "thread-1",
      debug: false,
    });
    agent.setEventsToEmit([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-1",
      } as RunFinishedEvent,
    ]);

    await agent.runAgent();

    const lifecycleCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[LIFECYCLE]"),
    );
    expect(lifecycleCalls.length).toBe(0);
  });

  it("with { lifecycle: false, events: true }, no lifecycle logs but event logs present", async () => {
    const agent = new TestAgent({
      agentId: "test-agent",
      threadId: "thread-1",
      debug: { lifecycle: false, events: true },
    });
    agent.setEventsToEmit([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
      } as RunStartedEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-1",
      } as RunFinishedEvent,
    ]);

    await agent.runAgent();

    const lifecycleCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[LIFECYCLE]"),
    );
    expect(lifecycleCalls.length).toBe(0);

    // Should still have event-level logs from verify, apply, etc.
    const eventCalls = debugSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        (call[0].startsWith("[VERIFY]") || call[0].startsWith("[APPLY]")),
    );
    expect(eventCalls.length).toBeGreaterThan(0);
  });
});

describe("Agent run error logging", () => {
  let debugSpy: MockInstance<typeof console.debug>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    // Suppress console.error from the error handler
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs [LIFECYCLE] Run errored: with agentId and error message on error", async () => {
    const agent = new TestAgent({
      agentId: "test-agent",
      threadId: "thread-1",
      debug: true,
    });

    // Make the agent emit an error via run()
    const errorAgent = agent as any;
    errorAgent.run = () => {
      return new Observable((subscriber: any) => {
        subscriber.error(new Error("Something went wrong"));
      });
    };

    try {
      await agent.runAgent();
    } catch {
      // Expected
    }

    const errorCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0] === "[LIFECYCLE] Run errored:",
    );
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0][1]).toMatchObject({
      agentId: "test-agent",
      error: "Something went wrong",
    });
  });
});

describe("Agent pipeline integration", () => {
  let debugSpy: MockInstance<typeof console.debug>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("with debug: true, the full pipeline produces logs from ALL stages", async () => {
    const agent = new TestAgent({
      agentId: "test-agent",
      threadId: "thread-1",
      debug: true,
    });
    agent.setEventsToEmit([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
      } as RunStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Hello",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-1",
      } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-1",
      } as RunFinishedEvent,
    ]);

    await agent.runAgent();

    const allDebugCalls = debugSpy.mock.calls;

    // Check that we have LIFECYCLE logs
    const lifecycleCalls = allDebugCalls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[LIFECYCLE]"),
    );
    expect(lifecycleCalls.length).toBeGreaterThan(0);

    // Check that we have VERIFY logs (each event passes through verify)
    const verifyCalls = allDebugCalls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[VERIFY]"),
    );
    expect(verifyCalls.length).toBeGreaterThan(0);

    // Check that we have APPLY logs (each event passes through apply)
    const applyCalls = allDebugCalls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[APPLY]"),
    );
    expect(applyCalls.length).toBeGreaterThan(0);
  });
});
