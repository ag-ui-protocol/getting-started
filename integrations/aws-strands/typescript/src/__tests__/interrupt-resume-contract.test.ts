/**
 * What a paused tool actually receives when a resume reaches it.
 *
 * This is the cross-language contract: a tool body written against one
 * bridge has to behave the same on the other, so the shape asserted here is
 * the shape the Python adapter hands its own tools. Nearly every case drives a
 * real Strands interrupt raised by a real tool inside the real agent loop and
 * then resumes it, rather than fabricating an interrupt object, because the
 * SDK's own "is this answered?" predicate is half of what is under test.
 *
 * The exceptions are the cases that need a checkpoint the real SDK will not
 * produce: one left behind by an earlier release, or a pause that hands back no
 * interrupts. Those script the agent deliberately and say so.
 */
import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { tool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";

import {
  AgentResult as StrandsAgentResult,
  Message as StrandsMessage,
  TextBlock,
} from "@strands-agents/sdk";

import { StrandsAgent } from "../agent";
import { INTERRUPT_CANCELLED } from "../index";
import {
  captureStreamArgs,
  collect,
  errorCodes,
  parkInterrupts,
  scriptedAgent,
  expectNoRunError,
  finishedOf,
  interruptsOf,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  recordingTool,
} from "./helpers";

const TOOL = "ask_operator";
const GATED_TOOL_NAME = "confirm_delete";

/** A run paused on one interrupt, plus the answers its tool has received. */
async function pausedRun() {
  const received: unknown[] = [];
  let completions = 0;
  const paused = tool({
    name: TOOL,
    description: "Asks the operator a question",
    inputSchema: z.object({}).passthrough(),
    callback: async (_input: unknown, context?: ToolContext) => {
      // `interrupt()` throws to suspend, so nothing below runs until a resume
      // supplies an answer the SDK counts as present.
      received.push(context!.interrupt({ name: "need_input", reason: {} }));
      completions += 1;
      return { ok: true };
    },
  });

  const { agent } = realStrandsAgent(
    [
      modelTurn.toolUse({ toolUseId: "tu-1", name: TOOL, input: {} }),
      modelTurn.text("done"),
    ],
    { tools: [paused] },
  );
  const first = await collect(
    agent,
    minimalRunInput({
      messages: [{ id: "u1", role: "user", content: "go" } as never],
    }),
  );
  expectNoRunError(first, "initial run");
  const interruptId = interruptsOf(first)[0]!.id;

  /** Resume the pause with `entry`, returning the events of that run. */
  const resumeWith = (entry: Record<string, unknown>, runId = "run-2") =>
    collect(
      agent,
      minimalRunInput({
        runId,
        messages: [{ id: "u1", role: "user", content: "go" } as never],
        resume: [{ interruptId, ...entry }] as never,
      }),
    );

  return {
    resumeWith,
    received,
    get completions() {
      return completions;
    },
  };
}

/** A run paused on an `interruptOnCall` approval for a recording tool. */
function approvalRun() {
  const { tool: gated, calls } = recordingTool(GATED_TOOL_NAME);
  const { agent } = realStrandsAgent(
    [
      modelTurn.toolUse({
        toolUseId: "tu-1",
        name: GATED_TOOL_NAME,
        input: {},
      }),
      modelTurn.text("done"),
    ],
    {
      tools: [gated],
      config: {
        toolBehaviors: { [GATED_TOOL_NAME]: { interruptOnCall: true } },
      },
    },
  );
  return { agent, calls };
}

/** True when `events` reported a pause rather than finishing the turn. */
const rePaused = (events: BaseEvent[]) =>
  finishedOf(events).outcome?.type === "interrupt";

describe("what a resumed tool receives", () => {
  // Each falsy answer, plus the absent one. This SDK gates on presence, so a
  // raw falsy answer is already accepted here; the envelope is what keeps the
  // shape identical to the Python bridge, whose supported floor gates on
  // truthiness. The re-pause assertions below hold the presence half: an answer
  // the SDK reads as absent still re-raises forever, in either language.
  const falsyAnswers: [label: string, payload: unknown, expected: unknown][] = [
    ["false", false, { response: false }],
    ["zero", 0, { response: 0 }],
    ["empty string", "", { response: "" }],
    ["null", null, { response: null }],
    ["empty array", [], { response: [] }],
    ["empty object", {}, { response: {} }],
  ];

  for (const [label, payload, expected] of falsyAnswers) {
    it(`hands the tool an envelope for an answer of ${label}`, async () => {
      const run = await pausedRun();
      const events = await run.resumeWith({ status: "resolved", payload });

      expectNoRunError(events, `resume with ${label}`);
      expect(
        rePaused(events),
        `an answer of ${label} was read as unanswered and re-raised`,
      ).toBe(false);
      expect(run.received).toEqual([expected]);
      expect(run.completions, "the tool body never completed").toBe(1);
    });
  }

  it("hands the tool an envelope when the answer carries no payload", async () => {
    // An acknowledge-style prompt whose button carries no data. The protocol
    // allows the entry to omit `payload` entirely; an answer the adapter
    // forwarded as absent would leave the interrupt unanswered, and the retry
    // below would then be answered from the idempotency fingerprint instead of
    // by the tool.
    const run = await pausedRun();
    const events = await run.resumeWith({ status: "resolved" });

    expectNoRunError(events, "payload-less resume");
    expect(
      rePaused(events),
      "a payload-less answer was read as unanswered and re-raised",
    ).toBe(false);
    expect(run.received).toEqual([{ response: null }]);
    expect(run.completions, "the tool body never completed").toBe(1);
  });

  it("answers a replayed payload-less resume without re-running the tool", async () => {
    // A replayed resume is answered from the idempotency fingerprint, which is
    // correct only because the resume it replays actually completed. This pins
    // the other half: the replay reports success AND the tool body ran exactly
    // once rather than being re-executed.
    const run = await pausedRun();
    await run.resumeWith({ status: "resolved" }, "run-2");
    const retry = await run.resumeWith({ status: "resolved" }, "run-3");

    expect(finishedOf(retry).outcome?.type).toBe("success");
    expect(
      run.completions,
      "a run reported success while the tool was still parked",
    ).toBe(1);
  });

  it("hands the tool the cancellation sentinel when the client cancels", async () => {
    const run = await pausedRun();
    const events = await run.resumeWith({ status: "cancelled" });

    expectNoRunError(events, "cancelled resume");
    expect(run.received).toEqual([{ cancelled: true }]);
    // Never the exported constant itself: a tool that mutated what it received
    // would otherwise poison every later cancellation.
    expect(run.received[0]).not.toBe(INTERRUPT_CANCELLED);
  });

  it("passes a tool approval its payload raw, without the envelope", async () => {
    // The approval hook reads `approved` off the answer directly, so this path
    // deliberately stays raw in both languages. Asserted on the wire shape the
    // adapter hands the SDK, plus the gated tool actually running, which is
    // what the hook accepting that shape looks like from outside.
    const { agent, calls } = approvalRun();
    const first = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );
    const interruptId = interruptsOf(first)[0]!.id;

    const { calls: streamArgs } = captureStreamArgs(agent);
    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "go" } as never],
        resume: [
          { interruptId, status: "resolved", payload: { approved: true } },
        ] as never,
      }),
    );
    expectNoRunError(resumed, "approval resume");

    const [forwarded] = streamArgs[0]![0] as {
      interruptResponse: { response: unknown };
    }[];
    expect(forwarded!.interruptResponse.response).toEqual({ approved: true });
    expect(calls, "the approved tool never ran").toHaveLength(1);
  });

  it("denies a cancelled tool approval in the shape its own hook reads", async () => {
    const { agent, calls } = approvalRun();
    const first = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );
    const interruptId = interruptsOf(first)[0]!.id;

    const { calls: streamArgs } = captureStreamArgs(agent);
    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "go" } as never],
        resume: [{ interruptId, status: "cancelled" }] as never,
      }),
    );
    expectNoRunError(resumed, "cancelled approval resume");

    const [forwarded] = streamArgs[0]![0] as {
      interruptResponse: { response: unknown };
    }[];
    expect(forwarded!.interruptResponse.response).toEqual({ approved: false });
    expect(calls, "a cancelled approval executed the tool").toEqual([]);
  });
});

