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
  type Interrupt as AguiInterrupt,
  type ResumeEntry,
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
  captureStreamArgs,
  collect,
  expectNoRunError,
  finishedOf,
  minimalRunInput,
  modelTurn,
  parkInterrupts,
  realStrandsAgent,
  recordingTool,
  scriptedAgent,
  soleInterruptId,
  stream,
  threadAgent,
} from "./helpers";

const TOOL = "confirm_delete";

/**
 * Wrap a pre-built `AgentResult` as an agent stream. Retained for the tests
 * that pin adapter handling of a specific result shape, where constructing the
 * shape directly is the point.
 */
function makeAgentResultStream(
  result: StrandsAgentResult,
  events: unknown[] = [],
) {
  return async function* () {
    for (const e of events) yield e;
    return result;
  };
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

function approvalAgent(options: { sessionManager?: unknown } = {}) {
  const { tool, calls } = recordingTool(TOOL);
  const built = realStrandsAgent(
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
      config: {
        toolBehaviors: { [TOOL]: { interruptOnCall: true } },
        ...(options.sessionManager
          ? { sessionManagerProvider: () => options.sessionManager as never }
          : {}),
      },
    },
  );
  return { ...built, calls };
}

const userTurn = () =>
  minimalRunInput({
    messages: [{ id: "u1", role: "user", content: "delete db" } as never],
  });

function pendingFor(agent: StrandsAgent, threadId = "thread-1") {
  return (
    agent as unknown as {
      _pendingInterruptsByThread: Map<string, Map<string, AguiInterrupt>>;
    }
  )._pendingInterruptsByThread.get(threadId);
}


describe("StrandsAgent native interrupt bridge (Strands SDK 1.1.0+)", () => {
  it("emits RUN_FINISHED with outcome.interrupt when Strands stops for interrupt", async () => {
    const { agent } = approvalAgent();
    const events = await collect(agent, userTurn());

    const finished = finishedOf(events);
    expect(finished.outcome?.type).toBe("interrupt");
    expect(finished.outcome?.interrupts).toHaveLength(1);

    const first = finished.outcome!.interrupts![0];
    expect(first.reason).toBe("tool_call");
    expect(first.message).toBe(`Approve call to ${TOOL}?`);
    expect(first.metadata?.strandsName).toBe(`ag_ui:tool_call:${TOOL}`);

    // The adapter recorded the interrupt as pending under the id it reported.
    expect(pendingFor(agent)?.has(first.id)).toBe(true);
  });

  it("checkpoints an interrupt before returning it to a resumable client", async () => {
    const saveSnapshot = vi.fn();
    const sessionManager = { initAgent: vi.fn(), saveSnapshot };
    const { agent } = approvalAgent({ sessionManager });

    // Record when the checkpoint lands relative to the events the client sees.
    const seenAtSave: string[] = [];
    const events: BaseEvent[] = [];
    saveSnapshot.mockImplementation(async () => {
      seenAtSave.push(...events.map((e) => e.type));
    });
    for await (const e of agent.run(userTurn())) events.push(e);

    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    // Identity, not deep equality: a structurally similar agent is not the
    // agent whose interrupt state has to survive the restart.
    expect(saveSnapshot.mock.calls[0][0].target).toBe(threadAgent(agent));
    expect(saveSnapshot.mock.calls[0][0].isLatest).toBe(true);
    // "before returning it": the run was already under way when the checkpoint
    // fired, and no RUN_FINISHED had been yielded yet. The positive half
    // matters: not.toContain alone holds on an empty array.
    expect(seenAtSave).toContain(EventType.RUN_STARTED);
    expect(seenAtSave).not.toContain(EventType.RUN_FINISHED);
    expect(events.map((e) => e.type)).toContain(EventType.RUN_FINISHED);
  });

  it("accepts a matching resume[] and forwards InterruptResponseContent to Strands", async () => {
    const { agent, calls } = approvalAgent();
    const first = await collect(agent, userTurn());
    const id = soleInterruptId(first);

    // Not restored: each test builds its own agent, so the wrapper cannot
    // outlive the assertions it was installed for.
    const { calls: streamArgs } = captureStreamArgs(agent);
    const events = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "delete db" } as never],
        resume: [
          { interruptId: id, status: "resolved", payload: { approved: true } },
        ] as never,
      }),
    );

    expect(events.map((e) => e.type)).toContain(EventType.RUN_FINISHED);
    expect(events.map((e) => e.type)).not.toContain(EventType.RUN_ERROR);

    // Strands received InterruptResponseContent[] as its invoke args.
    expect(streamArgs).toHaveLength(1);
    const [forwarded] = streamArgs[0][0] as InterruptResponseContent[];
    expect(forwarded).toBeInstanceOf(InterruptResponseContent);
    expect(forwarded.interruptResponse.interruptId).toBe(id);
    expect(forwarded.interruptResponse.response).toEqual({ approved: true });

    // The approval actually took effect, and the pending set was cleared.
    expect(calls).toHaveLength(1);
    expect(pendingFor(agent)).toBeUndefined();
  });

  it("still emits UNKNOWN_INTERRUPT_ID when resume[] references an unknown id", async () => {
    const { agent } = approvalAgent();
    const first = await collect(agent, userTurn());
    const known = soleInterruptId(first);

    const events = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "delete db" } as never],
        resume: [
          { interruptId: "unknown-id", status: "resolved" },
          {
            interruptId: known,
            status: "resolved",
            payload: { approved: true },
          },
        ] as never,
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
    const { agent, calls } = approvalAgent();
    const first = await collect(agent, userTurn());
    const id = soleInterruptId(first);

    const { calls: streamArgs } = captureStreamArgs(agent);
    const second = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "delete db" } as never],
        resume: [{ interruptId: id, status: "cancelled" }] as never,
      }),
    );
    expectNoRunError(second, "cancelled resume");

    // All-cancelled resumes must still be forwarded to Strands as native
    // InterruptResponseContent, not short-circuited with a synthetic
    // RUN_FINISHED that bypasses stream()/native cleanup/hooks/session
    // persistence.
    expect(streamArgs).toHaveLength(1);
    const [forwarded] = streamArgs[0][0] as InterruptResponseContent[];
    expect(forwarded).toBeInstanceOf(InterruptResponseContent);
    expect(forwarded.interruptResponse.interruptId).toBe(id);
    expect(forwarded.interruptResponse.response).toEqual({
      status: "cancelled",
    });
    expect(calls, "cancelled resume executed the tool").toEqual([]);
    expect(
      pendingFor(agent),
      "cancelled resume left the interrupt pending",
    ).toBeUndefined();
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
