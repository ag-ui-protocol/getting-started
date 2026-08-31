/**
 * `toolBehaviors[name].interruptOnCall` approval semantics, driven through the
 * real Strands SDK: a real `Agent` built by the adapter, the adapter's own
 * `BeforeToolCallEvent` hook, and the SDK's real interrupt/resume machinery.
 *
 * Approval is granted only by a strict boolean `true`. Truthy strings and
 * numbers must not coerce into approval, so a `!response.approved` regression
 * in the gate is caught here rather than shipping.
 *
 * Two blocks reach past the public surface: the hook-level one dispatches
 * through the agent's private hook registry, which is the only way to vary the
 * resume response a single run can produce, and the client-tool case reads the
 * adapter's private pending-interrupt map.
 *
 * Two independent layers reject a bad resume payload, and each is pinned
 * separately below:
 *   1. the run-level `responseSchema` check, which rejects a non-boolean
 *      `approved` before Strands is resumed at all;
 *   2. the approval hook itself, which is what actually decides whether the
 *      tool runs once Strands hands the response back.
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import {
  BeforeToolCallEvent,
  type Tool as StrandsTool,
} from "@strands-agents/sdk";

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

const TOOL = "confirm_delete";

function approvalAgent() {
  const { tool, calls } = recordingTool(TOOL);
  const { agent, model } = realStrandsAgent(
    [
      modelTurn.toolUse({
        toolUseId: "tu-1",
        name: TOOL,
        input: { target: "db" },
      }),
      modelTurn.text("done"),
    ],
    {
      tools: [tool],
      config: { toolBehaviors: { [TOOL]: { interruptOnCall: true } } },
    },
  );
  return { agent, model, tool, calls };
}

function userTurn() {
  return minimalRunInput({
    messages: [{ id: "u1", role: "user", content: "delete db" } as never],
  });
}

describe("interruptOnCall halts the tool via the real SDK", () => {
  it("suspends before the tool runs and reports the interrupt", async () => {
    const { agent, calls } = approvalAgent();
    const events = await collect(agent, userTurn());

    expect(errorCodes(events)).toEqual([]);
    expect(calls, "tool ran despite an unanswered approval interrupt").toEqual(
      [],
    );
    expect(finishedOf(events).outcome?.type).toBe("interrupt");
  });

  it("names the interrupted tool and echoes its input", async () => {
    const { agent } = approvalAgent();
    const events = await collect(agent, userTurn());
    const interrupt = interruptsOf(events)[0];
    expect(interrupt.toolCallId).toBe("tu-1");
    expect(interrupt.metadata?.tool_name).toBe(TOOL);
    expect(interrupt.metadata?.tool_input).toEqual({ target: "db" });
  });
});

describe("resuming an approval interrupt", () => {
  async function resumeWith(payload: unknown) {
    const { agent, model, calls } = approvalAgent();
    const first = await collect(agent, userTurn());
    const id = interruptsOf(first)[0].id;
    const callsBeforeResume = model.calls;
    const second = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "delete db" } as never],
        resume: [{ interruptId: id, status: "resolved", payload }] as never,
      }),
    );
    return { second, calls, model, callsBeforeResume };
  }

  it("runs the tool for approved: true", async () => {
    const { second, calls } = await resumeWith({ approved: true });
    expect(errorCodes(second)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("does not run the tool for approved: false", async () => {
    const { second, calls, model, callsBeforeResume } = await resumeWith({
      approved: false,
    });
    expect(errorCodes(second)).toEqual([]);
    expect(calls, "denied tool executed anyway").toEqual([]);
    // Without this the test also passes when the resume never reached Strands
    // at all, which is a different outcome that happens to look the same.
    expect(model.calls, "Strands was never resumed").toBeGreaterThan(
      callsBeforeResume,
    );
  });

  it("rejects a string approved before Strands is resumed", async () => {
    const { second, calls, model, callsBeforeResume } = await resumeWith({
      approved: "true",
    });
    expect(errorCodes(second)).toEqual(["INVALID_PAYLOAD"]);
    expect(calls, "truthy string approved the call").toEqual([]);
    expect(model.calls, "Strands was resumed despite a rejected payload").toBe(
      callsBeforeResume,
    );
  });

  it("rejects a numeric approved before Strands is resumed", async () => {
    const { second, calls, model, callsBeforeResume } = await resumeWith({
      approved: 1,
    });
    expect(errorCodes(second)).toEqual(["INVALID_PAYLOAD"]);
    expect(calls, "truthy number approved the call").toEqual([]);
    expect(model.calls, "Strands was resumed despite a rejected payload").toBe(
      callsBeforeResume,
    );
  });

  it("rejects a payload missing approved entirely", async () => {
    const { second, calls, model, callsBeforeResume } = await resumeWith({});
    expect(errorCodes(second)).toEqual(["INVALID_PAYLOAD"]);
    expect(calls).toEqual([]);
    expect(model.calls, "Strands was resumed despite a rejected payload").toBe(
      callsBeforeResume,
    );
  });

  it("does not run the tool when the interrupt is cancelled", async () => {
    const { agent, model, calls } = approvalAgent();
    const first = await collect(agent, userTurn());
    const id = interruptsOf(first)[0].id;
    const callsBeforeResume = model.calls;
    const second = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "delete db" } as never],
        resume: [{ interruptId: id, status: "cancelled" }] as never,
      }),
    );
    // A cancelled entry carries no payload to validate, so it reaches the hook
    // without passing the responseSchema check first. The approved: false case
    // above also reaches the hook; this one additionally shows the hook denies
    // a response shape the schema gate never inspected.
    expect(errorCodes(second)).toEqual([]);
    expect(calls, "cancelled interrupt executed the tool").toEqual([]);
    expect(model.calls, "Strands was never resumed").toBeGreaterThan(
      callsBeforeResume,
    );
  });
});

describe("the approval hook grants only a strict boolean true", () => {
  /**
   * Dispatch a real `BeforeToolCallEvent` into the hook the adapter registered
   * on the real per-thread agent. Only the resume response Strands would hand
   * back is scripted, which is the one thing a single run cannot vary.
   */
  async function cancelFor(
    response: unknown,
  ): Promise<{ cancel: boolean | string; consulted: boolean }> {
    const { agent, tool } = approvalAgent();
    // Drive one run so the adapter constructs and hooks the per-thread agent.
    await collect(agent, userTurn());
    const core = threadAgent(agent)!;
    const registry = (
      core as unknown as {
        _hooksRegistry: { invokeCallbacks: (e: unknown) => Promise<unknown> };
      }
    )._hooksRegistry;

    const event = new BeforeToolCallEvent({
      agent: core as unknown as ConstructorParameters<
        typeof BeforeToolCallEvent
      >[0]["agent"],
      toolUse: { name: TOOL, input: { target: "db" }, toolUseId: "tu-1" },
      tool: tool as unknown as StrandsTool,
      invocationState: {} as ConstructorParameters<
        typeof BeforeToolCallEvent
      >[0]["invocationState"],
    });
    let consulted = false;
    (event as unknown as { interrupt: () => unknown }).interrupt = () => {
      consulted = true;
      return response;
    };
    await registry.invokeCallbacks(event);
    return { cancel: event.cancel, consulted };
  }

  it("grants approval for approved: true", async () => {
    const { cancel, consulted } = await cancelFor({ approved: true });
    // `cancel === false` is the event's constructed default, so on its own it
    // cannot tell "the hook granted" from "the hook never ran".
    expect(consulted, "the approval hook never ran").toBe(true);
    expect(cancel).toBe(false);
  });

  it("grants approval when unrelated extra keys ride along", async () => {
    const { cancel, consulted } = await cancelFor({
      approved: true,
      note: "looks fine",
    });
    expect(consulted, "the approval hook never ran").toBe(true);
    expect(cancel).toBe(false);
  });

  it.each([
    ["approved: false", { approved: false }],
    ["a string 'true'", { approved: "true" }],
    ["a string 'false'", { approved: "false" }],
    ["the number 1", { approved: 1 }],
    ["a missing approved key", {}],
    ["a bare true", true],
    ["a bare string", "y"],
    ["a bare number", 1],
    ["null", null],
    ["undefined", undefined],
  ])("denies %s", async (_label, response) => {
    const { cancel, consulted } = await cancelFor(response);
    expect(consulted, "the approval hook never ran").toBe(true);
    expect(cancel).toBe(`User denied approval for '${TOOL}'.`);
  });
});

