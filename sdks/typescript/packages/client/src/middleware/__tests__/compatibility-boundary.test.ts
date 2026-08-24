import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { of, Observable } from "rxjs";
import { BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import { AbstractAgent } from "@/agent";

// The always-on inbound boundary is installed by the agent itself (innermost,
// once per run), so these tests go through runAgent: that both exercises the
// installation and proves the legacy shapes survive the enforcement stage
// that would otherwise strip them.

class MemoryAgent extends AbstractAgent {
  constructor(private events: BaseEvent[]) {
    super({});
  }
  run(_input: RunAgentInput): Observable<BaseEvent> {
    return of(...this.events);
  }
}

const run = { threadId: "t1", runId: "r1" };
const START = { type: EventType.RUN_STARTED, ...run } as BaseEvent;
const FINISH = { type: EventType.RUN_FINISHED, ...run } as BaseEvent;

async function materialise(
  events: BaseEvent[],
): Promise<{ messages: Message[]; seen: BaseEvent[] }> {
  const agent = new MemoryAgent(events);
  const seen: BaseEvent[] = [];
  agent.subscribe({
    onEvent: ({ event }) => {
      seen.push(event);
    },
  });
  await agent.runAgent({ runId: "r1" });
  return { messages: agent.messages, seen };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.mock("@/utils", async (importOriginal) => ({
    ...(await importOriginal<object>()),
  }));
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("the inbound compatibility boundary (thinking events)", () => {
  const thinkingStream: BaseEvent[] = [
    START,
    { type: "THINKING_START" } as unknown as BaseEvent,
    { type: "THINKING_TEXT_MESSAGE_START" } as unknown as BaseEvent,
    { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "pondering…" } as unknown as BaseEvent,
    { type: "THINKING_TEXT_MESSAGE_END" } as unknown as BaseEvent,
    { type: "THINKING_END" } as unknown as BaseEvent,
    FINISH,
  ];

  it("produces the same materialised messages as the reasoning equivalents", async () => {
    const legacy = await materialise(thinkingStream);

    const reasoning = await materialise([
      START,
      { type: EventType.REASONING_START, messageId: "m1" } as BaseEvent,
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "m1",
        role: "reasoning",
      } as BaseEvent,
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "pondering…",
      } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "m1" } as BaseEvent,
      { type: EventType.REASONING_END, messageId: "m1" } as BaseEvent,
      FINISH,
    ]);

    // Same shape modulo the generated ids.
    const scrub = (messages: Message[]) => messages.map((message) => ({ ...message, id: "<id>" }));
    expect(scrub(legacy.messages)).toEqual(scrub(reasoning.messages));
    expect(legacy.messages.length).toBeGreaterThan(0);
  });

  it("without the boundary, the legacy stream loses the events (it is doing the work)", async () => {
    // Bypass the agent (whose pipeline installs the boundary) and run the
    // enforcement stage directly: every THINKING event is dropped, so the
    // stream materialises nothing. The boundary is the difference.
    const { enforceEvents } = await import("@/enforce");
    const { lastValueFrom } = await import("rxjs");
    const { toArray } = await import("rxjs/operators");
    const out = await lastValueFrom(enforceEvents()(of(...thinkingStream)).pipe(toArray()));
    expect(out.map((event) => event.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });

  it("translates exactly once even when a version-gated 0045 is also installed", async () => {
    class OldIntegrationAgent extends MemoryAgent {
      override get maxVersion() {
        return "0.0.45";
      }
    }
    const agent = new OldIntegrationAgent([
      START,
      { type: "THINKING_START" } as unknown as BaseEvent,
      { type: "THINKING_END" } as unknown as BaseEvent,
      FINISH,
    ]);
    const seen: BaseEvent[] = [];
    agent.subscribe({
      onEvent: ({ event }) => {
        seen.push(event);
      },
    });
    await agent.runAgent({ runId: "r1" });
    const starts = seen.filter((event) => event.type === EventType.REASONING_START);
    expect(starts).toHaveLength(1);
    expect(seen.filter((event) => (event.type as string) === "THINKING_START")).toHaveLength(0);
  });
});

describe("the inbound compatibility boundary (legacy binary content)", () => {
  it("upgrades binary parts inside an inbound messages snapshot", async () => {
    const { seen } = await materialise([
      START,
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "u1",
            role: "user",
            content: [
              { type: "text", text: "look:" },
              { type: "binary", mimeType: "image/png", data: "aGk=" },
            ],
          },
        ],
      } as unknown as BaseEvent,
      FINISH,
    ]);
    const snapshot = seen.find(
      (event) => event.type === EventType.MESSAGES_SNAPSHOT,
    ) as unknown as {
      messages: Array<{ content: Array<{ type: string; source?: { type: string } }> }>;
    };
    expect(snapshot.messages[0].content).toEqual([
      { type: "text", text: "look:" },
      { type: "image", source: { type: "data", value: "aGk=", mimeType: "image/png" } },
    ]);
    expect(
      warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("binary input content")),
    ).toBe(true);
  });
});

