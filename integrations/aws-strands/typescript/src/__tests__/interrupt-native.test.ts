/**
 * Native interrupt flow (Strands SDK 1.1.0+): when the underlying
 * `AgentResult` comes back with `stopReason === "interrupt"`, the adapter
 * emits the interrupt-variant `RUN_FINISHED` and records the interrupt IDs
 * on the thread so the follow-up `resume[]` request is recognised as known
 * (rather than falling into the UNKNOWN_INTERRUPT_ID gate).
 */
import { describe, it, expect, vi } from "vitest";
import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type ResumeEntry,
  type Interrupt as AguiInterrupt,
} from "@ag-ui/core";
import {
  AgentResult as StrandsAgentResult,
  InterruptResponseContent,
  Message as StrandsMessage,
  TextBlock,
  type Interrupt as StrandsInterrupt,
  type InterruptResponse,
} from "@strands-agents/sdk";

import { StrandsAgent } from "../agent";
import {
  collect,
  minimalRunInput,
  parkInterrupts,
  scriptedAgent,
  stream,
} from "./helpers";

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

  it("logs a debug trace when a paused result carries no interrupts", async () => {
    // The run finishes as a success with nothing to resume, so the only trace
    // an operator can get that the checkpoint may still be parked is this log.
    const debug = vi.fn();
    const stubAgent = scriptedAgent([], {
      stream: makeAgentResultStream(buildAgentResult([])) as never,
    });
    const sa = new StrandsAgent({
      agent: stubAgent,
      name: "t",
      config: { logger: { debug, warn: vi.fn(), error: vi.fn() } },
    });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);

    const events = await collect(sa);

    // Control flow is unchanged: still a plain success finish, no extra event.
    const finished = events.at(-1) as BaseEvent & { outcome?: { type: string } };
    expect(finished.type).toBe(EventType.RUN_FINISHED);
    expect(finished.outcome).toBeUndefined();
    expect(events.map((e) => e.type)).not.toContain(EventType.RUN_ERROR);

    const traced = debug.mock.calls.map(([message]) => String(message));
    expect(
      traced.some(
        (message) =>
          message.includes("[@ag-ui/aws-strands]") &&
          /stopped for an interrupt with an empty interrupts list/.test(
            message,
          ) &&
          message.includes("reporting no pending interrupts"),
      ),
    ).toBe(true);
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
    // Park the interrupt on the SDK's checkpoint, with the adapter's metadata
    // record beside it, so the gate accepts the resume.
    parkInterrupts(sa, "thread-1", [{ id: "int-7", reason: "tool_call" }]);
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
    // One open interrupt, but the resume references a different id.
    parkInterrupts(sa, "thread-1", [{ id: "known", reason: "tool_call" }]);

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
    parkInterrupts(sa, "thread-1", [{ id: "ic", reason: "tool_call" }]);

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

/**
 * Resume one generic interrupt and return the single `InterruptResponse` the
 * adapter handed to Strands. Generic on purpose: no `responseSchema` means the
 * payload gate never runs, so whatever the client sent reaches the SDK as-is.
 */
async function forwardedResumeResponse(
  entry: ResumeEntry,
): Promise<InterruptResponse> {
  let capturedArgs: unknown = null;
  const stubAgent = scriptedAgent([], {
    stream: ((args: unknown) => {
      capturedArgs = args;
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
  parkInterrupts(sa, "thread-1", [
    { id: entry.interruptId, reason: "need_input" },
  ]);

  const events = await collect(sa, minimalRunInput({ resume: [entry] }));
  expect(events.map((e) => e.type)).not.toContain(EventType.RUN_ERROR);
  expect(Array.isArray(capturedArgs)).toBe(true);
  const [first] = capturedArgs as InterruptResponseContent[];
  return first.interruptResponse;
}

describe("Resume responses recorded on the native interrupt", () => {
  // Strands reads `response === undefined` as "still awaiting a human"
  // (InterruptState.getUnansweredInterrupts, and the gate in
  // interruptFromAgent that re-throws InterruptError). Handing it an
  // undefined response re-raises the same interrupt on every resume, and a
  // generic interrupt publishes no responseSchema, so nothing upstream
  // rejects an empty payload first.
  it("records a defined response when a resolved entry carries no payload", async () => {
    const response = await forwardedResumeResponse({
      interruptId: "int-absent",
      status: "resolved",
    });

    expect(response.response).not.toBeUndefined();
    expect(response.response).toStrictEqual({});
  });

  it("records a defined response when a resolved payload is explicitly undefined", async () => {
    const response = await forwardedResumeResponse({
      interruptId: "int-undef",
      status: "resolved",
      payload: undefined,
    });

    expect(response.response).not.toBeUndefined();
    expect(response.response).toStrictEqual({});
  });

  // The substitution above must not become a blanket rewrite: a payload that
  // is present is what the tool destructures, falsy values included.
  it.each([
    ["an object", { approved: true }],
    ["false", false],
    ["zero", 0],
    ["an empty string", ""],
    ["null", null],
    ["an empty array", []],
    ["an empty object", {}],
    ["a string", "approved"],
  ])("forwards a present payload unchanged: %s", async (_label, payload) => {
    const response = await forwardedResumeResponse({
      interruptId: "int-present",
      status: "resolved",
      payload,
    });

    expect(response.response).toStrictEqual(payload);
  });

  // The replay short-circuit answers from a fingerprint, so the fingerprint has
  // to separate whatever this converter separates. Reading an absent payload
  // and an explicit null as one resume answers the second with a success the
  // SDK never produced.
  it("does not read an explicit null payload as a replay of an absent one", async () => {
    const forwarded: InterruptResponse[] = [];
    const stubAgent = scriptedAgent([], {
      stream: ((args: unknown) => {
        for (const content of args as InterruptResponseContent[]) {
          forwarded.push(content.interruptResponse);
        }
        return (async function* () {
          yield stream.textDelta("resumed");
          return new StrandsAgentResult({
            stopReason: "endTurn",
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("resumed").toJSON()],
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
    const recordOpenInterrupt = () =>
      parkInterrupts(sa, "thread-1", [
        { id: "int-null", reason: "need_input" },
      ]);

    recordOpenInterrupt();
    await collect(
      sa,
      minimalRunInput({
        runId: "r1",
        resume: [{ interruptId: "int-null", status: "resolved" }],
      }),
    );

    // The tool asks its question again, so the same id is open again and the
    // client answers it with something else this time.
    recordOpenInterrupt();
    const second = await collect(
      sa,
      minimalRunInput({
        runId: "r2",
        resume: [
          { interruptId: "int-null", status: "resolved", payload: null },
        ],
      }),
    );

    expect(forwarded.map((response) => response.response)).toStrictEqual([
      {},
      null,
    ]);
    expect(second.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    expect(
      second
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((e) => (e as unknown as { delta: string }).delta),
    ).toStrictEqual(["resumed"]);
  });
});