describe("what an approval interrupt publishes", () => {
  // Both bridges advertise the same keys, so a client renders an approval the
  // same way whichever language served it.
  it("always carries a message, a schema and the three metadata keys", async () => {
    const { agent } = approvalRun();
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );

    const interrupt = interruptsOf(events)[0] as {
      reason: string;
      message?: string;
      toolCallId?: string;
      responseSchema?: unknown;
      metadata?: Record<string, unknown>;
    };
    expect(interrupt.reason).toBe("tool_call");
    expect(interrupt.message).toBe("Approve call to confirm_delete?");
    expect(interrupt.toolCallId).toBe("tu-1");
    expect(interrupt.responseSchema).toEqual({
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
    });
    expect(Object.keys(interrupt.metadata ?? {}).sort()).toEqual([
      "strandsName",
      "tool_input",
      "tool_name",
    ]);
    expect(interrupt.metadata).toEqual({
      tool_name: "confirm_delete",
      tool_input: {},
      strandsName: "ag_ui:tool_call:confirm_delete",
    });
  });

  // An approval whose reason did not survive a restart still has to be
  // classified by its reserved name, published with the same keys, and answered
  // raw, since its own hook reads `approved` off the answer. Raised for real
  // rather than fabricated: a hand-built interrupt object would not exercise
  // the SDK's own recording of the answer.
  const reasonlessApproval = () => {
    const raising = tool({
      name: "ghost",
      description: "Raises an approval-named interrupt carrying no reason",
      inputSchema: z.object({}).passthrough(),
      callback: async (_input: unknown, context?: ToolContext) => {
        received.push(context!.interrupt({ name: "ag_ui:tool_call:ghost" }));
        return { ok: true };
      },
    });
    const received: unknown[] = [];
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({ toolUseId: "tu-9", name: "ghost", input: {} }),
        modelTurn.text("done"),
      ],
      { tools: [raising] },
    );
    return { agent, received };
  };

  it("publishes a copy of tool_input, not a handle on the live interrupt", async () => {
    // The published metadata must not alias the native interrupt's reason, or a
    // client inspecting an approval could reach into the SDK's own checkpoint.
    const { tool: gated, calls } = recordingTool(GATED_TOOL_NAME);
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({
          toolUseId: "tu-1",
          name: GATED_TOOL_NAME,
          input: { path: "/tmp/original", nested: { deep: "/tmp/original" } },
        }),
        modelTurn.text("done"),
      ],
      {
        tools: [gated],
        config: {
          toolBehaviors: { [GATED_TOOL_NAME]: { interruptOnCall: true } },
        },
      },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );
    const interrupt = interruptsOf(events)[0] as {
      id: string;
      metadata?: { tool_input?: Record<string, unknown> };
    };
    expect(interrupt.metadata?.tool_input).toEqual({
      path: "/tmp/original",
      nested: { deep: "/tmp/original" },
    });

    // A consumer mutates what it was handed, at the top level and below it.
    interrupt.metadata!.tool_input!.path = "/etc/passwd";
    (interrupt.metadata!.tool_input!.nested as Record<string, unknown>).deep =
      "/etc/passwd";

    const nativeReason = (
      agent as unknown as {
        _agentsByThread: Map<
          string,
          {
            _interruptState?: {
              interrupts?: Record<
                string,
                { reason?: { tool_input?: Record<string, unknown> } }
              >;
            };
          }
        >;
      }
    )._agentsByThread.get("thread-1")?._interruptState?.interrupts?.[
      interrupt.id
    ]?.reason?.tool_input;
    expect(
      nativeReason,
      "the published metadata aliased the live native interrupt reason",
    ).toEqual({ path: "/tmp/original", nested: { deep: "/tmp/original" } });
    expect(calls).toEqual([]);
  });

  it("stands in the same defaults when the reason did not survive", async () => {
    const { agent } = reasonlessApproval();
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );

    const interrupt = interruptsOf(events)[0] as {
      reason: string;
      message?: string;
      toolCallId?: string;
      responseSchema?: unknown;
      metadata?: Record<string, unknown>;
    };
    expect(interrupt.reason).toBe("tool_call");
    expect(interrupt.message).toBe("Approve call to unknown?");
    expect(interrupt.toolCallId).toBeUndefined();
    // The schema is what makes the payload gate check an approval at all, so a
    // reason-less one still has to carry it.
    expect(interrupt.responseSchema).toEqual({
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
    });
    expect(interrupt.metadata).toEqual({
      tool_name: "unknown",
      tool_input: {},
      strandsName: "ag_ui:tool_call:ghost",
    });
  });

  // A reason present but unusable, which is the other way the fields can go
  // missing. Both languages apply the same "is it usable?" test, so neither
  // publishes a tool_name that is not a name, a tool_input that is not an input
  // object, or a blank tool-call binding.
  it.each([
    ["the wrong types", { tool_name: 123, tool_input: [], tool_use_id: 7 }],
    ["blank strings", { tool_name: "", tool_input: {}, tool_use_id: "" }],
  ])(
    "stands in the same defaults when the reason carries %s",
    async (label, reason) => {
      const name = `malformed_${label.replace(/\W/g, "_")}`;
      const raising = tool({
        name,
        description: "Raises an approval whose reason fields are unusable",
        inputSchema: z.object({}).passthrough(),
        callback: async (_input: unknown, context?: ToolContext) => {
          context!.interrupt({
            name: `ag_ui:tool_call:${name}`,
            reason: reason as never,
          });
          return { ok: true };
        },
      });
      const { agent } = realStrandsAgent(
        [
          modelTurn.toolUse({ toolUseId: "tu-8", name, input: {} }),
          modelTurn.text("done"),
        ],
        { tools: [raising] },
      );
      const events = await collect(
        agent,
        minimalRunInput({
          messages: [{ id: "u1", role: "user", content: "go" } as never],
        }),
      );

      const interrupt = interruptsOf(events)[0] as {
        message?: string;
        toolCallId?: string;
        metadata?: Record<string, unknown>;
      };
      expect(interrupt.message).toBe("Approve call to unknown?");
      expect(interrupt.toolCallId).toBeUndefined();
      // The reason carried nothing the three keys could hold, so it is published
      // rather than dropped: a client seeing only the defaults would have no way
      // to tell a missing reason from an unreadable one.
      expect(interrupt.metadata).toEqual({
        tool_name: "unknown",
        tool_input: {},
        strandsName: `ag_ui:tool_call:${name}`,
        reason,
      });
    },
  );

  it("publishes a copy of an unusable reason, not a handle on it", async () => {
    // The reason is published only when nothing else carried it, so it is the
    // one path where a client holds the reason object itself. It must be
    // detached like every other published field.
    const raising = tool({
      name: "aliased",
      description: "Raises an approval whose reason is an unusable mapping",
      inputSchema: z.object({}).passthrough(),
      callback: async (_input: unknown, context?: ToolContext) => {
        context!.interrupt({
          name: "ag_ui:tool_call:aliased",
          reason: { question: { deep: "original" } } as never,
        });
        return { ok: true };
      },
    });
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({ toolUseId: "tu-5", name: "aliased", input: {} }),
        modelTurn.text("done"),
      ],
      { tools: [raising] },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );
    const interrupt = interruptsOf(events)[0] as {
      id: string;
      metadata?: { reason?: { question?: Record<string, unknown> } };
    };
    expect(interrupt.metadata?.reason).toEqual({
      question: { deep: "original" },
    });

    // A consumer mutates what it was handed, below the top level.
    interrupt.metadata!.reason!.question!.deep = "tampered";

    const native = (
      agent as unknown as {
        _agentsByThread: Map<
          string,
          {
            _interruptState?: {
              interrupts?: Record<
                string,
                { reason?: { question?: Record<string, unknown> } }
              >;
            };
          }
        >;
      }
    )._agentsByThread.get("thread-1")?._interruptState?.interrupts?.[
      interrupt.id
    ]?.reason;
    expect(
      native,
      "the published reason aliased the live native interrupt reason",
    ).toEqual({ question: { deep: "original" } });
  });

  it("still answers a reason-less approval raw", async () => {
    const { agent, received } = reasonlessApproval();
    const first = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );
    const interruptId = interruptsOf(first)[0]!.id;

    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "go" } as never],
        resume: [
          { interruptId, status: "resolved", payload: { approved: true } },
        ] as never,
      }),
    );
    expectNoRunError(resumed, "reason-less approval resume");
    expect(received).toEqual([{ approved: true }]);
  });
});

