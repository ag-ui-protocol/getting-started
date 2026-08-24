import { beforeEach, expect, it, vi } from "vitest";
import { AbstractAgent } from "@/agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable, of, from } from "rxjs";
import { BackwardCompatibility_0_0_45 } from "../backward-compatibility-0-0-45";
import { describe } from "vitest";
import { lastValueFrom, toArray } from "rxjs";

// Mock uuid module
vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue("mock-uuid"),
}));

// String constants for deprecated THINKING events
const THINKING_START = "THINKING_START";
const THINKING_END = "THINKING_END";
const THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START";
const THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT";
const THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END";

class MockAgent extends AbstractAgent {
  private events: BaseEvent[];

  constructor(events: BaseEvent[]) {
    super({});
    this.events = events;
  }

  override get maxVersion(): string {
    return "0.0.45";
  }

  override run(_input: RunAgentInput): Observable<BaseEvent> {
    return from(this.events);
  }
}

describe("BackwardCompatibility_0_0_45", () => {
  let middleware: BackwardCompatibility_0_0_45;

  beforeEach(() => {
    middleware = new BackwardCompatibility_0_0_45();
    vi.clearAllMocks();
  });

  const createInput = (): RunAgentInput => ({
    threadId: "thread-1",
    runId: "run-1",
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  });

  it("transforms THINKING_START to REASONING_START with generated messageId", async () => {
    const events: BaseEvent[] = [{ type: THINKING_START as EventType, title: "Processing..." }];

    const agent = new MockAgent(events);
    const result = await lastValueFrom(middleware.run(createInput(), agent).pipe(toArray()));

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: EventType.REASONING_START,
      messageId: "mock-uuid",
    });
  });

  it("transforms THINKING_TEXT_MESSAGE_START to REASONING_MESSAGE_START", async () => {
    const events: BaseEvent[] = [{ type: THINKING_TEXT_MESSAGE_START as EventType }];

    const agent = new MockAgent(events);
    const result = await lastValueFrom(middleware.run(createInput(), agent).pipe(toArray()));

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "mock-uuid",
      // Pinned to what the schema requires; the translation used to invent
      // "assistant" here, unvalidated until enforcement moved behind
      // middleware.
      role: "reasoning",
    });
  });

  it("transforms THINKING_TEXT_MESSAGE_CONTENT to REASONING_MESSAGE_CONTENT", async () => {
    const events: BaseEvent[] = [
      { type: THINKING_TEXT_MESSAGE_START as EventType },
      { type: THINKING_TEXT_MESSAGE_CONTENT as EventType, delta: "thinking..." },
    ];

    const agent = new MockAgent(events);
    const result = await lastValueFrom(middleware.run(createInput(), agent).pipe(toArray()));

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "mock-uuid",
      delta: "thinking...",
    });
  });

  it("transforms THINKING_TEXT_MESSAGE_END to REASONING_MESSAGE_END", async () => {
    const events: BaseEvent[] = [
      { type: THINKING_TEXT_MESSAGE_START as EventType },
      { type: THINKING_TEXT_MESSAGE_END as EventType },
    ];

    const agent = new MockAgent(events);
    const result = await lastValueFrom(middleware.run(createInput(), agent).pipe(toArray()));

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "mock-uuid",
    });
  });

  it("transforms THINKING_END to REASONING_END with reasoning messageId", async () => {
    const events: BaseEvent[] = [
      { type: THINKING_START as EventType },
      { type: THINKING_END as EventType },
    ];

    const agent = new MockAgent(events);
    const result = await lastValueFrom(middleware.run(createInput(), agent).pipe(toArray()));

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe(EventType.REASONING_START);
    expect(result[1]).toEqual({
      type: EventType.REASONING_END,
      messageId: "mock-uuid",
    });
  });

  it("passes through non-THINKING events unchanged", async () => {
    const events: BaseEvent[] = [
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-1", delta: "Hello" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" },
    ];

    const agent = new MockAgent(events);
    const result = await lastValueFrom(middleware.run(createInput(), agent).pipe(toArray()));

    expect(result).toHaveLength(3);
    expect(result[0].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(result[2].type).toBe(EventType.TEXT_MESSAGE_END);
  });

  it("handles complete thinking flow transformation", async () => {
    const events: BaseEvent[] = [
      { type: THINKING_START as EventType, title: "Analyzing" },
      { type: THINKING_TEXT_MESSAGE_START as EventType },
      { type: THINKING_TEXT_MESSAGE_CONTENT as EventType, delta: "Step 1..." },
      { type: THINKING_TEXT_MESSAGE_CONTENT as EventType, delta: "Step 2..." },
      { type: THINKING_TEXT_MESSAGE_END as EventType },
      { type: THINKING_END as EventType },
    ];

    const agent = new MockAgent(events);
    const result = await lastValueFrom(middleware.run(createInput(), agent).pipe(toArray()));

    expect(result).toHaveLength(6);
    expect(result.map((e) => e.type)).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
    ]);

    // Verify all events have messageId
    result.forEach((event) => {
      expect((event as { messageId?: string }).messageId).toBe("mock-uuid");
    });
  });

  it("handles mixed THINKING and regular events", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
      { type: THINKING_START as EventType },
      { type: THINKING_TEXT_MESSAGE_START as EventType },
      { type: THINKING_TEXT_MESSAGE_CONTENT as EventType, delta: "thinking" },
      { type: THINKING_TEXT_MESSAGE_END as EventType },
      { type: THINKING_END as EventType },
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-1", delta: "Response" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" },
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
    ];

    const agent = new MockAgent(events);
    const result = await lastValueFrom(middleware.run(createInput(), agent).pipe(toArray()));

    expect(result).toHaveLength(10);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[1].type).toBe(EventType.REASONING_START);
    expect(result[6].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[9].type).toBe(EventType.RUN_FINISHED);
  });
});

