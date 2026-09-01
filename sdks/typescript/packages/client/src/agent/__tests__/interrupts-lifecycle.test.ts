import { describe, expect, it } from "vitest";
import { of } from "rxjs";
import { AbstractAgent } from "../agent";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";

class StubAgent extends AbstractAgent {
  public received?: RunAgentInput;
  run(input: RunAgentInput) {
    this.received = input;
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent,
    );
  }
}

describe("AbstractAgent — interrupt lifecycle enforcement", () => {
  it("allows runAgent() when pendingInterrupts is empty", async () => {
    const agent = new StubAgent();
    await expect(agent.runAgent()).resolves.toBeDefined();
  });

  it("allows runAgent() when resume covers every pending interrupt", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call" },
      { id: "int-2", reason: "tool_call" },
    ];
    await expect(
      agent.runAgent({
        resume: [
          { interruptId: "int-1", status: "resolved", payload: { approved: true } },
          { interruptId: "int-2", status: "cancelled" },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it("throws AGUIError when pending interrupts exist but resume is missing", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [{ id: "int-1", reason: "tool_call" }];
    await expect(agent.runAgent()).rejects.toThrow(/pending interrupt/i);
  });

  it("throws AGUIError when resume does not cover every pending interrupt", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call" },
      { id: "int-2", reason: "tool_call" },
    ];
    await expect(
      agent.runAgent({
        resume: [{ interruptId: "int-1", status: "resolved" }],
      }),
    ).rejects.toThrow(/int-2/);
  });

  it("throws AGUIError when a pending interrupt is past expiresAt", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call", expiresAt: "2000-01-01T00:00:00Z" },
    ];
    await expect(
      agent.runAgent({ resume: [{ interruptId: "int-1", status: "resolved" }] }),
    ).rejects.toThrow(/expired/i);
  });

  it("clone() preserves pendingInterrupts", () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call" },
      { id: "int-2", reason: "confirmation" },
    ];
    const cloned = agent.clone();
    expect(cloned.pendingInterrupts).toEqual(agent.pendingInterrupts);
    // Defensive copy: mutating the clone must not leak into the original.
    cloned.pendingInterrupts.push({ id: "int-3", reason: "tool_call" });
    expect(agent.pendingInterrupts).toHaveLength(2);
  });

  it("clone() leaves pendingInterrupts as a usable empty array on a fresh agent", async () => {
    const agent = new StubAgent();
    const cloned = agent.clone();
    // Regression test: Object.create skipped class field initializers, so
    // `pendingInterrupts` could land as `undefined` and runAgent() would throw
    // `TypeError: Cannot read properties of undefined (reading 'length')`.
    expect(cloned.pendingInterrupts).toEqual([]);
    await expect(cloned.runAgent()).resolves.toBeDefined();
  });
});

  it("allows cancelling an expired interrupt so the thread can continue", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call", expiresAt: "2000-01-01T00:00:00Z" },
    ];
    await expect(
      agent.runAgent({ resume: [{ interruptId: "int-1", status: "cancelled" }] }),
    ).resolves.toBeDefined();
  });