describe("a batch holding both shapes at once", () => {
  // The shape is chosen per entry, from that entry's own interrupt, so a batch
  // can legitimately carry both. Classifying the batch as a whole instead would
  // either envelope the approval (denying an approved tool) or hand the generic
  // tool a raw answer, and every single-interrupt test above would still pass.
  it("envelopes the generic answer and passes the approval raw in one resume", async () => {
    const received: unknown[] = [];
    const asking = tool({
      name: TOOL,
      description: "Asks the operator a question",
      inputSchema: z.object({}).passthrough(),
      callback: async (_input: unknown, context?: ToolContext) => {
        received.push(context!.interrupt({ name: "need_input", reason: {} }));
        return { ok: true };
      },
    });
    const { tool: gated, calls } = recordingTool(GATED_TOOL_NAME);

    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse(
          { toolUseId: "tu-1", name: TOOL, input: {} },
          { toolUseId: "tu-2", name: GATED_TOOL_NAME, input: {} },
        ),
        modelTurn.text("done"),
      ],
      {
        tools: [asking, gated],
        config: {
          toolBehaviors: { [GATED_TOOL_NAME]: { interruptOnCall: true } },
        },
      },
    );
    const user = { id: "u1", role: "user", content: "go" } as never;

    const first = await collect(agent, minimalRunInput({ messages: [user] }));
    expectNoRunError(first, "mixed initial run");
    const interrupts = interruptsOf(first, 2) as {
      id: string;
      reason: string;
    }[];
    const generic = interrupts.find((i) => i.reason === "need_input")!;
    const approval = interrupts.find((i) => i.reason === "tool_call")!;
    expect(generic, "no generic interrupt was raised").toBeDefined();
    expect(approval, "no approval interrupt was raised").toBeDefined();

    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [user],
        resume: [
          {
            interruptId: generic.id,
            status: "resolved",
            payload: { environment: "staging" },
          },
          {
            interruptId: approval.id,
            status: "resolved",
            payload: { approved: true },
          },
        ] as never,
      }),
    );
    expectNoRunError(resumed, "mixed resume");

    // The generic tool reads its answer off `.response`.
    expect(received).toEqual([{ response: { environment: "staging" } }]);
    // And the approval's hook read `approved` off a raw payload, so the gated
    // tool ran. Enveloping it would have denied it silently.
    expect(calls, "the approved tool was denied in a mixed batch").toHaveLength(
      1,
    );
  });
});

