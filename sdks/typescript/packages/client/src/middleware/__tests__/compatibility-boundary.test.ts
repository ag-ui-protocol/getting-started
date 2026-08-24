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
