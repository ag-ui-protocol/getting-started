/**
 * A rejected resume must be atomic and must leave the checkpoint retryable.
 *
 * Atomic: the gate rejects before anything is mutated, so the model is never
 * invoked and the run's client tools are never registered on the per-thread
 * agent. Retryable: the interrupts stay open, so a later complete and valid
 * batch still resumes the run rather than the rejection burning the checkpoint.
 *
 * Driven through the real Strands SDK: the interrupts are raised by the real
 * interrupt machinery, so what is under test is the adapter's real gate over
 * real checkpoint state.
 */

import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/core";
import {
  collect,
  errorCodes,
  finishedOf,
  interruptsOf,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  recordingTool,
  threadAgent,
} from "./helpers";

const TOOL_A = "confirm_a";
const TOOL_B = "confirm_b";
/** Registering this would prove the gate mutated state before rejecting. */
const MUST_NOT_REGISTER = [
  { name: "must_not_register", description: "d", parameters: {} },
] as never;

/** An agent parked on two open approval interrupts from one assistant turn. */
async function parkedOnTwoInterrupts() {
  const a = recordingTool(TOOL_A);
  const b = recordingTool(TOOL_B);
  const { agent, model } = realStrandsAgent(
    [
      modelTurn.toolUse(
        { toolUseId: "tu-a", name: TOOL_A, input: {} },
        { toolUseId: "tu-b", name: TOOL_B, input: {} },
      ),
      modelTurn.text("done"),
    ],
    {
      tools: [a.tool, b.tool],
      config: {
        toolBehaviors: {
          [TOOL_A]: { interruptOnCall: true },
          [TOOL_B]: { interruptOnCall: true },
        },
      },
    },
  );
  const first = await collect(
    agent,
    minimalRunInput({
      messages: [{ id: "u1", role: "user", content: "go" } as never],
    }),
  );
  const interrupts = interruptsOf(first, 2);
  // Resolve ids by tool name: position is not part of the contract, and a
  // silent reordering would otherwise swap which tool each answer applies to.
  const idFor = (toolName: string) => {
    const match = interrupts.find((i) => i.metadata?.tool_name === toolName);
    expect(match, `no open interrupt for ${toolName}`).toBeDefined();
    return match!.id;
  };
  return { agent, model, idFor, aCalls: a.calls, bCalls: b.calls };
}

/** Names of tools registered on the real per-thread agent. */
function registeredToolNames(
  agent: ReturnType<typeof realStrandsAgent>["agent"],
) {
  const registry = threadAgent(agent)!.toolRegistry as unknown as {
    list: () => { name: string }[];
  };
  return registry.list().map((t) => t.name);
}

function resumeRun(
  entries: unknown[],
  runId: string,
  options: { carryCanaryTool?: boolean } = {},
) {
  const carryCanaryTool = options.carryCanaryTool ?? true;
  return minimalRunInput({
    runId,
    messages: [{ id: "u1", role: "user", content: "go" } as never],
    // Only a run the gate is expected to reject carries the canary tool. An
    // accepted run legitimately registers it, which would contradict the
    // constant's own name. This flag selects the tool list; the rejection
    // itself is asserted by each caller.
    tools: carryCanaryTool ? MUST_NOT_REGISTER : ([] as never),
    resume: entries as never,
  });
}