describe("answers a previous release recorded", () => {
  // A checkpoint the SDK parked mid-resume before the envelope landed holds the
  // OLD answer shape. An exact replay is the only way to finish the execution it
  // holds, so the replay comparison has to still recognise that shape or the
  // thread is wedged for good, with no error and no log.
  const legacyParkedReplay = async (
    recorded: unknown,
    entry: Record<string, unknown>,
    name = "need_input",
  ) => {
    const forwarded: unknown[] = [];
    const stub = scriptedAgent([], {
      stream: ((args: unknown) => {
        for (const content of args as {
          interruptResponse: { response: unknown };
        }[]) {
          forwarded.push(content.interruptResponse.response);
        }
        return (async function* () {
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
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);
    parkInterrupts(agent, "thread-1", [{ id: "int-legacy", reason: name }], {
      "int-legacy": { id: "int-legacy", name },
    });
    // The checkpoint the SDK left behind: activated, and already answered.
    const native = (
      agent as unknown as {
        _agentsByThread: Map<
          string,
          { _interruptState?: { interrupts?: Record<string, unknown> } }
        >;
      }
    )._agentsByThread.get("thread-1")!._interruptState!.interrupts!;
    (native["int-legacy"] as Record<string, unknown>).response = recorded;

    const events = await collect(
      agent,
      minimalRunInput({
        resume: [{ interruptId: "int-legacy", ...entry }] as never,
      }),
    );
    return { events, forwarded };
  };

  it("recognises a replay recorded in the pre-envelope shape", async () => {
    // `{}` is what the old code submitted for a resolved entry with no payload.
    const { events, forwarded } = await legacyParkedReplay(
      {},
      {
        status: "resolved",
      },
    );

    expectNoRunError(events, "legacy parked replay");
    expect(
      forwarded,
      "the replay never reached Strands, so the parked execution cannot finish",
    ).toHaveLength(1);
  });

  it("recognises a replay whose recorded answer was a cancel payload", async () => {
    // The cancel shape this release writes and a pre-envelope cancel PAYLOAD are
    // the same object, and the shipped example's Cancel button submitted exactly
    // that payload. Treating it as one of ours refuses the migration the
    // fallback exists for, so it has to be allowed through while a wrapped
    // answer is not.
    const { events, forwarded } = await legacyParkedReplay(
      { cancelled: true },
      { status: "resolved", payload: { cancelled: true } },
    );

    expectNoRunError(events, "pre-envelope cancel payload replay");
    expect(
      forwarded,
      "the migration path for a pre-envelope cancel payload was refused",
    ).toHaveLength(1);
  });

  it("keeps the approval discriminator in the replay comparison", async () => {
    // A cancelled approval is the one case where the raw and the pre-envelope
    // answers differ, so it is the only case that can prove the comparison still
    // knows an approval from a generic interrupt. For a resolved entry the two
    // are identical and the legacy fallback would mask the loss.
    const { events, forwarded } = await legacyParkedReplay(
      { approved: false },
      { status: "cancelled" },
      "ag_ui:tool_call:deploy",
    );

    expectNoRunError(events, "parked cancelled-approval replay");
    expect(
      forwarded,
      "the comparison stopped recognising a parked approval's own denial",
    ).toEqual([{ approved: false }]);
  });

  it("refuses a pre-wrapped payload that matches an answer it wrote itself", async () => {
    // The legacy fallback compares against the bare payload, so a client that
    // pre-wrapped its answer would match an envelope this release recorded and
    // then be resumed with a second envelope around the first. Refusing is the
    // safe way to be wrong: the alternative hands the parked tool a value one
    // level too deep, silently.
    const { events, forwarded } = await legacyParkedReplay(
      { response: { a: 1 } },
      { status: "resolved", payload: { response: { a: 1 } } },
    );

    expect(errorCodes(events)).toEqual(["UNKNOWN_INTERRUPT_ID"]);
    expect(
      forwarded,
      "a pre-wrapped payload was accepted as a replay and double-wrapped",
    ).toEqual([]);
  });

  it("still migrates a recorded answer that merely contains the wrapper key", async () => {
    // The refusal above is about an answer that IS the wrapper, one key and no
    // more. A pre-envelope payload that happened to carry that key alongside
    // others is not one of ours and must still migrate, which is what keeps the
    // check a shape test rather than a key search.
    const { events, forwarded } = await legacyParkedReplay(
      { response: 1, chosen: "b" },
      { status: "resolved", payload: { response: 1, chosen: "b" } },
    );

    expectNoRunError(events, "wrapper-key-containing payload replay");
    expect(forwarded).toHaveLength(1);
  });

  it("recognises a cancellation recorded in the pre-envelope shape", async () => {
    const { events, forwarded } = await legacyParkedReplay(
      { status: "cancelled" },
      { status: "cancelled" },
    );

    expectNoRunError(events, "legacy parked cancel replay");
    expect(forwarded).toHaveLength(1);
  });
});

describe("an approval whose reason cannot be read", () => {
  it("still publishes the reason it could not use", async () => {
    // The relaxed classifier admits this case on purpose. Dropping the reason
    // as well would leave the client nothing but the "unknown" defaults.
    const odd = tool({
      name: "odd",
      description:
        "Raises an approval-named interrupt with a non-object reason",
      inputSchema: z.object({}).passthrough(),
      callback: async (_input: unknown, context?: ToolContext) => {
        context!.interrupt({
          name: "ag_ui:tool_call:odd",
          reason: "not an object" as never,
        });
        return { ok: true };
      },
    });
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({ toolUseId: "tu-6", name: "odd", input: {} }),
        modelTurn.text("done"),
      ],
      { tools: [odd] },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );

    const interrupt = interruptsOf(events)[0] as {
      reason: string;
      metadata?: Record<string, unknown>;
    };
    expect(interrupt.reason).toBe("tool_call");
    expect(interrupt.metadata).toEqual({
      tool_name: "unknown",
      tool_input: {},
      strandsName: "ag_ui:tool_call:odd",
      reason: "not an object",
    });
  });
});

describe("a resume that pauses again on a new interrupt", () => {
  // The resume answered the question it was sent for, but the tool then asked
  // another one, so the turn did not finish. A client that retries the stale
  // batch (a network retry is enough) must not be told the run succeeded while
  // the tool sits parked on a question it never heard about.
  const asksTwice = () => {
    const answers: unknown[] = [];
    const asking = tool({
      name: "asks_twice",
      description: "Asks two questions in one body",
      inputSchema: z.object({}).passthrough(),
      callback: async (_input: unknown, context?: ToolContext) => {
        answers.push(context!.interrupt({ name: "first", reason: {} }));
        answers.push(context!.interrupt({ name: "second", reason: {} }));
        return { ok: true };
      },
    });
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({
          toolUseId: "tu-1",
          name: "asks_twice",
          input: {},
        }),
        modelTurn.text("done"),
      ],
      { tools: [asking] },
    );
    return { agent, answers };
  };
  const user = { id: "u1", role: "user", content: "go" } as never;

  it("does not answer a retry of the stale batch with a false success", async () => {
    const { agent, answers } = asksTwice();

    const first = await collect(agent, minimalRunInput({ messages: [user] }));
    const firstId = interruptsOf(first)[0]!.id;
    const stale = [
      { interruptId: firstId, status: "resolved", payload: { a: 1 } },
    ] as never;

    const second = await collect(
      agent,
      minimalRunInput({ runId: "run-2", messages: [user], resume: stale }),
    );
    // The tool asked its second question, so this turn paused rather than ended.
    expect(finishedOf(second).outcome?.type).toBe("interrupt");
    const reRaised = interruptsOf(second)[0]!;
    expect(reRaised.id).not.toBe(firstId);

    // The client retries the batch it already sent, having never seen the reply.
    const retry = await collect(
      agent,
      minimalRunInput({ runId: "run-3", messages: [user], resume: stale }),
    );

    // Refused, loudly, which is what the Python bridge already did. The stale
    // batch names an interrupt that is no longer open, and the run the client
    // missed already reported the one that is.
    expect(
      retry.some((e) => e.type === EventType.RUN_FINISHED),
      "the retry reported a finished run while the tool was still parked on a question the client never saw",
    ).toBe(false);
    expect(errorCodes(retry)).toEqual(["UNKNOWN_INTERRUPT_ID"]);
    // And the tool never got past its second question.
    expect(answers).toHaveLength(1);
  });

  it("leaves the re-raised interrupt answerable", async () => {
    const { agent, answers } = asksTwice();

    const first = await collect(agent, minimalRunInput({ messages: [user] }));
    const firstId = interruptsOf(first)[0]!.id;
    const second = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [user],
        resume: [
          { interruptId: firstId, status: "resolved", payload: { a: 1 } },
        ] as never,
      }),
    );
    const reRaised = interruptsOf(second)[0]!;

    // Addressing the interrupt the run actually reported still works, which is
    // what makes refusing the stale batch the safe answer rather than a wedge.
    const third = await collect(
      agent,
      minimalRunInput({
        runId: "run-3",
        messages: [user],
        resume: [
          { interruptId: reRaised.id, status: "resolved", payload: { b: 2 } },
        ] as never,
      }),
    );
    expectNoRunError(third, "answering the re-raised interrupt");
    expect(finishedOf(third).outcome?.type).not.toBe("interrupt");
    // Resuming re-runs the body from the top, so the first question is answered
    // again from its recorded answer before the second one is reached. What
    // matters here is that the second question got the answer sent for it.
    expect(answers.at(-1)).toEqual({ response: { b: 2 } });
    expect(answers.length).toBeGreaterThan(1);
  });
});

