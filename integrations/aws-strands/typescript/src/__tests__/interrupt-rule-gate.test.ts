import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import {
  collect,
  minimalRunInput,
  parkInterrupts,
  scriptedAgent,
} from "./helpers";

/**
 * Interrupt-rule gate lives in `StrandsAgent.run()` above `_runRaw` so any
 * subclass that overrides only `_runRaw` still inherits the check and Strands
 * isn't spun up for a doomed request. These tests exercise the gate at the
 * agent layer directly (no HTTP) to pin its semantics.
 */
class NeverRanAgent extends StrandsAgent {
  public rawCalled = 0;

  constructor() {
    super({ agent: scriptedAgent(), name: "never" });
  }

  protected async *_runRaw(
    input: RunAgentInput,
  ): AsyncGenerator<BaseEvent, void, void> {
    this.rawCalled += 1;
    yield {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    };
    yield {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    };
  }
}

/**
 * Open `ids` on the thread: parked on the SDK's checkpoint, which decides what
 * is still open, with the adapter's AG-UI metadata record beside them.
 */
function setPending(agent: StrandsAgent, threadId: string, ids: string[]) {
  return parkInterrupts(
    agent,
    threadId,
    ids.map((id) => ({ id, reason: "tool_call" })),
  );
}

describe("StrandsAgent resume[] gate (interrupts.mdx rules 2-7)", () => {
  it("emits RUN_STARTED then RUN_ERROR for unknown interruptId", async () => {
    const agent = new NeverRanAgent();
    // Must set pending interrupts so the gate doesn't short-circuit with "no pending"
    setPending(agent, "t", ["real-id"]);
    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r",
        resume: [
          { interruptId: "unknown-id", status: "resolved", payload: {} },
          { interruptId: "real-id", status: "resolved", payload: {} },
        ],
      }),
    );
    expect(agent.rawCalled).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string; message: string };
    expect(err.code).toBe("UNKNOWN_INTERRUPT_ID");
    expect(err.message).toMatch(/unknown-id/);
  });

  it("echoes up to four unknown interruptIds into the error message", async () => {
    const agent = new NeverRanAgent();
    setPending(agent, "thread-1", ["valid-1"]);
    const resume = Array.from({ length: 6 }, (_, i) => ({
      interruptId: `i-${i}`,
      status: "resolved" as const,
      payload: {},
    }));
    const events = await collect(agent, minimalRunInput({ resume }));
    const err = events.find(
      (e) => e.type === EventType.RUN_ERROR,
    ) as unknown as {
      message: string;
    };
    expect(err.message).toContain("i-0");
    expect(err.message).toContain("i-3");
    // Only the first 4 are quoted; i-4 and i-5 are elided to keep the message
    // from unbounded growth.
    expect(err.message).not.toContain("i-4");
    expect(err.message).not.toContain("i-5");
  });

  it("passes empty resume[] through to _runRaw (not a resume request)", async () => {
    const agent = new NeverRanAgent();
    const events = await collect(agent, minimalRunInput({ resume: [] }));
    expect(agent.rawCalled).toBe(1);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  it("passes missing resume through to _runRaw", async () => {
    const agent = new NeverRanAgent();
    const events = await collect(agent, minimalRunInput());
    expect(agent.rawCalled).toBe(1);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  it("Rule 4: blocks non-resume run when thread has pending interrupts", async () => {
    const agent = new NeverRanAgent();
    setPending(agent, "t", ["stale-1", "stale-2"]);

    // Plain (non-resume) run on a thread with pending interrupts → RUN_ERROR
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "t", runId: "r1" }),
    );
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string };
    expect(err.code).toBe("PENDING_INTERRUPTS");
  });

  it("Rule 4: admits fresh input when the SDK holds no checkpoint", async () => {
    const agent = new NeverRanAgent();
    // A record that exists and holds nothing is what a completed resume leaves
    // behind, and what a restart restores from persisted bookkeeping whose
    // `pendingInterrupts` is `{}`. The SDK is the one that decides, and it has
    // nothing parked.
    setPending(agent, "t", []);

    // Blocking the fresh turn would strand the thread: the resume such a block
    // demands finds nothing to address.
    const refusedResume = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r1",
        resume: [{ interruptId: "gone-1", status: "resolved", payload: {} }],
      }),
    );
    expect(refusedResume.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    expect((refusedResume[1] as unknown as { code: string }).code).toBe(
      "UNKNOWN_INTERRUPT_ID",
    );

    const events = await collect(
      agent,
      minimalRunInput({ threadId: "t", runId: "r2" }),
    );
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
    expect(agent.rawCalled).toBe(1);
  });

  it("Rule 4: admits fresh input over a record the SDK has no checkpoint for", async () => {
    const agent = new NeverRanAgent();
    // Python pops its record on resume success only, so a resume that errors
    // mid-stream leaves a populated record beside an idle checkpoint. Reading
    // the record as "something is pending" strands the thread: the block tells
    // the client to resume, and the resume finds nothing open to address.
    parkInterrupts(
      agent,
      "t",
      [{ id: "gone-1", reason: "tool_call" }],
      new Map(),
    );

    const refusedResume = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r1",
        resume: [{ interruptId: "gone-1", status: "resolved", payload: {} }],
      }),
    );
    expect(refusedResume.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    expect(refusedResume[1]).toMatchObject({
      code: "UNKNOWN_INTERRUPT_ID",
      message: "No pending interrupts for this thread.",
    });

    const events = await collect(
      agent,
      minimalRunInput({ threadId: "t", runId: "r2" }),
    );
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
    expect(agent.rawCalled).toBe(1);
  });

  it("Rule 2: validates the submitted ids against the SDK, not the record", async () => {
    const agent = new NeverRanAgent();
    // The record and the checkpoint name different interrupts. Only the SDK can
    // say which question is still being asked.
    parkInterrupts(
      agent,
      "t",
      [{ id: "recorded-only", reason: "tool_call" }],
      new Map<string, unknown>([
        ["sdk-open", { id: "sdk-open", name: "need_input" }],
      ]),
    );

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r1",
        resume: [
          { interruptId: "recorded-only", status: "resolved", payload: {} },
        ],
      }),
    );

    expect(agent.rawCalled).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string; message: string };
    expect(err.code).toBe("UNKNOWN_INTERRUPT_ID");
    expect(err.message).toContain("recorded-only");
  });

  it("Rule 3: rejects partial resume that doesn't cover all interrupts", async () => {
    const agent = new NeverRanAgent();
    setPending(agent, "t", ["int-1", "int-2", "int-3"]);

    // Only address 1 of 3 pending interrupts
    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r1",
        resume: [{ interruptId: "int-1", status: "resolved", payload: { approved: true } }],
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string };
    expect(err.code).toBe("PARTIAL_RESUME");
  });

  it("Rule 5: idempotent replay returns success without re-executing", async () => {
    const agent = new NeverRanAgent();
    setPending(agent, "t", ["live-1"]);

    // First resume — passes gate, goes to _runRaw
    await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r1",
        resume: [{ interruptId: "live-1", status: "resolved", payload: { approved: true } }],
      }),
    );
    expect(agent.rawCalled).toBe(1);

    // Replay same resume — no pending interrupts, but fingerprint matches → success
    const replay = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r2",
        resume: [{ interruptId: "live-1", status: "resolved", payload: { approved: true } }],
      }),
    );
    expect(agent.rawCalled).toBe(1); // NOT called again
    expect(replay.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  it("Rule 5: recognizes a replay when resume entries arrive in a different order", async () => {
    const agent = new NeverRanAgent();
    setPending(agent, "t", ["live-1", "live-2"]);

    const firstResume = [
      { interruptId: "live-1", status: "resolved" as const, payload: { approved: true } },
      { interruptId: "live-2", status: "cancelled" as const },
    ];
    await collect(
      agent,
      minimalRunInput({ threadId: "t", runId: "r1", resume: firstResume }),
    );
    expect(agent.rawCalled).toBe(1);

    const replay = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r2",
        resume: [...firstResume].reverse(),
      }),
    );

    expect(agent.rawCalled).toBe(1);
    expect(replay.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  it("Rule 7: rejects expired interrupt", async () => {
    const agent = new NeverRanAgent();
    parkInterrupts(agent, "t", [
      { id: "exp-1", reason: "tool_call", expiresAt: "2020-01-01T00:00:00Z" },
    ]);

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r1",
        resume: [{ interruptId: "exp-1", status: "resolved", payload: { approved: true } }],
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string };
    expect(err.code).toBe("INTERRUPT_EXPIRED");
  });

  it("Rule 6: rejects invalid payload missing required keys", async () => {
    const agent = new NeverRanAgent();
    parkInterrupts(agent, "t", [
      {
        id: "val-1",
        reason: "tool_call",
        responseSchema: {
          type: "object",
          properties: { approved: { type: "boolean" } },
          required: ["approved"],
        },
      },
    ]);

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r1",
        resume: [{ interruptId: "val-1", status: "resolved", payload: {} }],
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string };
    expect(err.code).toBe("INVALID_PAYLOAD");
  });

  it("Rule 6: rejects a non-boolean approval value", async () => {
    for (const invalidApproval of ["true", 1, null]) {
      const agent = new NeverRanAgent();
      const pending = setPending(agent, "t", ["val-1"]);
      pending.get("val-1")!.responseSchema = {
        type: "object",
        properties: { approved: { type: "boolean" } },
        required: ["approved"],
      };

      const events = await collect(
        agent,
        minimalRunInput({
          threadId: "t",
          runId: "r1",
          resume: [{ interruptId: "val-1", status: "resolved", payload: { approved: invalidApproval } }],
        }),
      );

      expect(agent.rawCalled).toBe(0);
      const err = events[1] as unknown as { code: string; message: string };
      expect(err.code).toBe("INVALID_PAYLOAD");
      expect(err.message).toContain("approved");
    }
  });

  it("Rule 6: validates a tool approval whose record lost its schema", async () => {
    const agent = new NeverRanAgent();
    // A restart can restore the checkpoint while the AG-UI record comes back
    // without the response schema it advertised. A tool approval's contract is
    // fixed, so the SDK's own interrupt still supplies it, and a payload waved
    // through here would be recorded as "no answer" and re-raise forever.
    parkInterrupts(
      agent,
      "t",
      [{ id: "appr-1", reason: "tool_call" }],
      new Map<string, unknown>([
        [
          "appr-1",
          {
            id: "appr-1",
            name: "ag_ui:tool_call:deploy",
            reason: {
              tool_call: true,
              tool_name: "deploy",
              tool_input: {},
              tool_use_id: "tc-1",
            },
          },
        ],
      ]),
    );

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r1",
        resume: [{ interruptId: "appr-1", status: "resolved", payload: {} }],
      }),
    );

    expect(agent.rawCalled).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string; message: string };
    expect(err.code).toBe("INVALID_PAYLOAD");
    expect(err.message).toContain("approved");
  });

  it("Rule 6: accepts explicit denial and optional approve-with-edits fields", async () => {
    const schema = {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        editedArgs: { type: "object" },
      },
      required: ["approved"],
    };

    const denied = new NeverRanAgent();
    const deniedPending = setPending(denied, "denied", ["val-1"]);
    deniedPending.get("val-1")!.responseSchema = schema;
    const deniedEvents = await collect(
      denied,
      minimalRunInput({
        threadId: "denied",
        resume: [{ interruptId: "val-1", status: "resolved", payload: { approved: false } }],
      }),
    );
    expect(denied.rawCalled).toBe(1);
    expect(deniedEvents.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);

    const edited = new NeverRanAgent();
    const editedPending = setPending(edited, "edited", ["val-2"]);
    editedPending.get("val-2")!.responseSchema = schema;
    const editedEvents = await collect(
      edited,
      minimalRunInput({
        threadId: "edited",
        resume: [
          {
            interruptId: "val-2",
            status: "resolved",
            payload: { approved: true, editedArgs: { environment: "staging" } },
          },
        ],
      }),
    );
    expect(edited.rawCalled).toBe(1);
    expect(editedEvents.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
  });
});
