import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AbstractAgent } from "@/agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";

// runAgent() generates ids; keep them deterministic.
vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue("mock-uuid"),
}));

// Replace structuredClone_ with a JSON round-trip, matching the convention in
// middleware-chained-integration.test.ts. The scripted messages here are plain
// JSON objects, so JSON and native structured-clone semantics are equivalent for
// this test; this only keeps the harness consistent with the sibling integration test.
vi.mock("@/utils", async () => {
  const actual = await vi.importActual<typeof import("@/utils")>("@/utils");
  return {
    ...actual,
    structuredClone_: (obj: any) => {
      if (obj === undefined) return undefined;
      const json = JSON.stringify(obj);
      return json === undefined ? undefined : JSON.parse(json);
    },
  };
});

// Raw stream a pre/post-subagent agent emits: a subagent lifecycle wrapping one
// attributed text message.
function subagentStream(input: RunAgentInput): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as any,
    { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "Researcher" } as any,
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
      subagentId: "s1",
    } as any,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hi" } as any,
    { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as any,
    { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as any,
    { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as any,
  ];
}

class BaseSubagentAgent extends AbstractAgent {
  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of subagentStream(input)) subscriber.next(event);
      subscriber.complete();
    });
  }
}

// Pre-subagent remote agent -> shim applies.
class OldSubagentAgent extends BaseSubagentAgent {
  override get maxVersion(): string {
    return "0.0.57";
  }
}

// Subagent-aware remote agent -> shim does NOT apply.
class NewSubagentAgent extends BaseSubagentAgent {
  override get maxVersion(): string {
    return "0.0.58";
  }
}

describe("BackwardCompatibility_0_0_57 end-to-end (via runAgent)", () => {
  // Silence the shim's drop-warning during the downgrade path.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("strips subagents through the full pipeline when the agent is <= 0.0.57", async () => {
    const agent = new OldSubagentAgent({ threadId: "t1" });
    const startedHook = vi.fn();
    const seenTypes: string[] = [];
    agent.subscribe({
      onSubagentStartedEvent: startedHook,
      onSubagentFinishedEvent: startedHook,
      onSubagentErrorEvent: startedHook,
      onEvent: ({ event }) => {
        seenTypes.push(event.type as string);
      },
    });

    const { newMessages } = await agent.runAgent();

    // The lifecycle events were dropped before apply/subscribers...
    expect(startedHook).not.toHaveBeenCalled();
    expect(seenTypes).not.toContain(EventType.SUBAGENT_STARTED);
    expect(seenTypes).not.toContain(EventType.SUBAGENT_FINISHED);
    // ...but the rest of the stream still flowed (guards against a vacuous pass
    // where onEvent simply never fired).
    expect(seenTypes).toContain(EventType.RUN_STARTED);
    expect(seenTypes).toContain(EventType.TEXT_MESSAGE_START);

    // The materialized message carries no attribution.
    const m1 = newMessages.find((m) => m.id === "m1");
    expect(m1).toBeDefined();
    expect(m1!.content).toBe("hi");
    expect((m1 as any).subagentId).toBeUndefined();
  });

  it("preserves subagents when the agent is > 0.0.57 (shim not applied)", async () => {
    const agent = new NewSubagentAgent({ threadId: "t1" });
    const startedHook = vi.fn();
    agent.subscribe({ onSubagentStartedEvent: startedHook });

    const { newMessages } = await agent.runAgent();

    expect(startedHook).toHaveBeenCalledTimes(1);
    const m1 = newMessages.find((m) => m.id === "m1");
    expect((m1 as any).subagentId).toBe("s1");
  });
});