describe("a rejected resume is atomic", () => {
  it("rejects an unknown interrupt id without invoking the model", async () => {
    const { agent, model, idFor } = await parkedOnTwoInterrupts();
    const callsBefore = model.calls;

    const events = await collect(
      agent,
      resumeRun(
        [
          {
            interruptId: idFor(TOOL_A),
            status: "resolved",
            payload: { approved: true },
          },
          {
            interruptId: "no-such-id",
            status: "resolved",
            payload: { approved: true },
          },
        ],
        "run-2",
      ),
    );

    expect(errorCodes(events)).toEqual(["UNKNOWN_INTERRUPT_ID"]);
    expect(model.calls, "model was invoked by a rejected resume").toBe(
      callsBefore,
    );
    expect(registeredToolNames(agent)).not.toContain("must_not_register");
  });

  it("does not register the rejected run's tools", async () => {
    const { agent, idFor } = await parkedOnTwoInterrupts();

    const events = await collect(
      agent,
      resumeRun(
        [
          {
            interruptId: idFor(TOOL_A),
            status: "resolved",
            payload: { approved: true },
          },
        ],
        "run-2",
      ),
    );

    // Pin why the run was rejected: without this the assertion below would
    // also pass for a run that failed for some unrelated reason.
    expect(errorCodes(events)).toEqual(["PARTIAL_RESUME"]);
    const registered = registeredToolNames(agent);
    // The positive half matters: not.toContain also holds against a registry
    // that was emptied, which would not be the gate behaving correctly.
    expect(registered).toEqual(expect.arrayContaining([TOOL_A, TOOL_B]));
    expect(registered).not.toContain("must_not_register");
  });

  it("rejects a partial batch without invoking the model", async () => {
    const { agent, model, idFor } = await parkedOnTwoInterrupts();
    const callsBefore = model.calls;

    const events = await collect(
      agent,
      resumeRun(
        [
          {
            interruptId: idFor(TOOL_A),
            status: "resolved",
            payload: { approved: true },
          },
        ],
        "run-2",
      ),
    );

    expect(errorCodes(events)).toEqual(["PARTIAL_RESUME"]);
    expect(model.calls).toBe(callsBefore);
  });

  it("rejects an invalid payload without running the approved tool", async () => {
    const { agent, model, idFor, aCalls, bCalls } =
      await parkedOnTwoInterrupts();
    const callsBefore = model.calls;

    const events = await collect(
      agent,
      resumeRun(
        [
          {
            interruptId: idFor(TOOL_A),
            status: "resolved",
            payload: { approved: "yes" },
          },
          {
            interruptId: idFor(TOOL_B),
            status: "resolved",
            payload: { approved: true },
          },
        ],
        "run-2",
      ),
    );

    expect(errorCodes(events)).toEqual(["INVALID_PAYLOAD"]);
    expect(model.calls).toBe(callsBefore);
    expect(registeredToolNames(agent)).not.toContain("must_not_register");
    // The valid sibling entry must not take effect just because it was valid.
    expect(aCalls).toEqual([]);
    expect(bCalls).toEqual([]);
  });

  it("blocks a new turn that ignores the open interrupts", async () => {
    const { agent, model } = await parkedOnTwoInterrupts();
    const callsBefore = model.calls;

    const events = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [
          { id: "u2", role: "user", content: "something else" } as never,
        ],
        tools: MUST_NOT_REGISTER,
      }),
    );

    expect(errorCodes(events)).toEqual(["PENDING_INTERRUPTS"]);
    expect(model.calls).toBe(callsBefore);
    const registered = registeredToolNames(agent);
    expect(registered).toEqual(expect.arrayContaining([TOOL_A, TOOL_B]));
    expect(registered).not.toContain("must_not_register");
  });
});