describe("a pause that reports no interrupts", () => {
  // The framework can stop for an interrupt and hand back nothing. That finish
  // is indistinguishable from a real success in the event stream, so a retry of
  // the resume must not be answered from the idempotency fingerprint while the
  // tool is still parked behind it.
  it("does not let an abandoned run suppress the next resume", async () => {
    // The pause is recorded on the finish event and read as it goes past, so a
    // run the caller walked away from must not leave it set: the next resume is
    // a different one, and suppressing its fingerprint breaks idempotency for a
    // resume that genuinely completed.
    let quiet = true;
    let streamCalls = 0;
    const stub = scriptedAgent([], {
      stream: (() => {
        streamCalls += 1;
        const paused = quiet;
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: paused ? "interrupt" : "endTurn",
            ...(paused ? { interrupts: [] } : {}),
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("done").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);
    const park = () =>
      parkInterrupts(agent, "thread-1", [
        { id: "int-abandoned", reason: "need_input" },
      ]);
    const batch = [
      { interruptId: "int-abandoned", status: "resolved", payload: { a: 1 } },
    ] as never;

    // A run the caller abandons at its last event. It has to get far enough to
    // record the quiet pause, which happens just before the finish, and then be
    // dropped before the bookkeeping that reads that pause runs.
    park();
    for await (const event of agent.run(
      minimalRunInput({ runId: "run-1", resume: batch }),
    )) {
      if (event.type === EventType.RUN_FINISHED) break;
    }
    // The abandoned run has to reach the quiet pause for this to prove
    // anything, which is why it is driven to its last event before being
    // dropped: the pause is recorded just before that finish is yielded.
    expect(
      streamCalls,
      "the abandoned run never reached the framework, so it cannot have paused",
    ).toBe(1);

    // A later resume that completes normally must still be remembered.
    quiet = false;
    park();
    await collect(agent, minimalRunInput({ runId: "run-2", resume: batch }));
    const callsAfterFirst = streamCalls;
    park();
    await collect(agent, minimalRunInput({ runId: "run-3", resume: batch }));

    expect(
      streamCalls,
      "the completed resume was not remembered, so its replay re-ran",
    ).toBe(callsAfterFirst);
  });

  it("does not let one thread's parked pause suppress another thread", async () => {
    // The pause belongs to the run that had it. This used to be a claim about
    // how a shared per-thread record was keyed; it is now a property of where
    // the fact lives, and worth pinning either way.
    let streamCalls = 0;
    let parkedThread = "thread-a";
    let stub: Record<string, unknown>;
    const scripted = scriptedAgent([], {
      stream: (() => {
        streamCalls += 1;
        // Only the parked thread's run leaves a checkpoint behind.
        if (parkedThread !== "thread-a") {
          stub._interruptState = { activated: false, interrupts: new Map() };
        }
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "interrupt",
            interrupts: [],
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("paused").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    stub = scripted as unknown as Record<string, unknown>;
    const agent = new StrandsAgent({ agent: scripted, name: "t" });
    const internals = agent as unknown as {
      _agentsByThread: Map<string, unknown>;
    };
    internals._agentsByThread.set("thread-a", scripted);
    internals._agentsByThread.set("thread-b", scripted);

    const entry = (id: string) =>
      [{ interruptId: id, status: "resolved", payload: { a: 1 } }] as never;

    // thread-a pauses parked.
    parkInterrupts(agent, "thread-a", [{ id: "int-a", reason: "need_input" }]);
    await collect(
      agent,
      minimalRunInput({
        threadId: "thread-a",
        runId: "run-a",
        resume: entry("int-a"),
      }),
    );

    // thread-b completes for real, and must still be remembered as completed.
    parkedThread = "thread-b";
    parkInterrupts(agent, "thread-b", [{ id: "int-b", reason: "need_input" }]);
    await collect(
      agent,
      minimalRunInput({
        threadId: "thread-b",
        runId: "run-b",
        resume: entry("int-b"),
      }),
    );
    const callsAfterB = streamCalls;

    parkInterrupts(agent, "thread-b", [{ id: "int-b", reason: "need_input" }]);
    const replay = await collect(
      agent,
      minimalRunInput({
        threadId: "thread-b",
        runId: "run-b2",
        resume: entry("int-b"),
      }),
    );
    expectNoRunError(replay, "replay on the unrelated thread");
    expect(
      streamCalls,
      "another thread's parked pause suppressed this thread's completed resume",
    ).toBe(callsAfterB);
  });

  it("does not remember such a resume as completed", async () => {
    let streamCalls = 0;
    const stub = scriptedAgent([], {
      stream: (() => {
        streamCalls += 1;
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "interrupt",
            interrupts: [],
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("paused").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);

    const batch = [
      { interruptId: "int-quiet", status: "resolved", payload: { a: 1 } },
    ] as never;
    const park = () =>
      parkInterrupts(agent, "thread-1", [
        { id: "int-quiet", reason: "need_input" },
      ]);

    park();
    const first = await collect(
      agent,
      minimalRunInput({ runId: "run-1", resume: batch }),
    );
    expectNoRunError(first, "quiet pause");
    expect(streamCalls).toBe(1);

    // The client retries, having no way to know the run only looked finished.
    park();
    const retry = await collect(
      agent,
      minimalRunInput({ runId: "run-2", resume: batch }),
    );
    expectNoRunError(retry, "retry after a quiet pause");
    expect(
      streamCalls,
      "the retry was answered from the fingerprint instead of reaching the framework",
    ).toBe(2);
  });

  it("still remembers one that left no checkpoint behind", async () => {
    // The other half, and the reason the guard reads the checkpoint at all. A
    // run reporting an interrupt stop with nothing to hand over and no active
    // checkpoint has finished its work. Withholding there would cost the client
    // its idempotent retry and leave the answered interrupt recorded as
    // pending.
    let streamCalls = 0;
    let stub: Record<string, unknown>;
    const scripted = scriptedAgent([], {
      stream: (() => {
        streamCalls += 1;
        // What the SDK does on a completed invocation: the checkpoint is stood
        // down before the terminal result is handed over.
        stub._interruptState = { activated: false, interrupts: new Map() };
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "interrupt",
            interrupts: [],
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("done").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    stub = scripted as unknown as Record<string, unknown>;
    const agent = new StrandsAgent({ agent: scripted, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", scripted);

    const batch = [
      { interruptId: "int-done", status: "resolved", payload: { a: 1 } },
    ] as never;
    parkInterrupts(agent, "thread-1", [
      { id: "int-done", reason: "need_input" },
    ]);

    const first = await collect(
      agent,
      minimalRunInput({ runId: "run-1", resume: batch }),
    );
    expectNoRunError(first, "reported pause with no checkpoint");
    expect(streamCalls).toBe(1);

    const retry = await collect(
      agent,
      minimalRunInput({ runId: "run-2", resume: batch }),
    );
    expectNoRunError(retry, "retry of a completed resume");
    expect(
      streamCalls,
      "the completed resume was not remembered, so its replay re-ran",
    ).toBe(1);
  });

  it("survives an overlapping request arriving before it is read", async () => {
    // A second request on the same thread is refused rather than run, and it
    // arrives while the first run's pause has been recorded but not yet acted
    // on. Refused or not, it must not disturb that pause: the first resume
    // would otherwise be remembered as completed and the next retry answered
    // from the fingerprint while its tool is still parked. The pause belongs to
    // one run by construction now, so this holds structurally; it stays a test
    // because it did not hold under the obvious implementations.
    let streamCalls = 0;
    const stub = scriptedAgent([], {
      stream: (() => {
        streamCalls += 1;
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "interrupt",
            interrupts: [],
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("paused").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);

    const batch = [
      { interruptId: "int-race", status: "resolved", payload: { a: 1 } },
    ] as never;
    const park = () =>
      parkInterrupts(agent, "thread-1", [
        { id: "int-race", reason: "need_input" },
      ]);

    park();
    let overlapping: BaseEvent[] = [];
    const first: BaseEvent[] = [];
    for await (const event of agent.run(
      minimalRunInput({ runId: "run-1", resume: batch }),
    )) {
      first.push(event);
      // The window: the quiet pause has been recorded, and this run's tail has
      // not read it yet because the closing event is still being delivered.
      if (event.type === EventType.RUN_FINISHED) {
        overlapping = await collect(
          agent,
          minimalRunInput({ runId: "run-2", resume: batch }),
        );
      }
    }

    expect(errorCodes(overlapping)).toEqual(["THREAD_BUSY"]);
    expectNoRunError(first, "quiet pause with an overlapping request");
    expect(streamCalls).toBe(1);

    // The client retries the resume it never saw answered.
    park();
    const retry = await collect(
      agent,
      minimalRunInput({ runId: "run-3", resume: batch }),
    );
    expectNoRunError(retry, "retry after an overlapping request");
    expect(
      streamCalls,
      "the overlapping request disturbed the first run's pause, so the retry was answered from the fingerprint",
    ).toBe(2);
  });

  it("survives an overlapping request that reuses the run id", async () => {
    // The identity that matters is which run executed, not what the request
    // called itself. A retry replaying an identical body replays its run id
    // too, so an overlap carrying the same one must be told apart from the run
    // it collides with by having been refused rather than by its name.
    let streamCalls = 0;
    const stub = scriptedAgent([], {
      stream: (() => {
        streamCalls += 1;
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "interrupt",
            interrupts: [],
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("paused").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);

    const batch = [
      { interruptId: "int-same", status: "resolved", payload: { a: 1 } },
    ] as never;
    const park = () =>
      parkInterrupts(agent, "thread-1", [
        { id: "int-same", reason: "need_input" },
      ]);

    park();
    let overlapping: BaseEvent[] = [];
    for await (const event of agent.run(
      minimalRunInput({ runId: "same-run", resume: batch }),
    )) {
      if (event.type === EventType.RUN_FINISHED) {
        overlapping = await collect(
          agent,
          // The same run id as the request still in flight.
          minimalRunInput({ runId: "same-run", resume: batch }),
        );
      }
    }
    expect(errorCodes(overlapping)).toEqual(["THREAD_BUSY"]);

    park();
    const retry = await collect(
      agent,
      minimalRunInput({ runId: "run-3", resume: batch }),
    );
    expectNoRunError(retry, "retry after a same-id overlapping request");
    expect(
      streamCalls,
      "the overlap was mistaken for the run it collided with, so the retry was answered from the fingerprint",
    ).toBe(2);
  });

  it("does not let an abandoned run's pause suppress a later resume", async () => {
    // An abandoned run's pause dies with the run, so nothing is left behind to
    // affect a later one. Distinct from the existing abandoned-run test: that
    // one checks the next resume still reaches the framework, this one checks
    // the later resume is still remembered as completed, which is the half a
    // leftover record used to take away.
    let streamCalls = 0;
    let parked = true;
    let stub: Record<string, unknown>;
    const scripted = scriptedAgent([], {
      stream: (() => {
        streamCalls += 1;
        if (!parked) {
          stub._interruptState = { activated: false, interrupts: new Map() };
        }
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "interrupt",
            interrupts: [],
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("x").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    stub = scripted as unknown as Record<string, unknown>;
    const agent = new StrandsAgent({ agent: scripted, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", scripted);

    const batch = [
      { interruptId: "int-stale", status: "resolved", payload: { a: 1 } },
    ] as never;
    const park = () =>
      parkInterrupts(agent, "thread-1", [
        { id: "int-stale", reason: "need_input" },
      ]);

    // A run that pauses parked and is abandoned before that pause is acted on.
    park();
    const abandoned = agent.run(
      minimalRunInput({ runId: "run-1", resume: batch }),
    );
    for await (const event of abandoned) {
      if (event.type === EventType.RUN_FINISHED) break;
    }

    // A later resume that completes for real, leaving no checkpoint.
    parked = false;
    park();
    const later = await collect(
      agent,
      minimalRunInput({ runId: "run-2", resume: batch }),
    );
    expectNoRunError(later, "resume after an abandoned run");
    const callsAfterLater = streamCalls;

    const replay = await collect(
      agent,
      minimalRunInput({ runId: "run-3", resume: batch }),
    );
    expectNoRunError(replay, "replay of the later resume");
    expect(
      streamCalls,
      "an abandoned run's pause suppressed the later resume, so its replay ran the tool a second time",
    ).toBe(callsAfterLater);
  });

  it("survives a second run starting during the first one's teardown", async () => {
    // The gap that per-thread state cannot cover: the pause is recorded while
    // the run holds its thread and acted on after it lets go, so a run starting
    // in between could consume it and the first run would be remembered as
    // completed while its tool stayed parked. Stepping the first run's iterator
    // by hand puts the second request in exactly that gap, rather than while
    // the thread is still held, where it would simply be refused.
    let streamCalls = 0;
    const stub = scriptedAgent([], {
      stream: (() => {
        streamCalls += 1;
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "interrupt",
            interrupts: [],
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("paused").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);

    const batch = [
      { interruptId: "int-gap", status: "resolved", payload: { a: 1 } },
    ] as never;
    const park = () =>
      parkInterrupts(agent, "thread-1", [
        { id: "int-gap", reason: "need_input" },
      ]);

    park();
    const iterator = agent.run(
      minimalRunInput({ runId: "run-1", resume: batch }),
    );
    let step = await iterator.next();
    while (!step.done && step.value.type !== EventType.RUN_FINISHED) {
      step = await iterator.next();
    }

    // Ask for the value after the finish. That drives the first run's teardown,
    // which releases the thread before its own bookkeeping is settled.
    const teardown = iterator.next();
    await Promise.resolve();
    const overlapping = await collect(
      agent,
      minimalRunInput({ runId: "run-2", resume: batch }),
    );
    await teardown;

    // Whether the overlap was refused or ran depends on where in the teardown
    // it landed, and this holds either way: the first run's pause is its own.
    park();
    const retry = await collect(
      agent,
      minimalRunInput({ runId: "run-3", resume: batch }),
    );
    expectNoRunError(retry, "retry after a run started during teardown");
    const overlapRan = errorCodes(overlapping).length === 0 ? 1 : 0;
    expect(
      streamCalls,
      "a run starting during teardown consumed the first run's pause, so the retry was answered from the fingerprint",
    ).toBe(2 + overlapRan);
  });

  it("keeps the pause off the wire and out of anyone else's reach", async () => {
    // The pause rides on the finish event, which is the object the client gets.
    // Two properties make that safe rather than merely convenient, and both
    // were asserted only in a comment: the key is a symbol, so serialising the
    // event drops it and no consumer or schema sees it; and it is a unique
    // symbol rather than a registry one, so no other code can mint the same key
    // by name. Anything holding the event can of course enumerate its symbols;
    // what matters is that nothing can name this one from outside. Spelling
    // either differently leaves every behavioural test green while publishing
    // an internal flag to every client.
    const stub = scriptedAgent([], {
      stream: (() =>
        (async function* () {
          return new StrandsAgentResult({
            stopReason: "interrupt",
            interrupts: [],
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("paused").toJSON()],
            }),
            invocationState: {},
          });
        })()) as never,
    });
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);
    parkInterrupts(agent, "thread-1", [
      { id: "int-wire", reason: "need_input" },
    ]);

    const events = await collect(
      agent,
      minimalRunInput({
        runId: "run-1",
        resume: [
          { interruptId: "int-wire", status: "resolved", payload: { a: 1 } },
        ] as never,
      }),
    );
    const finished = finishedOf(events) as unknown as object;

    // The premise: this really is the event carrying the pause. Without it the
    // two assertions below hold just as well when nothing was ever set.
    expect(
      Object.getOwnPropertySymbols(finished),
      "this finish is not carrying the pause, so the rest proves nothing",
    ).toHaveLength(1);
    expect(Object.keys(finished).sort()).toEqual([
      "outcome",
      "runId",
      "threadId",
      "type",
    ]);
    expect(JSON.parse(JSON.stringify(finished))).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "thread-1",
      runId: "run-1",
      outcome: { type: "success" },
    });
    const registryOwned = Object.getOwnPropertySymbols(finished).filter(
      (symbol) => Symbol.keyFor(symbol) !== undefined,
    );
    expect(
      registryOwned,
      "the pause is carried on a registry symbol, which any code in the realm can read or forge",
    ).toEqual([]);
  });

  it("reads a missing checkpoint as finished rather than parked", async () => {
    // The SDK always builds a checkpoint object, so this is the state it never
    // produces. It is pinned because the guard reads that object optionally,
    // and a reader who treats absent as parked withholds the fingerprint from
    // every run that has no checkpoint at all. Python pins the same case.
    let stub: Record<string, unknown>;
    const scripted = scriptedAgent([], {
      stream: (() => {
        stub._interruptState = undefined;
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "interrupt",
            interrupts: [],
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("done").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    stub = scripted as unknown as Record<string, unknown>;
    const agent = new StrandsAgent({ agent: scripted, name: "t" });
    const internals = agent as unknown as {
      _agentsByThread: Map<string, unknown>;
      _lastResumeFingerprint: Map<string, string>;
    };
    internals._agentsByThread.set("thread-1", scripted);
    parkInterrupts(agent, "thread-1", [{ id: "int-x", reason: "need_input" }]);

    const events = await collect(
      agent,
      minimalRunInput({
        runId: "run-1",
        resume: [
          { interruptId: "int-x", status: "resolved", payload: { a: 1 } },
        ] as never,
      }),
    );

    expectNoRunError(events, "reported pause with no checkpoint object");
    expect(
      internals._lastResumeFingerprint.get("thread-1"),
      "a run with no checkpoint at all was treated as parked",
    ).toBeDefined();
  });
});

describe("guarantees that were reverting cleanly", () => {
  // Each of these pins a behaviour the change introduced that a reviewer showed
  // could be reverted with the whole suite still green.

  it("publishes no reason when the tool-call binding alone was usable", async () => {
    // The three conditions are tested together at both extremes; this is the
    // middle, where dropping any one of them would start publishing a reason
    // that the other keys already carried.
    const raising = tool({
      name: "bound",
      description: "Raises an approval whose reason holds only a tool use id",
      inputSchema: z.object({}).passthrough(),
      callback: async (_input: unknown, context?: ToolContext) => {
        context!.interrupt({
          name: "ag_ui:tool_call:bound",
          reason: { tool_use_id: "tu-bound" } as never,
        });
        return { ok: true };
      },
    });
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({ toolUseId: "tu-4", name: "bound", input: {} }),
        modelTurn.text("done"),
      ],
      { tools: [raising] },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );
    const interrupt = interruptsOf(events)[0] as {
      toolCallId?: string;
      metadata?: Record<string, unknown>;
    };

    expect(interrupt.toolCallId).toBe("tu-bound");
    expect(Object.keys(interrupt.metadata ?? {}).sort()).toEqual([
      "strandsName",
      "tool_input",
      "tool_name",
    ]);
  });

  it("grants an approval only for a resolved entry", async () => {
    // The wire type admits no third status, so this reaches past it deliberately
    // to pin the guard: anything that is not a resolution denies, rather than
    // forwarding an answer the payload gate never checked.
    const { agent, calls } = approvalRun();
    const first = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );
    const interruptId = interruptsOf(first)[0]!.id;

    const { calls: streamArgs } = captureStreamArgs(agent);
    await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "go" } as never],
        resume: [
          { interruptId, status: "acknowledged", payload: { approved: true } },
        ] as never,
      }),
    );

    const [forwarded] = streamArgs[0]![0] as {
      interruptResponse: { response: unknown };
    }[];
    expect(forwarded!.interruptResponse.response).toEqual({ approved: false });
    expect(calls, "an unrecognised status granted the approval").toEqual([]);
  });

  it("survives a logger that throws while reporting a failed detachment", async () => {
    // A caller-supplied logger is arbitrary code. A throw escaping the warning
    // would turn a successfully raised interrupt into a run error, which is the
    // rule this adapter already states for its other logging.
    const raising = tool({
      name: "hostile_log",
      description: "Raises an approval whose reason cannot be cloned",
      inputSchema: z.object({}).passthrough(),
      callback: async (_input: unknown, context?: ToolContext) => {
        context!.interrupt({
          name: "ag_ui:tool_call:hostile_log",
          reason: { nope: () => undefined } as never,
        });
        return { ok: true };
      },
    });
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({
          toolUseId: "tu-2",
          name: "hostile_log",
          input: {},
        }),
        modelTurn.text("done"),
      ],
      {
        tools: [raising],
        config: {
          logger: {
            debug: () => {},
            // Only the detachment warning throws. A logger that threw on
            // everything would break unrelated logging this change does not
            // own, and the assertion below would stop being about this fix.
            warn: (m: string) => {
              if (m.includes("could not detach")) {
                throw new Error("logger blew up");
              }
            },
            error: () => {},
          },
        },
      },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );

    expectNoRunError(events, "raised interrupt with a throwing logger");
    expect(interruptsOf(events)[0]!.reason).toBe("tool_call");
  });

  it("says so when a reason cannot be detached for publication", async () => {
    // The fallback publishes a value still shared with the live checkpoint, so
    // the one thing it must not do is go unmentioned.
    const warnings: string[] = [];
    const raising = tool({
      name: "unclonable",
      description:
        "Raises an approval whose reason cannot be structured-cloned",
      inputSchema: z.object({}).passthrough(),
      callback: async (_input: unknown, context?: ToolContext) => {
        context!.interrupt({
          name: "ag_ui:tool_call:unclonable",
          reason: { nope: () => undefined } as never,
        });
        return { ok: true };
      },
    });
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({ toolUseId: "tu-3", name: "unclonable", input: {} }),
        modelTurn.text("done"),
      ],
      {
        tools: [raising],
        config: {
          logger: {
            debug: () => {},
            warn: (m: string) => warnings.push(m),
            error: () => {},
          },
        },
      },
    );
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );

    expect(
      warnings.some((w) => w.includes("could not detach an interrupt reason")),
      "a reason was published undetached with no warning",
    ).toBe(true);
  });
});
