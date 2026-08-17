/**
 * Native interrupt flow (Strands SDK 1.1.0+): when the underlying
 * `AgentResult` comes back with `stopReason === "interrupt"`, the adapter
 * emits the interrupt-variant `RUN_FINISHED` and records the interrupt IDs
 * on the thread so the follow-up `resume[]` request is recognised as known
 * (rather than falling into the UNKNOWN_INTERRUPT_ID gate).
 */
import { describe, it, expect, vi } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput, type Interrupt as AguiInterrupt } from "@ag-ui/core";
import {
  AgentResult as StrandsAgentResult,
  InterruptResponseContent,
  Message as StrandsMessage,
  TextBlock,
  type Interrupt as StrandsInterrupt,
} from "@strands-agents/sdk";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput, scriptedAgent } from "./helpers";

function makeAgentResultStream(
  result: StrandsAgentResult,
  events: unknown[] = [],
) {
  return async function* () {
    for (const e of events) yield e;
    return result;
  };
}

function strandsInterrupt(id: string, toolName: string): StrandsInterrupt {
  // Mirrors the shape the adapter's own interruptOnCall hook produces:
  // name prefixed with "ag_ui:tool_call:" and a structured reason object.
  // The concrete class is internal; the adapter only reads .id / .name /
  // .reason, so a plain object that matches the interface is sufficient.
  return {
    id,
    name: `ag_ui:tool_call:${toolName}`,
    reason: { tool_call: true, tool_name: toolName, tool_input: {}, tool_use_id: id },
  } as unknown as StrandsInterrupt;
}

function buildAgentResult(interrupts: StrandsInterrupt[]): StrandsAgentResult {
  return new StrandsAgentResult({
    stopReason: "interrupt",
    lastMessage: StrandsMessage.fromMessageData({
      role: "assistant",
      content: [new TextBlock("awaiting approval").toJSON()],
    }),
    invocationState: {},
    interrupts,
  });
}