describe("BackwardCompatibility_0_0_45 (browser environment)", () => {
  it("warnAboutTransformation should not throw when process is undefined", async () => {
    const originalProcess = globalThis.process;
    try {
      // Simulate a browser environment where `process` does not exist.
      // @ts-expect-error - intentionally removing process to simulate browser
      delete globalThis.process;

      const middleware = new BackwardCompatibility_0_0_45();
      const events: BaseEvent[] = [{ type: THINKING_START as EventType, title: "Processing..." }];
      const agent = new MockAgent(events);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await lastValueFrom(
        middleware
          .run(
            {
              threadId: "thread-1",
              runId: "run-1",
              messages: [],
              tools: [],
              context: [],
              forwardedProps: {},
            },
            agent,
          )
          .pipe(toArray()),
      );

      // Should have transformed the event without throwing ReferenceError
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe(EventType.REASONING_START);
      // Warning should still be logged (suppression is off since process is gone)
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    } finally {
      globalThis.process = originalProcess;
    }
  });
});

describe("BackwardCompatibility_0_0_45 (auto insertion)", () => {
  it("automatically transforms THINKING events when maxVersion <= 0.0.45", async () => {
    class LegacyThinkingAgent extends AbstractAgent {
      constructor() {
        super({});
      }

      override get maxVersion(): string {
        return "0.0.45";
      }

      override run(input: RunAgentInput): Observable<BaseEvent> {
        return of(
          {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent,
          { type: THINKING_START as EventType } as BaseEvent,
          { type: THINKING_TEXT_MESSAGE_START as EventType } as BaseEvent,
          { type: THINKING_TEXT_MESSAGE_CONTENT as EventType, delta: "test" } as BaseEvent,
          { type: THINKING_TEXT_MESSAGE_END as EventType } as BaseEvent,
          { type: THINKING_END as EventType } as BaseEvent,
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent,
        );
      }
    }

    const agent = new LegacyThinkingAgent();
    await agent.runAgent({
      runId: "run-1",
      tools: [],
      context: [],
      forwardedProps: {},
    });

    // The middleware should have transformed the events
    // We can't directly check events, but can verify the agent ran without errors
    expect(agent.isRunning).toBe(false);
  });
});