describe("interruptOnCall for a client-provided tool", () => {
  it("is ignored, leaving the client to gate execution", async () => {
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({
          toolUseId: "tu-1",
          name: "client_tool",
          input: {},
        }),
        modelTurn.text("done"),
      ],
      { config: { toolBehaviors: { client_tool: { interruptOnCall: true } } } },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
        tools: [
          { name: "client_tool", description: "d", parameters: {} },
        ] as never,
      }),
    );
    // The call is forwarded to the client rather than interrupted server-side.
    expect(errorCodes(events)).toEqual([]);
    expect(events.map((e) => e.type)).toContain(EventType.TOOL_CALL_START);
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as
      | (BaseEvent & { outcome?: { type?: string } })
      | undefined;
    expect(finished, "no RUN_FINISHED emitted").toBeDefined();
    // `outcome` is absent on this finish, so `not.toBe("interrupt")` would hold
    // trivially. Assert the absence directly, and that the adapter recorded no
    // interrupt to resume.
    expect(finished!.outcome).toBeUndefined();
    expect(
      (
        agent as unknown as {
          _pendingInterruptsByThread: Map<string, unknown>;
        }
      )._pendingInterruptsByThread.get("thread-1"),
      "an interrupt was recorded for a client-provided tool",
    ).toBeUndefined();
  });
});