describe("StrandsAgent native interrupt bridge (Strands SDK 1.1.0+)", () => {
  it("emits RUN_FINISHED with outcome.interrupt when Strands stops for interrupt", async () => {
    const interrupts = [strandsInterrupt("int-1", "confirm_delete")];
    const stubAgent = scriptedAgent([], {
      stream: makeAgentResultStream(buildAgentResult(interrupts)) as never,
    });
    const sa = new StrandsAgent({ agent: stubAgent, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);

    const events = await collect(sa);
    const finished = events.at(-1) as BaseEvent & {
      outcome?: { type: string; interrupts?: unknown[] };
    };
    expect(finished.type).toBe(EventType.RUN_FINISHED);
    expect(finished.outcome?.type).toBe("interrupt");
    expect(finished.outcome?.interrupts).toHaveLength(1);
    const first = finished.outcome?.interrupts?.[0] as {
      id: string;
      reason: string;
      message?: string;
      metadata?: { strandsName?: string };
    };
    expect(first.id).toBe("int-1");
    expect(first.reason).toBe("tool_call");
    expect(first.message).toBe("Approve call to confirm_delete?");
    expect(first.metadata?.strandsName).toBe("ag_ui:tool_call:confirm_delete");

    // The interrupt is now pending on the thread.
    const pending = (
      sa as unknown as {
        _pendingInterruptsByThread: Map<string, Map<string, AguiInterrupt>>;
      }
    )._pendingInterruptsByThread.get("thread-1");
    expect(pending?.has("int-1")).toBe(true);
  });

  it("checkpoints an interrupt before returning it to a resumable client", async () => {
    const saveSnapshot = vi.fn().mockResolvedValue(undefined);
    const stubAgent = scriptedAgent([], {
      stream: makeAgentResultStream(
        buildAgentResult([strandsInterrupt("int-1", "confirm_delete")]),
      ) as never,
      sessionManager: { saveSnapshot } as never,
    });
    const sa = new StrandsAgent({ agent: stubAgent, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);

    await collect(sa);

    expect(saveSnapshot).toHaveBeenCalledWith({
      target: stubAgent,
      isLatest: true,
    });
  });

  it("accepts a matching resume[] and forwards InterruptResponseContent to Strands", async () => {
    let capturedArgs: unknown = null;
    const stubAgent = scriptedAgent([], {
      stream: ((args: unknown) => {
        capturedArgs = args;
        // After resume, Strands completes normally.
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "endTurn",
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("done").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    const sa = new StrandsAgent({ agent: stubAgent, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);
    // Seed a pending interrupt on the thread so the gate accepts the resume.
    (
      sa as unknown as {
        _pendingInterruptsByThread: Map<string, Map<string, AguiInterrupt>>;
      }
    )._pendingInterruptsByThread.set("thread-1", new Map([["int-7", { id: "int-7", reason: "tool_call" }]]));
    const input: RunAgentInput = minimalRunInput({
      resume: [
        {
          interruptId: "int-7",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
    const events = await collect(sa, input);

    expect(events.map((e) => e.type)).toContain(EventType.RUN_FINISHED);
    expect(events.map((e) => e.type)).not.toContain(EventType.RUN_ERROR);

    // Strands received InterruptResponseContent[] as its invoke args.
    expect(Array.isArray(capturedArgs)).toBe(true);
    const [first] = capturedArgs as InterruptResponseContent[];
    expect(first).toBeInstanceOf(InterruptResponseContent);
    expect(first.interruptResponse.interruptId).toBe("int-7");
    expect(first.interruptResponse.response).toEqual({ approved: true });

    // The pending set was cleared once resume was accepted.
    const cleared = (
      sa as unknown as {
        _pendingInterruptsByThread: Map<string, Map<string, AguiInterrupt>>;
      }
    )._pendingInterruptsByThread.get("thread-1");
    expect(cleared).toBeUndefined();
  });

  it("still emits UNKNOWN_INTERRUPT when resume[] references an unknown id", async () => {
    const stubAgent = scriptedAgent([]);
    const sa = new StrandsAgent({ agent: stubAgent, name: "t" });
    // One pending interrupt, but the resume references a different id.
    (
      sa as unknown as {
        _pendingInterruptsByThread: Map<string, Map<string, AguiInterrupt>>;
      }
    )._pendingInterruptsByThread.set("thread-1", new Map([["known", { id: "known", reason: "tool_call" }]]));

    const events = await collect(
      sa,
      minimalRunInput({
        resume: [
          { interruptId: "unknown-id", status: "resolved" },
          { interruptId: "known", status: "resolved", payload: { approved: true } },
        ],
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string; message: string };
    expect(err.code).toBe("UNKNOWN_INTERRUPT_ID");
    expect(err.message).toContain("unknown-id");
  });

  it("forwards a cancelled resume as native InterruptResponseContent through Strands", async () => {
    let capturedArgs: unknown = null;
    const stubAgent = scriptedAgent([], {
      stream: ((args: unknown) => {
        capturedArgs = args;
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "endTurn",
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("ok").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    const sa = new StrandsAgent({ agent: stubAgent, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);
    (
      sa as unknown as {
        _pendingInterruptsByThread: Map<string, Map<string, AguiInterrupt>>;
      }
    )._pendingInterruptsByThread.set("thread-1", new Map([["ic", { id: "ic", reason: "tool_call" }]]));

    await collect(
      sa,
      minimalRunInput({
        resume: [{ interruptId: "ic", status: "cancelled" }],
      }),
    );

    // All-cancelled resumes must still be forwarded to Strands as native
    // InterruptResponseContent — not short-circuited with a synthetic
    // RUN_FINISHED that bypasses stream()/native cleanup/hooks/session
    // persistence.
    expect(capturedArgs).not.toBeNull();
    expect(Array.isArray(capturedArgs)).toBe(true);
    const [first] = capturedArgs as InterruptResponseContent[];
    expect(first.interruptResponse.interruptId).toBe("ic");
    expect(first.interruptResponse.response).toEqual({ status: "cancelled" });
  });
});