describe("a failed resume leaves no replayable fingerprint", () => {
  it("does not store the resume fingerprint for a run that failed", async () => {
    // Narrow on purpose. This pins the fingerprint invariant only: a resume
    // that passes validation and then fails inside the run must not leave a
    // fingerprint behind, because a stored one makes the next identical
    // request look like a replay and answer it with a bare success.
    //
    // FINDING, pinned rather than fixed: the retry is not replayed, but it
    // cannot make progress either. The failed resume already applied the
    // answers and ran both tools, so the interrupts are gone and the retry is
    // rejected with UNKNOWN_INTERRUPT_ID. A client whose resumed run dies
    // mid-flight therefore has no way to retry that batch, and the work the
    // tools did is not reflected in any completed run. Asserted as observed so
    // that making this path genuinely retryable shows up here as a failure.
    const a = recordingTool(TOOL_A);
    const b = recordingTool(TOOL_B);
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse(
          { toolUseId: "tu-a", name: TOOL_A, input: {} },
          { toolUseId: "tu-b", name: TOOL_B, input: {} },
        ),
        modelTurn.text("done"),
      ],
      {
        tools: [a.tool, b.tool],
        throwOnCall: 2,
        config: {
          toolBehaviors: {
            [TOOL_A]: { interruptOnCall: true },
            [TOOL_B]: { interruptOnCall: true },
          },
        },
      },
    );
    const first = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );
    const batch = interruptsOf(first, 2).map((i) => ({
      interruptId: i.id,
      status: "resolved",
      payload: { approved: true },
    }));

    const failed = await collect(agent, resumeRun(batch, "run-2"));
    expect(errorCodes(failed), "the resumed run did not fail").toEqual([
      "STRANDS_ERROR",
    ]);
    // The answers were applied before the failure, which is why the batch
    // cannot be replayed afterwards.
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);

    const retried = await collect(agent, resumeRun(batch, "run-3"));
    // The invariant under test: not answered with a synthetic success.
    const replayedAsSuccess =
      errorCodes(retried).length === 0 &&
      retried.some(
        (e) =>
          e.type === EventType.RUN_FINISHED &&
          (e as { outcome?: { type?: string } }).outcome?.type === "success",
      );
    expect(
      replayedAsSuccess,
      "an identical retry after a failed run was replayed as a bare success",
    ).toBe(false);
    // The observed outcome, pinned as the finding above.
    expect(errorCodes(retried)).toEqual(["UNKNOWN_INTERRUPT_ID"]);
  });
});

describe("a rejected resume stays retryable", () => {
  it("still accepts a corrected batch after an invalid payload", async () => {
    const { agent, idFor, aCalls, bCalls } = await parkedOnTwoInterrupts();

    const rejected = await collect(
      agent,
      resumeRun(
        [
          {
            interruptId: idFor(TOOL_A),
            status: "resolved",
            payload: { approved: "yes" },
          },
          {
            interruptId: idFor(TOOL_B),
            status: "resolved",
            payload: { approved: true },
          },
        ],
        "run-2",
      ),
    );
    const accepted = await collect(
      agent,
      resumeRun(
        [
          {
            interruptId: idFor(TOOL_A),
            status: "resolved",
            payload: { approved: true },
          },
          {
            interruptId: idFor(TOOL_B),
            status: "resolved",
            payload: { approved: false },
          },
        ],
        "run-3",
        { carryCanaryTool: false },
      ),
    );

    expect(errorCodes(rejected)).toEqual(["INVALID_PAYLOAD"]);
    expect(errorCodes(accepted)).toEqual([]);
    expect(
      aCalls,
      "approved tool did not run on the corrected retry",
    ).toHaveLength(1);
    expect(bCalls, "denied tool ran anyway").toEqual([]);
  });

  it("accepts a complete valid batch after a rejection", async () => {
    const { agent, idFor, aCalls, bCalls } = await parkedOnTwoInterrupts();

    const rejected = await collect(
      agent,
      resumeRun(
        [
          {
            interruptId: idFor(TOOL_A),
            status: "resolved",
            payload: { approved: true },
          },
          {
            interruptId: "no-such-id",
            status: "resolved",
            payload: { approved: true },
          },
        ],
        "run-2",
      ),
    );
    const partial = await collect(
      agent,
      resumeRun(
        [
          {
            interruptId: idFor(TOOL_A),
            status: "resolved",
            payload: { approved: true },
          },
        ],
        "run-3",
      ),
    );
    const accepted = await collect(
      agent,
      resumeRun(
        [
          {
            interruptId: idFor(TOOL_A),
            status: "resolved",
            payload: { approved: true },
          },
          {
            interruptId: idFor(TOOL_B),
            status: "resolved",
            payload: { approved: false },
          },
        ],
        "run-4",
        { carryCanaryTool: false },
      ),
    );

    expect(errorCodes(rejected)).toEqual(["UNKNOWN_INTERRUPT_ID"]);
    expect(errorCodes(partial)).toEqual(["PARTIAL_RESUME"]);
    expect(errorCodes(accepted)).toEqual([]);
    // The retry is what finally decides each tool, per its own answer.
    expect(
      aCalls,
      "approved tool did not run on the accepted retry",
    ).toHaveLength(1);
    expect(bCalls, "denied tool ran anyway").toEqual([]);
  });
});
