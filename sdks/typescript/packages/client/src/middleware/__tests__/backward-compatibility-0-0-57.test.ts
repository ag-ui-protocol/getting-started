import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AbstractAgent } from "@/agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable, from, lastValueFrom, toArray } from "rxjs";
import { BackwardCompatibility_0_0_57 } from "../backward-compatibility-0-0-57";

// Mock agent that records the input it received and replays a scripted stream.
// NOTE: the maxVersion override is inert in this file — these tests drive
// `middleware.run(...)` directly and never exercise the version gate (that path
// is covered by the e2e file via runAgent). It is set only for documentation.
class MockAgent extends AbstractAgent {
  public lastInput?: RunAgentInput;
  private events: BaseEvent[];

  constructor(events: BaseEvent[] = []) {
    super({});
    this.events = events;
  }

  override get maxVersion(): string {
    return "0.0.57";
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    this.lastInput = input;
    return from(this.events);
  }
}

const createInput = (overrides: Partial<RunAgentInput> = {}): RunAgentInput => ({
  threadId: "thread-1",
  runId: "run-1",
  state: {},
  messages: [],
  tools: [],
  context: [],
  forwardedProps: {},
  ...overrides,
});

describe("BackwardCompatibility_0_0_57", () => {
  // Silence (and capture) the drop-warning so it doesn't pollute test output.
  // Also neutralize SUPPRESS_TRANSFORMATION_WARNINGS so the warn-emitting tests
  // are deterministic regardless of the ambient env (a dev/CI env may export it,
  // since the warning text itself instructs users to set it).
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let priorSuppress: string | undefined;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    priorSuppress = process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
    delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  });
  afterEach(() => {
    warnSpy.mockRestore();
    if (priorSuppress === undefined) {
      delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
    } else {
      process.env.SUPPRESS_TRANSFORMATION_WARNINGS = priorSuppress;
    }
  });

  it("keeps the drop-event string constants in sync with the EventType enum", () => {
    // The shim matches SUBAGENT_* by string literal; assert those literals still
    // equal the enum values so a future enum rename fails loudly here rather than
    // silently disabling the filter.
    expect(EventType.SUBAGENT_STARTED).toBe("SUBAGENT_STARTED");
    expect(EventType.SUBAGENT_FINISHED).toBe("SUBAGENT_FINISHED");
    expect(EventType.SUBAGENT_ERROR).toBe("SUBAGENT_ERROR");
  });

  it("strips subagentId from input messages before the agent sees them", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const agent = new MockAgent([]);
    const input = createInput({
      messages: [
        { id: "m1", role: "assistant", content: "hi", subagentId: "sub-1" } as any,
        { id: "m2", role: "user", content: "yo" } as any,
      ],
    });

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()));

    expect((agent.lastInput!.messages[0] as any).subagentId).toBeUndefined();
    expect(agent.lastInput!.messages[0].content).toBe("hi");
    expect((agent.lastInput!.messages[1] as any).subagentId).toBeUndefined();
  });

  it("drops SUBAGENT_STARTED/FINISHED/ERROR events from the output stream", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" } as any,
      { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "R" } as any,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", subagentId: "s1" } as any,
      { type: EventType.SUBAGENT_ERROR, subagentId: "s1", message: "x" } as any,
      { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as any,
      { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1" } as any,
    ];

    const result = await lastValueFrom(
      middleware.run(createInput(), new MockAgent(events)).pipe(toArray()),
    );

    expect(result.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.RUN_FINISHED,
    ]);
  });

  it("warns when dropping a SUBAGENT_* lifecycle event (suppressible)", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      { type: EventType.SUBAGENT_ERROR, subagentId: "s1", message: "boom" } as any,
    ];

    await lastValueFrom(middleware.run(createInput(), new MockAgent(events)).pipe(toArray()));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("SUBAGENT_ERROR");
  });

  it("suppresses the drop-warning when SUPPRESS_TRANSFORMATION_WARNINGS is set", async () => {
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS = "true";
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      { type: EventType.SUBAGENT_ERROR, subagentId: "s1", message: "boom" } as any,
    ];

    const result = await lastValueFrom(
      middleware.run(createInput(), new MockAgent(events)).pipe(toArray()),
    );

    expect(warnSpy).not.toHaveBeenCalled();
    // Suppressing the warning does not change the drop behavior.
    expect(result).toHaveLength(0);
  });

  it("strips subagentId from surviving events (all carriers)", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", subagentId: "s1" } as any,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "f",
        subagentId: "s1",
      } as any,
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "r1",
        role: "reasoning",
        subagentId: "s1",
      } as any,
    ];

    const result = await lastValueFrom(
      middleware.run(createInput(), new MockAgent(events)).pipe(toArray()),
    );

    for (const event of result) {
      expect((event as any).subagentId).toBeUndefined();
    }
    expect((result[0] as any).messageId).toBe("m1");
    expect((result[1] as any).toolCallId).toBe("tc1");
    expect((result[2] as any).messageId).toBe("r1");
  });

  it("strips subagentId from messages inside MESSAGES_SNAPSHOT", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "m1", role: "assistant", content: "hi", subagentId: "s1" },
          { id: "m2", role: "user", content: "yo" },
        ],
      } as any,
    ];

    const result = await lastValueFrom(
      middleware.run(createInput(), new MockAgent(events)).pipe(toArray()),
    );

    const snapshot = result[0] as any;
    expect(snapshot.messages[0].subagentId).toBeUndefined();
    expect(snapshot.messages[0].content).toBe("hi");
    expect(snapshot.messages[1].subagentId).toBeUndefined();
  });

  it("strips subagentId from messages inside a RUN_STARTED input echo", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
        input: {
          threadId: "thread-1",
          runId: "run-1",
          state: {},
          messages: [
            { id: "m1", role: "assistant", content: "hi", subagentId: "s1" },
            { id: "m2", role: "user", content: "yo" },
          ],
          tools: [],
          context: [],
          forwardedProps: {},
        },
      } as any,
    ];

    const result = await lastValueFrom(
      middleware.run(createInput(), new MockAgent(events)).pipe(toArray()),
    );

    const runStarted = result[0] as any;
    expect(runStarted.input.messages[0].subagentId).toBeUndefined();
    expect(runStarted.input.messages[0].content).toBe("hi");
    expect(runStarted.input.messages[1].subagentId).toBeUndefined();
  });

  it("leaves a subagent-free stream and input untouched", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" } as any,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as any,
      { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1" } as any,
    ];
    const agent = new MockAgent(events);
    const input = createInput({ messages: [{ id: "m0", role: "user", content: "hi" } as any] });

    const result = await lastValueFrom(middleware.run(input, agent).pipe(toArray()));

    expect(result.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.RUN_FINISHED,
    ]);
    expect(agent.lastInput!.messages[0].content).toBe("hi");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