describe("the inbound compatibility boundary (legacy nulls)", () => {
  it.each([
    [
      "TOOL_CALL_START.parentMessageId",
      [
        START,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc1",
          toolCallName: "f",
          parentMessageId: null,
        },
        { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
        FINISH,
      ],
      EventType.TOOL_CALL_START,
    ],
    [
      "TOOL_CALL_CHUNK.parentMessageId",
      // The chunk is expanded by transformChunks into start/args/end; the
      // null must already be gone when the expanded start is enforced.
      [
        START,
        {
          type: EventType.TOOL_CALL_CHUNK,
          toolCallId: "tc1",
          toolCallName: "f",
          delta: "{}",
          parentMessageId: null,
        },
        FINISH,
      ],
      EventType.TOOL_CALL_START,
    ],
    [
      "RUN_FINISHED.outcome",
      [START, { type: EventType.RUN_FINISHED, ...run, outcome: null }],
      EventType.RUN_FINISHED,
    ],
  ] as const)("converts %s null to absent, end to end", async (_name, events, expectType) => {
    const { seen } = await materialise(events as unknown as BaseEvent[]);
    const converted = seen.find((entry) => entry.type === expectType)!;
    expect(converted).toBeDefined();
    expect("parentMessageId" in converted ? converted.parentMessageId : undefined).not.toBe(null);
    expect("outcome" in converted ? converted.outcome : undefined).not.toBe(null);
    expect(warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("null"))).toBe(true);
  });

  it("without the boundary, each null is fatal (the tolerance lives here, not in the schema)", async () => {
    const { enforceEvents } = await import("@/enforce");
    const { lastValueFrom } = await import("rxjs");
    const { toArray } = await import("rxjs/operators");
    for (const event of [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "f",
        parentMessageId: null,
      },
      { type: EventType.TOOL_CALL_CHUNK, toolCallId: "tc1", parentMessageId: null },
      { type: EventType.RUN_FINISHED, ...run, outcome: null },
    ]) {
      await expect(
        lastValueFrom(enforceEvents()(of(event as unknown as BaseEvent)).pipe(toArray())),
      ).rejects.toThrow();
    }
  });

  it("a null VALUE under a metadata key is data and survives untouched", async () => {
    const { seen } = await materialise([
      START,
      {
        type: EventType.STEP_STARTED,
        stepName: "s",
        metadata: { finishReason: null },
      } as unknown as BaseEvent,
      { type: EventType.STEP_FINISHED, stepName: "s" } as BaseEvent,
      FINISH,
    ]);
    const step = seen.find((event) => event.type === EventType.STEP_STARTED) as {
      metadata?: Record<string, unknown>;
    };
    expect(step.metadata).toEqual({ finishReason: null });
  });
});

describe("the boundary on the connect/subscribe path", () => {
  it("translates thinking events arriving through connectAgent", async () => {
    class ConnectingAgent extends AbstractAgent {
      run(_input: RunAgentInput): Observable<BaseEvent> {
        throw new Error("not used");
      }
      protected override connect(_input: RunAgentInput): Observable<BaseEvent> {
        return of(
          START,
          { type: "THINKING_START" } as unknown as BaseEvent,
          { type: "THINKING_END" } as unknown as BaseEvent,
          FINISH,
        );
      }
    }
    const agent = new ConnectingAgent({});
    const seen: BaseEvent[] = [];
    agent.subscribe({
      onEvent: ({ event }) => {
        seen.push(event);
      },
    });
    await agent.connectAgent({ runId: "r1" });
    expect(seen.some((event) => event.type === EventType.REASONING_START)).toBe(true);
    expect(seen.some((event) => (event.type as string) === "THINKING_START")).toBe(false);
  });
});

describe("the boundary sees raw chunks (before chunk transformation)", () => {
  it("converts a null parentMessageId on a continuation chunk too", async () => {
    // Continuation chunks lose their extra fields in chunk expansion; the
    // boundary must have converted the null BEFORE that, or the deviation
    // would vanish unwarned.
    const { seen } = await materialise([
      START,
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        toolCallName: "f",
        delta: "{",
      } as unknown as BaseEvent,
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        delta: "}",
        parentMessageId: null,
      } as unknown as BaseEvent,
      FINISH,
    ]);
    expect(seen.some((event) => event.type === EventType.TOOL_CALL_START)).toBe(true);
    expect(warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("null"))).toBe(true);
  });
});
