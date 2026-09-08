import { vi } from "vitest";
import { EventType, RunFinishedEventSchema } from "@ag-ui/client";
import {
  FakeLocalAgent,
  FakeRemoteAgent,
  FakeMemory,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
  collectError,
} from "./helpers";
import { MastraAgent } from "../mastra";

// ---------------------------------------------------------------------------
// Shared chunk fixtures
// ---------------------------------------------------------------------------

function makeSuspendChunks(toolCallId = "tc-1", toolName = "process-expense") {
  return [
    {
      type: "tool-call",
      payload: {
        toolCallId,
        toolName,
        args: { amount: 250, description: "team dinner" },
      },
    },
    {
      type: "tool-call-suspended",
      payload: {
        toolCallId,
        toolName,
        suspendPayload: { reason: "Amount exceeds $100" },
        args: { amount: 250, description: "team dinner" },
        resumeSchema:
          '{"type":"object","properties":{"approved":{"type":"boolean"}}}',
      },
    },
  ];
}

function makeResumeInput(
  interruptEvent: Record<string, any>,
  resumeData: unknown = { approved: true },
) {
  return makeInput({
    forwardedProps: {
      command: {
        resume: resumeData,
        interruptEvent: JSON.stringify(interruptEvent),
      },
    },
  });
}

function makeFakeLocalAgentWithResumeStream(resumeChunks: any[]) {
  const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
  const calls: Array<{ resumeData: any; opts: any }> = [];

  (fakeAgent as any).resumeStream = async (resumeData: any, opts: any) => {
    calls.push({ resumeData, opts });
    return {
      fullStream: (async function* () {
        for (const chunk of resumeChunks) yield chunk;
      })(),
    };
  };

  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fakeAgent as any,
    resourceId: "resource-1",
  });

  return { agent, fakeAgent, calls };
}

// Same as makeFakeLocalAgentWithResumeStream but with emitInterruptOutcome on,
// for exercising the standard outcome on the resume path.
function makeFakeLocalAgentWithResumeStreamOptIn(resumeChunks: any[]) {
  const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
  const calls: Array<{ resumeData: any; opts: any }> = [];

  (fakeAgent as any).resumeStream = async (resumeData: any, opts: any) => {
    calls.push({ resumeData, opts });
    return {
      fullStream: (async function* () {
        for (const chunk of resumeChunks) yield chunk;
      })(),
    };
  };

  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fakeAgent as any,
    resourceId: "resource-1",
    emitInterruptOutcome: true,
  });

  return { agent, fakeAgent, calls };
}

// Remote analogue: the FakeRemoteAgent replays resumeChunks through
// resumeStream's processDataStream (callback-based), matching @mastra/client-js.
function makeFakeRemoteAgentWithResumeStream(resumeChunks: any[]) {
  const fakeAgent = new FakeRemoteAgent({ streamChunks: [], resumeChunks });
  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fakeAgent as any,
    resourceId: "resource-1",
  });
  return { agent, fakeAgent, calls: fakeAgent.resumeCalls };
}

// ---------------------------------------------------------------------------
// Emit path
// ---------------------------------------------------------------------------

describe("interrupt bridge: emit path", () => {
  describe("tool-call-suspended → on_interrupt", () => {
    it("emits exactly RUN_STARTED, CUSTOM, RUN_FINISHED — no TOOL_CALL events", async () => {
      const agent = makeLocalMastraAgent({ streamChunks: makeSuspendChunks() });
      const events = await collectEvents(agent, makeInput());

      // This tests the full event sequence, not just "is CUSTOM present"
      const types = events.map((e) => e.type);
      expect(types).toEqual([
        EventType.RUN_STARTED,
        EventType.CUSTOM,
        EventType.RUN_FINISHED,
      ]);
    });

    it("interrupt value contains all fields needed for round-trip resume", async () => {
      const agent = makeLocalMastraAgent({ streamChunks: makeSuspendChunks() });
      const events = await collectEvents(agent, makeInput({ runId: "run-42" }));

      const event = events.find((e) => e.type === EventType.CUSTOM) as any;
      expect(event.name).toBe("on_interrupt");

      // CustomEvent.value is typed as string in AG-UI protocol (also matches LangGraph convention)
      expect(typeof event.value).toBe("string");

      const value = JSON.parse(event.value);
      // These four fields are required by the resume path
      expect(value).toMatchObject({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        toolName: "process-expense",
        runId: "run-42",
      });
      // suspend-specific fields
      expect(value.suspendPayload).toEqual({ reason: "Amount exceeds $100" });
      expect(value.resumeSchema).toBeDefined();
    });

    it("works identically for remote agents", async () => {
      const localEvents = await collectEvents(
        makeLocalMastraAgent({ streamChunks: makeSuspendChunks() }),
        makeInput(),
      );
      const remoteEvents = await collectEvents(
        makeRemoteMastraAgent({ streamChunks: makeSuspendChunks() }),
        makeInput(),
      );

      // Same event types in same order
      expect(localEvents.map((e) => e.type)).toEqual(
        remoteEvents.map((e) => e.type),
      );

      // Same interrupt value
      const localValue = (
        localEvents.find((e) => e.type === EventType.CUSTOM) as any
      ).value;
      const remoteValue = (
        remoteEvents.find((e) => e.type === EventType.CUSTOM) as any
      ).value;
      expect(JSON.parse(localValue).type).toBe(JSON.parse(remoteValue).type);
      expect(JSON.parse(localValue).toolCallId).toBe(
        JSON.parse(remoteValue).toolCallId,
      );
    });
  });

  describe("tool-call-suspended WITHOUT preceding tool-call", () => {
    it("emits interrupt even when no tool-call chunk precedes it", async () => {
      // Defensive: handle tool-call-suspended even without a preceding tool-call chunk
      const agent = makeLocalMastraAgent({
        streamChunks: [
          {
            type: "tool-call-suspended",
            payload: {
              toolCallId: "tc-orphan",
              toolName: "orphan-tool",
              suspendPayload: {},
              args: {},
              resumeSchema: "{}",
            },
          },
        ],
      });

      const events = await collectEvents(agent, makeInput());
      const customEvents = events.filter((e) => e.type === EventType.CUSTOM);
      expect(customEvents).toHaveLength(1);
      expect(JSON.parse((customEvents[0] as any).value).toolCallId).toBe(
        "tc-orphan",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Standard interrupt-outcome path (opt-in: emitInterruptOutcome)
// ---------------------------------------------------------------------------

describe("interrupt bridge: standard RUN_FINISHED.outcome (opt-in)", () => {
  describe("flag explicitly OFF — legacy unchanged", () => {
    it("emits a plain RUN_FINISHED with no outcome", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: makeSuspendChunks(),
        emitInterruptOutcome: false,
      });
      const events = await collectEvents(agent, makeInput());

      // Same event sequence as before the flag existed.
      expect(events.map((e) => e.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.CUSTOM,
        EventType.RUN_FINISHED,
      ]);

      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      // Legacy: no structured outcome attached.
      expect(finished.outcome).toBeUndefined();
    });

    it("still emits the legacy on_interrupt CUSTOM event", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: makeSuspendChunks(),
        emitInterruptOutcome: false,
      });
      const events = await collectEvents(agent, makeInput());

      const custom = events.find((e) => e.type === EventType.CUSTOM) as any;
      expect(custom.name).toBe("on_interrupt");
      expect(JSON.parse(custom.value).type).toBe("mastra_suspend");
    });

    it("default constructor enables emitInterruptOutcome", () => {
      const agent = makeLocalMastraAgent({ streamChunks: [] });
      expect(agent.emitInterruptOutcome).toBe(true);
    });
  });

  describe("flag ON — structured outcome emitted alongside legacy event", () => {
    it("emits RUN_FINISHED with outcome={type:'interrupt', interrupts:[...]}", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: makeSuspendChunks(),
        emitInterruptOutcome: true,
      });
      const events = await collectEvents(agent, makeInput());

      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      expect(finished.outcome).toBeDefined();
      expect(finished.outcome.type).toBe("interrupt");
      expect(finished.outcome.interrupts).toHaveLength(1);
    });

    it("still emits the legacy on_interrupt CUSTOM event (wrapper stays)", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: makeSuspendChunks(),
        emitInterruptOutcome: true,
      });
      const events = await collectEvents(agent, makeInput());

      // BOTH channels: legacy CUSTOM and the structured outcome on RUN_FINISHED.
      expect(events.map((e) => e.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.CUSTOM,
        EventType.RUN_FINISHED,
      ]);
      const custom = events.find((e) => e.type === EventType.CUSTOM) as any;
      expect(custom.name).toBe("on_interrupt");
    });

    it("maps the suspend payload to a valid Interrupt (round-trip fields preserved)", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: makeSuspendChunks("tc-1", "process-expense"),
        emitInterruptOutcome: true,
      });
      const events = await collectEvents(agent, makeInput({ runId: "run-42" }));

      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      const interrupt = finished.outcome.interrupts[0];

      // id encodes the snapshot runId + tool call id (`${runId}::${toolCallId}`)
      // so a standard-path client round-trips the runId back via interruptId.
      expect(interrupt.id).toBe("run-42::tc-1");
      expect(interrupt.toolCallId).toBe("tc-1");
      expect(interrupt.reason).toBe("mastra:tool_suspend");
      // resumeSchema (a JSON string) is parsed into responseSchema.
      expect(interrupt.responseSchema).toEqual({
        type: "object",
        properties: { approved: { type: "boolean" } },
      });
      // Everything resume needs lives under metadata.mastra, shaped like the
      // legacy on_interrupt value.
      expect(interrupt.metadata.mastra).toMatchObject({
        type: "mastra_suspend",
        toolName: "process-expense",
        suspendPayload: { reason: "Amount exceeds $100" },
        args: { amount: 250, description: "team dinner" },
        runId: "run-42",
      });
    });

    it("validates against the canonical RunFinishedEventSchema", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: makeSuspendChunks(),
        emitInterruptOutcome: true,
      });
      const events = await collectEvents(agent, makeInput());
      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;

      // The emitted event must parse cleanly through the protocol schema —
      // proves the outcome shape is wire-valid, not just structurally similar.
      expect(() => RunFinishedEventSchema.parse(finished)).not.toThrow();
    });

    it("carries the snapshot-keying runId from the suspend chunk, not RunAgentInput.runId", async () => {
      // Mastra keys the suspended snapshot by the runId on the SUSPEND CHUNK,
      // which can differ from RunAgentInput.runId. The interrupt metadata must
      // carry the chunk's runId so resume round-trips the right id.
      const chunks = [
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-1",
            toolName: "t",
            suspendPayload: {},
            args: {},
            resumeSchema: "{}",
            runId: "mastra-internal-run",
          },
        },
      ];
      const agent = makeLocalMastraAgent({
        streamChunks: chunks,
        emitInterruptOutcome: true,
      });
      const events = await collectEvents(
        agent,
        makeInput({ runId: "agui-run" }),
      );

      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      // Top-level RUN_FINISHED.runId stays the AG-UI run id.
      expect(finished.runId).toBe("agui-run");
      // But the snapshot-keying id is preserved in metadata for resume.
      expect(finished.outcome.interrupts[0].metadata.mastra.runId).toBe(
        "mastra-internal-run",
      );
    });

    it("collects multiple suspends into one outcome", async () => {
      const chunks = [
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-x",
            toolName: "x",
            suspendPayload: {},
            args: {},
            resumeSchema: "{}",
          },
        },
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-y",
            toolName: "y",
            suspendPayload: {},
            args: {},
            resumeSchema: "{}",
          },
        },
      ];
      const agent = makeLocalMastraAgent({
        streamChunks: chunks,
        emitInterruptOutcome: true,
      });
      const events = await collectEvents(agent, makeInput());

      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      // ids encode the snapshot runId (AG-UI run id here, chunks carry none).
      expect(finished.outcome.interrupts.map((i: any) => i.id)).toEqual([
        "run-1::tc-x",
        "run-1::tc-y",
      ]);
      expect(finished.outcome.interrupts.map((i: any) => i.toolCallId)).toEqual(
        ["tc-x", "tc-y"],
      );
      // Two legacy CUSTOM events too.
      expect(events.filter((e) => e.type === EventType.CUSTOM)).toHaveLength(2);
    });

    it("omits responseSchema when resumeSchema is not valid JSON", async () => {
      const chunks = [
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-1",
            toolName: "t",
            suspendPayload: {},
            args: {},
            resumeSchema: "not-json",
          },
        },
      ];
      const agent = makeLocalMastraAgent({
        streamChunks: chunks,
        emitInterruptOutcome: true,
      });
      const events = await collectEvents(agent, makeInput());

      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      const interrupt = finished.outcome.interrupts[0];
      expect(interrupt.responseSchema).toBeUndefined();
      // Raw value still available in metadata for debugging.
      expect(interrupt.metadata.mastra.resumeSchema).toBe("not-json");
    });

    it("a non-interrupting run still ends with a plain RUN_FINISHED (no outcome)", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: [{ type: "text-delta", payload: { text: "hi" } }],
        emitInterruptOutcome: true,
      });
      const events = await collectEvents(agent, makeInput());

      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      // Flag on but nothing suspended → no outcome attached.
      expect(finished.outcome).toBeUndefined();
    });

    it("attaches outcome on the resume path when the resumed stream suspends again", async () => {
      const { agent } = makeFakeLocalAgentWithResumeStreamOptIn([
        { type: "text-delta", payload: { text: "Processing..." } },
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-chained",
            toolName: "next-step",
            suspendPayload: { step: 2 },
            args: {},
            resumeSchema: "{}",
          },
        },
      ]);

      const events = await collectEvents(
        agent,
        makeResumeInput({
          type: "mastra_suspend",
          toolCallId: "tc-1",
          runId: "run-1",
        }),
      );

      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      expect(finished.outcome?.type).toBe("interrupt");
      // Chained suspend in the resumed run; chunk carries no runId, so the id
      // encodes the resumed run's AG-UI runId.
      expect(finished.outcome.interrupts[0].id).toBe("run-1::tc-chained");
      expect(finished.outcome.interrupts[0].toolCallId).toBe("tc-chained");
    });

    it("works for remote agents too", async () => {
      const agent = makeRemoteMastraAgent({
        streamChunks: makeSuspendChunks(),
        emitInterruptOutcome: true,
      });
      const events = await collectEvents(agent, makeInput());

      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      expect(finished.outcome?.type).toBe("interrupt");
      expect(finished.outcome.interrupts).toHaveLength(1);
    });
  });

  describe("standard resume channel (RunAgentInput.resume)", () => {
    it("resumes from input.resume, decoding runId::toolCallId from interruptId", async () => {
      // Canonical-path client (CopilotKit >= 1.61.2) drives resume via
      // RunAgentInput.resume, NOT forwardedProps.command. The interruptId is the
      // id we emitted (`${runId}::${toolCallId}`), so the bridge decodes both.
      const { agent, calls } = makeFakeLocalAgentWithResumeStream([
        { type: "text-delta", payload: { text: "Approved." } },
      ]);

      const events = await collectEvents(
        agent,
        makeInput({
          resume: [
            {
              interruptId: "mastra-run-xyz::tc-1",
              status: "resolved",
              payload: { approved: true },
            },
          ],
        } as any),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].resumeData).toEqual({ approved: true });
      expect(calls[0].opts.toolCallId).toBe("tc-1");
      // runId decoded from the interruptId, not RunAgentInput.runId.
      expect(calls[0].opts.runId).toBe("mastra-run-xyz");
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("treats a cancelled ResumeEntry as a decline (no resumeStream call)", async () => {
      const { agent, calls } = makeFakeLocalAgentWithResumeStream([]);

      const events = await collectEvents(
        agent,
        makeInput({
          resume: [
            { interruptId: "r::tc-1", status: "cancelled", payload: null },
          ],
        } as any),
      );

      expect(calls).toHaveLength(0);
      const types = events.map((e) => e.type);
      expect(types).toContain(EventType.RUN_STARTED);
      expect(types).toContain(EventType.RUN_FINISHED);
    });

    it("round-trips over a remote agent's resumeStream", async () => {
      const { agent, calls } = makeFakeRemoteAgentWithResumeStream([
        { type: "text-delta", payload: { text: "Done." } },
      ]);

      const events = await collectEvents(
        agent,
        makeInput({
          resume: [
            {
              interruptId: "mastra-run-remote::tc-9",
              status: "resolved",
              payload: { chosen_time: "2pm" },
            },
          ],
        } as any),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].opts.toolCallId).toBe("tc-9");
      expect(calls[0].opts.runId).toBe("mastra-run-remote");
      expect(
        events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK),
      ).toHaveLength(1);
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("legacy forwardedProps.command takes precedence over input.resume", async () => {
      // If both arrive, the legacy command wins (we only fall back to
      // input.resume when no command interruptEvent is present).
      const { agent, calls } = makeFakeLocalAgentWithResumeStream([
        { type: "text-delta", payload: { text: "ok" } },
      ]);

      await collectEvents(
        agent,
        makeInput({
          resume: [
            {
              interruptId: "decoded-run::decoded-tc",
              status: "resolved",
              payload: { from: "standard" },
            },
          ],
          forwardedProps: {
            command: {
              resume: { from: "legacy" },
              interruptEvent: JSON.stringify({
                type: "mastra_suspend",
                toolCallId: "legacy-tc",
                runId: "legacy-run",
              }),
            },
          },
        } as any),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].opts.toolCallId).toBe("legacy-tc");
      expect(calls[0].opts.runId).toBe("legacy-run");
      expect(calls[0].resumeData).toEqual({ from: "legacy" });
    });
  });
});

// ---------------------------------------------------------------------------
// Tool-call buffering
// ---------------------------------------------------------------------------

describe("interrupt bridge: tool-call buffering", () => {
  it("preserves normal tool-call → tool-result flow", async () => {
    const chunks = [
      {
        type: "tool-call",
        payload: {
          toolCallId: "tc-3",
          toolName: "get-weather",
          args: { city: "NYC" },
        },
      },
      {
        type: "tool-result",
        payload: { toolCallId: "tc-3", result: { temp: 72 } },
      },
    ];

    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    const toolTypes = events
      .filter((e) =>
        [
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
        ].includes(e.type),
      )
      .map((e) => e.type);

    expect(toolTypes).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);
    expect(events.filter((e) => e.type === EventType.CUSTOM)).toHaveLength(0);
  });

  it("flushes buffered tool-call at end of stream when nothing follows", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-4",
            toolName: "fire-and-forget",
            args: {},
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_START),
    ).toHaveLength(1);
  });

  it("only suppresses the immediately preceding tool-call, not earlier ones", async () => {
    // tool-call A (normal) → tool-result A → tool-call B → tool-call-suspended B
    // A should be emitted, B should be suppressed
    const chunks = [
      {
        type: "tool-call",
        payload: { toolCallId: "tc-a", toolName: "tool-a", args: {} },
      },
      { type: "tool-result", payload: { toolCallId: "tc-a", result: "ok" } },
      {
        type: "tool-call",
        payload: { toolCallId: "tc-b", toolName: "tool-b", args: {} },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-b",
          toolName: "tool-b",
          suspendPayload: {},
          args: {},
          resumeSchema: "{}",
        },
      },
    ];

    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    // tool-a's START/ARGS/END/RESULT should be emitted
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as any).toolCallId).toBe("tc-a");

    // tool-b should be suppressed — only the interrupt
    const customEvents = events.filter((e) => e.type === EventType.CUSTOM);
    expect(customEvents).toHaveLength(1);
    expect(JSON.parse((customEvents[0] as any).value).toolCallId).toBe("tc-b");
  });

  it("remote error chunk stops processing — no post-error events emitted", async () => {
    const chunks = [
      { type: "text-delta", payload: { text: "before" } },
      { type: "error", payload: { error: "something went wrong" } },
      { type: "text-delta", payload: { text: "after" } },
    ];

    const agent = makeRemoteMastraAgent({ streamChunks: chunks });
    const { error, events } = await collectError(agent, makeInput());

    expect(error.message).toBe("something went wrong");

    // Only RUN_STARTED + the pre-error text chunk — no post-error text
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("before");
  });

  it("local error chunk does not trigger post-error onRunFinished work", async () => {
    const memory = new FakeMemory();
    let getWorkingMemoryCalled = false;
    // Track whether emitWorkingMemorySnapshot runs post-error
    memory.getWorkingMemory = async () => {
      getWorkingMemoryCalled = true;
      return JSON.stringify({ state: "data" });
    };

    const chunks = [
      { type: "text-delta", payload: { text: "before" } },
      { type: "error", payload: { error: "local agent failed" } },
    ];

    const agent = makeLocalMastraAgent({ memory, streamChunks: chunks });
    const { error } = await collectError(agent, makeInput());

    expect(error.message).toBe("local agent failed");

    // Allow any pending async work (onRunFinished) to settle
    await new Promise((r) => setTimeout(r, 50));

    // emitWorkingMemorySnapshot should NOT run after an error chunk
    expect(getWorkingMemoryCalled).toBe(false);
  });

  it("remote error chunk does not trigger post-error onRunFinished work", async () => {
    // Remote agents don't have memory, so we verify no RUN_FINISHED is attempted
    // by checking the subscriber only received events before the error
    const chunks = [
      { type: "text-delta", payload: { text: "before" } },
      { type: "error", payload: { error: "remote agent failed" } },
      { type: "text-delta", payload: { text: "after" } },
    ];

    const agent = makeRemoteMastraAgent({ streamChunks: chunks });
    const { error, events } = await collectError(agent, makeInput());

    expect(error.message).toBe("remote agent failed");
    // Only RUN_STARTED + one text chunk before error — no post-error events
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_CHUNK,
    ]);
  });

  it("discards pending tool-call when tool-call-suspended has different toolCallId (no orphaned emit)", async () => {
    // tool-call(tc-A) → tool-call-suspended(tc-B): tc-A never executed,
    // so emitting TOOL_CALL_START/ARGS/END without a TOOL_CALL_RESULT is
    // a protocol violation. tc-A must be silently discarded.
    const chunks = [
      {
        type: "tool-call",
        payload: { toolCallId: "tc-A", toolName: "tool-a", args: { x: 1 } },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-B",
          toolName: "tool-b",
          suspendPayload: {},
          args: {},
          resumeSchema: "{}",
        },
      },
    ];

    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    // tc-A must NOT be emitted — no TOOL_CALL events at all
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStarts).toHaveLength(0);

    // tc-B's suspend should still produce an interrupt
    const customEvents = events.filter((e) => e.type === EventType.CUSTOM);
    expect(customEvents).toHaveLength(1);
    expect(JSON.parse((customEvents[0] as any).value).toolCallId).toBe("tc-B");
  });

  it("handles multiple tool-call-suspended events in one stream", async () => {
    // Two different tools both get suspended in the same stream
    const chunks = [
      {
        type: "tool-call",
        payload: { toolCallId: "tc-x", toolName: "tool-x", args: { a: 1 } },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-x",
          toolName: "tool-x",
          suspendPayload: { step: 1 },
          args: { a: 1 },
          resumeSchema: "{}",
        },
      },
      {
        type: "tool-call",
        payload: { toolCallId: "tc-y", toolName: "tool-y", args: { b: 2 } },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-y",
          toolName: "tool-y",
          suspendPayload: { step: 2 },
          args: { b: 2 },
          resumeSchema: "{}",
        },
      },
    ];

    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    // Both tool-calls should be suppressed
    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_START),
    ).toHaveLength(0);

    // Both suspensions should produce CUSTOM events
    const customEvents = events.filter((e) => e.type === EventType.CUSTOM);
    expect(customEvents).toHaveLength(2);
    expect(JSON.parse((customEvents[0] as any).value).toolCallId).toBe("tc-x");
    expect(JSON.parse((customEvents[1] as any).value).toolCallId).toBe("tc-y");
  });

  it("skips (does not abort on) a chunk with no payload (#1635)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta" }, // missing payload
        { type: "finish", payload: { finishReason: "stop" } },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping stream chunk without payload"),
    );
    warnSpy.mockRestore();
  });

  it("skips (does not abort on) a null chunk (#1635)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeLocalMastraAgent({
      streamChunks: [
        null,
        { type: "finish", payload: { finishReason: "stop" } },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping stream chunk without payload"),
    );
    warnSpy.mockRestore();
  });

  it("errors when tool-call-suspended payload is missing toolCallId", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call-suspended",
          payload: {
            toolName: "some-tool",
            suspendPayload: {},
            args: {},
            resumeSchema: "{}",
          },
        },
      ],
    });

    const { error, events } = await collectError(agent, makeInput());

    expect(error.message).toContain("Malformed tool-call-suspended");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("ignores unrecognized chunk types without crashing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "hello" } },
        { type: "unknown-future-type", payload: { data: 123 } },
        { type: "text-delta", payload: { text: " world" } },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    // Both text chunks should be emitted — the unknown chunk is skipped
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(2);

    // A warning should be logged for the unknown chunk type
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown-future-type"),
    );

    warnSpy.mockRestore();
  });

  it("buffers correctly for remote agents (processDataStream path)", async () => {
    const chunks = [
      {
        type: "tool-call",
        payload: { toolCallId: "tc-r", toolName: "remote-tool", args: {} },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-r",
          toolName: "remote-tool",
          suspendPayload: {},
          args: {},
          resumeSchema: "{}",
        },
      },
    ];

    const agent = makeRemoteMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_START),
    ).toHaveLength(0);
    expect(events.filter((e) => e.type === EventType.CUSTOM)).toHaveLength(1);
  });

  it("flushes buffered tool-call when text-delta arrives between tool-call and tool-call-suspended", async () => {
    // tool-call(tc-1) → text-delta → tool-call-suspended(tc-1)
    // The text-delta flushes the buffered tool-call, so tc-1 IS emitted.
    // The suspend still emits a CUSTOM event (no matching pending to suppress).
    const chunks = [
      {
        type: "tool-call",
        payload: { toolCallId: "tc-1", toolName: "slow-tool", args: { x: 1 } },
      },
      { type: "text-delta", payload: { text: "Processing..." } },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-1",
          toolName: "slow-tool",
          suspendPayload: {},
          args: { x: 1 },
          resumeSchema: "{}",
        },
      },
    ];

    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    // tc-1 was flushed by the text-delta, so TOOL_CALL_START is present
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as any).toolCallId).toBe("tc-1");

    // text-delta was emitted
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("Processing...");

    // The suspend still produces an interrupt
    const customEvents = events.filter((e) => e.type === EventType.CUSTOM);
    expect(customEvents).toHaveLength(1);
    expect(JSON.parse((customEvents[0] as any).value).toolCallId).toBe("tc-1");
  });
});

// ---------------------------------------------------------------------------
// Resume path
// ---------------------------------------------------------------------------

describe("interrupt bridge: resume path", () => {
  it("calls resumeStream with correct args for mastra_suspend on local agent", async () => {
    const { agent, calls } = makeFakeLocalAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Expense approved." } },
    ]);

    const events = await collectEvents(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        toolName: "process-expense",
        runId: "original-run-id",
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].resumeData).toEqual({ approved: true });
    expect(calls[0].opts.toolCallId).toBe("tc-1");
    expect(calls[0].opts.runId).toBe("original-run-id");
    expect(calls[0].opts.memory).toEqual({
      thread: "thread-1",
      resource: "resource-1",
    });

    // Verify the resumed stream is actually processed
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("Expense approved.");
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("handles interruptEvent passed as an object (not just JSON string)", async () => {
    const { agent, calls } = makeFakeLocalAgentWithResumeStream([]);

    await collectEvents(
      agent,
      makeInput({
        forwardedProps: {
          command: {
            resume: "yes",
            // Object, not string — adapter should handle both
            interruptEvent: {
              type: "mastra_suspend",
              toolCallId: "tc-obj",
              runId: "run-obj",
            },
          },
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].opts.toolCallId).toBe("tc-obj");
  });

  it("does not enter resume path when interruptEvent is missing", async () => {
    const { agent, calls } = makeFakeLocalAgentWithResumeStream([]);

    await collectEvents(
      agent,
      makeInput({
        forwardedProps: {
          command: { resume: { approved: true } },
        },
      }),
    );

    // Should NOT have called resumeStream — falls through to normal stream
    expect(calls).toHaveLength(0);
  });

  it("treats resume: false as a decline — emits RUN_FINISHED without calling resumeStream", async () => {
    // resume: false means the user declined the tool call. The adapter must
    // NOT forward this to resumeStream (whose handling of `false` is
    // undocumented) — instead it should cleanly close the run.
    const { agent, calls } = makeFakeLocalAgentWithResumeStream([]);

    const events = await collectEvents(
      agent,
      makeInput({
        forwardedProps: {
          command: {
            resume: false,
            interruptEvent: JSON.stringify({
              type: "mastra_suspend",
              toolCallId: "tc-1",
              runId: "run-1",
            }),
          },
        },
      }),
    );

    // resumeStream must NOT be called
    expect(calls).toHaveLength(0);

    // Run should complete cleanly
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("decline path emits STATE_SNAPSHOT before RUN_FINISHED when working memory is available", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    fakeAgent.memory.workingMemoryValue = JSON.stringify({
      status: "pending_review",
    });

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(
      agent,
      makeInput({
        forwardedProps: {
          command: {
            resume: false,
            interruptEvent: JSON.stringify({
              type: "mastra_suspend",
              toolCallId: "tc-1",
              runId: "run-1",
            }),
          },
        },
      }),
    );

    const types = events.map((e) => e.type);

    // STATE_SNAPSHOT should come before RUN_FINISHED
    const snapshotIdx = types.indexOf(EventType.STATE_SNAPSHOT);
    const finishedIdx = types.indexOf(EventType.RUN_FINISHED);
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(finishedIdx).toBeGreaterThan(snapshotIdx);

    const snapshot = events.find(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    ) as any;
    expect(snapshot.snapshot).toEqual({ status: "pending_review" });
  });

  it("does not enter resume path when command.resume is null", async () => {
    const { agent, calls } = makeFakeLocalAgentWithResumeStream([]);

    await collectEvents(
      agent,
      makeInput({
        forwardedProps: {
          command: {
            resume: null,
            interruptEvent: '{"type":"mastra_suspend"}',
          },
        },
      }),
    );

    expect(calls).toHaveLength(0);
  });

  it("handles chained interrupts in resumed stream", async () => {
    // The resumed stream itself emits another tool-call-suspended
    const { agent } = makeFakeLocalAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Processing..." } },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-chained",
          toolName: "next-step",
          suspendPayload: { step: 2 },
          args: {},
          resumeSchema: "{}",
        },
      },
    ]);

    const events = await collectEvents(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    // Should have the chained interrupt as a CUSTOM event
    const customEvents = events.filter((e) => e.type === EventType.CUSTOM);
    expect(customEvents).toHaveLength(1);
    const value = JSON.parse((customEvents[0] as any).value);
    expect(value.toolCallId).toBe("tc-chained");
    expect(value.suspendPayload).toEqual({ step: 2 });
  });

  it("propagates error when resumeStream throws", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    (fakeAgent as any).resumeStream = async () => {
      throw new Error("Resume failed: no snapshot");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error } = await collectError(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toBe("Resume failed: no snapshot");
  });

  it("errors on malformed interruptEvent JSON", async () => {
    const { agent } = makeFakeLocalAgentWithResumeStream([]);

    const { error, events } = await collectError(
      agent,
      makeInput({
        forwardedProps: {
          command: {
            resume: { approved: true },
            interruptEvent: "{not valid json",
          },
        },
      }),
    );

    expect(error.message).toContain("Invalid interruptEvent");
    // Protocol invariant: RUN_STARTED must be emitted before any error
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("errors when interruptEvent is missing toolCallId", async () => {
    const { agent } = makeFakeLocalAgentWithResumeStream([]);

    const { error, events } = await collectError(
      agent,
      makeResumeInput({ type: "mastra_suspend", runId: "run-1" }), // no toolCallId
    );

    expect(error.message).toContain("missing toolCallId or runId");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("errors when interruptEvent is missing runId", async () => {
    const { agent } = makeFakeLocalAgentWithResumeStream([]);

    const { error, events } = await collectError(
      agent,
      makeResumeInput({ type: "mastra_suspend", toolCallId: "tc-1" }), // no runId
    );

    expect(error.message).toContain("missing toolCallId or runId");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("errors when resumeStream returns null", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    (fakeAgent as any).resumeStream = async () => null;

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectError(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toContain(
      "resumeStream returned no valid response (missing fullStream)",
    );
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("emits STATE_SNAPSHOT before RUN_FINISHED when working memory is available", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    fakeAgent.memory.workingMemoryValue = JSON.stringify({
      approved: true,
      notes: "lgtm",
    });

    const calls: Array<{ resumeData: any; opts: any }> = [];
    (fakeAgent as any).resumeStream = async (resumeData: any, opts: any) => {
      calls.push({ resumeData, opts });
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", payload: { text: "Done." } };
        })(),
      };
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    const types = events.map((e) => e.type);
    // STATE_SNAPSHOT must come before RUN_FINISHED
    const snapshotIdx = types.indexOf(EventType.STATE_SNAPSHOT);
    const finishedIdx = types.indexOf(EventType.RUN_FINISHED);

    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(finishedIdx).toBeGreaterThan(snapshotIdx);

    // Verify snapshot content
    const snapshot = events.find(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    ) as any;
    expect(snapshot.snapshot).toEqual({ approved: true, notes: "lgtm" });
  });

  it("still emits RUN_FINISHED when getWorkingMemory throws during resume, and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    // Make getWorkingMemory throw — simulates memory provider failure
    fakeAgent.memory.getWorkingMemory = async () => {
      throw new Error("Memory provider unavailable");
    };

    const calls: Array<{ resumeData: any; opts: any }> = [];
    (fakeAgent as any).resumeStream = async (resumeData: any, opts: any) => {
      calls.push({ resumeData, opts });
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", payload: { text: "Approved." } };
        })(),
      };
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    const types = events.map((e) => e.type);
    // Run should complete — memory failure is non-fatal
    expect(types).toContain(EventType.RUN_FINISHED);
    // But no STATE_SNAPSHOT since memory failed
    expect(types).not.toContain(EventType.STATE_SNAPSHOT);

    // A warning should be logged so operators can detect the issue
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to emit working memory snapshot"),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it("errors when resumeStream returns object without fullStream", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    (fakeAgent as any).resumeStream = async () => ({ text: "done" }); // no fullStream

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error } = await collectError(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toContain("fullStream");
  });

  it("propagates error chunk in resumed stream without RUN_FINISHED", async () => {
    const { agent } = makeFakeLocalAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Approving..." } },
      { type: "error", payload: { error: "LLM rate limited" } },
      { type: "text-delta", payload: { text: "should not appear" } },
    ]);

    const { error, events } = await collectError(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toBe("LLM rate limited");
    // RUN_STARTED should be present, but no RUN_FINISHED or STATE_SNAPSHOT after error
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(
      events.filter((e) => e.type === EventType.RUN_FINISHED),
    ).toHaveLength(0);
    expect(
      events.filter((e) => e.type === EventType.STATE_SNAPSHOT),
    ).toHaveLength(0);
    // Only the pre-error text chunk
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("Approving...");
  });

  it("propagates memory management errors to subscriber", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    fakeAgent.getMemory = async () => {
      throw new Error("Memory provider connection failed");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectError(
      agent,
      makeInput({ state: { someKey: "someValue" } }),
    );

    expect(error.message).toBe("Memory provider connection failed");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("propagates error when local agent .stream() throws (not silently dropped)", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    // Override stream to throw — simulates a network/auth failure
    fakeAgent.stream = async () => {
      throw new Error("Connection refused");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectError(agent, makeInput());

    // The error must reach the subscriber — not be silently swallowed
    expect(error.message).toBe("Connection refused");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("propagates error when remote agent .stream() throws (not silently dropped)", async () => {
    const fakeAgent = new FakeRemoteAgent({ streamChunks: [] });
    // Override stream to throw
    fakeAgent.stream = async () => {
      throw new Error("Remote auth failed");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectError(agent, makeInput());

    expect(error.message).toBe("Remote auth failed");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("errors when a remote agent has no resumeStream capability (old client-js)", async () => {
    // Older @mastra/client-js builds predate agent.resumeStream — the bridge
    // must surface an actionable upgrade error, not a generic crash.
    // Bare remote agent that predates resumeStream: it has stream() (so it's
    // remote, not local — no getMemory) but no resume capability at all.
    const fakeAgent = {
      stream: async () => ({
        processDataStream: async () => {},
      }),
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectError(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toContain("upgrade @mastra/client-js");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("propagates errors thrown before any try-catch in run() to subscriber", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: [] });

    // Create input with a forwardedProps getter that throws — this hits
    // the forwardedProps?.command access before any try-catch in run().
    const input = makeInput();
    Object.defineProperty(input, "forwardedProps", {
      get() {
        throw new Error("Unexpected getter failure");
      },
    });

    const { error } = await collectError(agent, input);
    expect(error.message).toBe("Unexpected getter failure");
  });
});

// ---------------------------------------------------------------------------
// Resume path — remote agents (@mastra/client-js)
// ---------------------------------------------------------------------------

describe("interrupt bridge: remote resume path", () => {
  it("round-trips resume over resumeStream and processes the resumed stream", async () => {
    const { agent, calls } = makeFakeRemoteAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Expense approved." } },
    ]);

    const events = await collectEvents(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        toolName: "process-expense",
        // Mastra keys the snapshot by the suspend chunk's runId — this must be
        // the value round-tripped to the remote resumeStream call.
        runId: "mastra-workflow-run-xyz",
      }),
    );

    // resumeStream called once with the round-tripped runId + toolCallId
    expect(calls).toHaveLength(1);
    expect(calls[0].resumeData).toEqual({ approved: true });
    expect(calls[0].opts.toolCallId).toBe("tc-1");
    expect(calls[0].opts.runId).toBe("mastra-workflow-run-xyz");
    expect(calls[0].opts.memory).toEqual({
      thread: "thread-1",
      resource: "resource-1",
    });

    // The resumed stream is processed and the run finishes
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("Expense approved.");
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("produces an identical event sequence to a local resume", async () => {
    const resumeChunks = [{ type: "text-delta", payload: { text: "Done." } }];

    const localEvents = await collectEvents(
      makeFakeLocalAgentWithResumeStream(resumeChunks).agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );
    const remoteEvents = await collectEvents(
      makeFakeRemoteAgentWithResumeStream(resumeChunks).agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    // Local emits no STATE/MESSAGES snapshot here (no working memory set), so
    // the sequences match exactly: RUN_STARTED, TEXT_MESSAGE_CHUNK, RUN_FINISHED.
    expect(remoteEvents.map((e) => e.type)).toEqual(
      localEvents.map((e) => e.type),
    );
    expect(remoteEvents.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_CHUNK,
      EventType.RUN_FINISHED,
    ]);
  });

  it("handles chained interrupts in the resumed remote stream", async () => {
    const { agent } = makeFakeRemoteAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Processing..." } },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-chained",
          toolName: "next-step",
          suspendPayload: { step: 2 },
          args: {},
          resumeSchema: "{}",
        },
      },
    ]);

    const events = await collectEvents(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    const customEvents = events.filter((e) => e.type === EventType.CUSTOM);
    expect(customEvents).toHaveLength(1);
    const value = JSON.parse((customEvents[0] as any).value);
    expect(value.toolCallId).toBe("tc-chained");
    expect(value.suspendPayload).toEqual({ step: 2 });
  });

  it("propagates an error chunk in the resumed remote stream without RUN_FINISHED", async () => {
    const { agent } = makeFakeRemoteAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Approving..." } },
      { type: "error", payload: { error: "LLM rate limited" } },
      { type: "text-delta", payload: { text: "should not appear" } },
    ]);

    const { error, events } = await collectError(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toBe("LLM rate limited");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(
      events.filter((e) => e.type === EventType.RUN_FINISHED),
    ).toHaveLength(0);
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("Approving...");
  });

  it("propagates an error when remote resumeStream throws", async () => {
    const fakeAgent = new FakeRemoteAgent({ streamChunks: [] });
    (fakeAgent as any).resumeStream = async () => {
      throw new Error("No snapshot found for this workflow run");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error } = await collectError(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toBe("No snapshot found for this workflow run");
  });

  it("errors when remote resumeStream returns no processDataStream", async () => {
    const fakeAgent = new FakeRemoteAgent({ streamChunks: [] });
    (fakeAgent as any).resumeStream = async () => ({ text: "done" });

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectError(
      agent,
      makeResumeInput({
        type: "mastra_suspend",
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toContain("processDataStream");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("treats resume: false as a decline for remote agents — no resumeStream call", async () => {
    const fakeAgent = new FakeRemoteAgent({ streamChunks: [] });

    const events = await collectEvents(
      new MastraAgent({
        agentId: "test-agent",
        agent: fakeAgent as any,
        resourceId: "resource-1",
      }),
      makeInput({
        forwardedProps: {
          command: {
            resume: false,
            interruptEvent: JSON.stringify({
              type: "mastra_suspend",
              toolCallId: "tc-1",
              runId: "run-1",
            }),
          },
        },
      }),
    );

    expect(fakeAgent.resumeCalls).toHaveLength(0);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });
});

// ---------------------------------------------------------------------------
// Native useInterrupt round-trip (behavioral contract)
// ---------------------------------------------------------------------------

// These tests lock the behavioral contract the CopilotKit v2 `useInterrupt`
// hook relies on, end-to-end against the real bridge. The Mastra payload keeps
// its own shape (`{ toolName, suspendPayload, resumeSchema, toolCallId, runId }`)
// — it does NOT mirror LangGraph's raw-value shape byte-for-byte. What matters
// is the *behavior*: agent suspends → frontend reads the payload + renders →
// user responds → run resumes. See OSS-88.
//
// The hook (packages/react-core/src/v2/hooks/use-interrupt.tsx):
//   - captures the `on_interrupt` CUSTOM event, exposing `event.value` (a JSON
//     string) to the consumer's `render`/`enabled` callbacks, and
//   - on resolve, re-runs the agent with
//     `forwardedProps.command = { resume, interruptEvent: event.value }`.
// So the value MUST (a) carry the suspend payload a renderer needs and (b)
// carry `toolCallId` + `runId` so the round-tripped `interruptEvent` lets the
// bridge resume the suspended Mastra run.
describe("interrupt bridge: native useInterrupt round-trip", () => {
  it("on_interrupt value carries the render payload (suspendPayload + toolName) the hook exposes", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            args: { topic: "Intro with sales" },
          },
        },
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            suspendPayload: { topic: "Intro with sales", attendee: "Alice" },
            args: { topic: "Intro with sales" },
            resumeSchema:
              '{"type":"object","properties":{"chosen_time":{"type":"string"}}}',
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput({ runId: "run-A" }));
    const custom = events.find((e) => e.type === EventType.CUSTOM) as any;
    expect(custom.name).toBe("on_interrupt");

    // The hook hands `event.value` (a string) to render/enabled verbatim.
    // A renderer parses it and reads the suspend payload to draw its UI; the
    // `enabled` predicate reads `toolName` to route between multiple tools.
    expect(typeof custom.value).toBe("string");
    const parsed = JSON.parse(custom.value);
    expect(parsed.toolName).toBe("schedule_meeting");
    expect(parsed.suspendPayload).toEqual({
      topic: "Intro with sales",
      attendee: "Alice",
    });
  });

  it("resumes the suspended run when the hook round-trips event.value as interruptEvent", async () => {
    // One agent plays both halves of the round-trip: the first run() suspends,
    // the second run() (the hook's resolve) resumes.
    const fakeAgent = new FakeLocalAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            args: { topic: "Intro with sales" },
          },
        },
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            suspendPayload: { topic: "Intro with sales", attendee: "Alice" },
            args: { topic: "Intro with sales" },
            resumeSchema: "{}",
          },
        },
      ],
    });
    const resumeCalls: Array<{ resumeData: any; opts: any }> = [];
    (fakeAgent as any).resumeStream = async (resumeData: any, opts: any) => {
      resumeCalls.push({ resumeData, opts });
      return {
        fullStream: (async function* () {
          yield {
            type: "text-delta",
            payload: { text: "Booked for 2pm Tuesday." },
          };
        })(),
      };
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    // 1) First run suspends and emits on_interrupt.
    const suspendEvents = await collectEvents(
      agent,
      makeInput({ runId: "run-A" }),
    );
    const custom = suspendEvents.find(
      (e) => e.type === EventType.CUSTOM,
    ) as any;
    // `event.value` is the exact (string) value the hook keeps and replays.
    const interruptEventValue: string = custom.value;

    // 2) The hook resolves with the user's picked slot, replaying the
    // untouched `event.value` as `interruptEvent` (use-interrupt.tsx).
    const resumeEvents = await collectEvents(
      agent,
      makeInput({
        runId: "run-B",
        forwardedProps: {
          command: {
            resume: {
              chosen_time: "2026-07-01T14:00",
              chosen_label: "2pm Tue",
            },
            interruptEvent: interruptEventValue,
          },
        },
      }),
    );

    // Bridge pulled toolCallId + runId out of the replayed value and resumed
    // the original suspended run — not a fresh one.
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0].opts.toolCallId).toBe("tc-sched");
    expect(resumeCalls[0].opts.runId).toBe("run-A");
    expect(resumeCalls[0].resumeData).toEqual({
      chosen_time: "2026-07-01T14:00",
      chosen_label: "2pm Tue",
    });

    // The resumed stream produced the assistant's confirmation and finished.
    const text = resumeEvents.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;
    expect(text.delta).toBe("Booked for 2pm Tuesday.");
    expect(resumeEvents[resumeEvents.length - 1].type).toBe(
      EventType.RUN_FINISHED,
    );
  });

  it("carries the suspend chunk's runId (not the AG-UI runId) so resume targets Mastra's snapshot", async () => {
    // Mastra keys the suspended workflow snapshot by the run id it reports on
    // the suspend chunk, which can differ from RunAgentInput.runId. The bridge
    // must surface the CHUNK's runId so `resumeStream` finds the snapshot —
    // otherwise resume fails with "No snapshot found for this workflow run".
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call-suspended",
          // chunk-level runId (BaseChunkType) is Mastra's actual run id.
          runId: "mastra-workflow-run-xyz",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            suspendPayload: { topic: "Sync" },
            args: {},
            resumeSchema: "{}",
          },
        },
      ],
    });

    // The AG-UI input runId is deliberately different.
    const events = await collectEvents(
      agent,
      makeInput({ runId: "agui-run-1" }),
    );
    const value = JSON.parse(
      (events.find((e) => e.type === EventType.CUSTOM) as any).value,
    );
    expect(value.runId).toBe("mastra-workflow-run-xyz");
  });

  it("falls back to the AG-UI runId when the suspend chunk omits a runId", async () => {
    // Fake/older streams may not carry a chunk runId — keep the prior behavior.
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            suspendPayload: {},
            args: {},
            resumeSchema: "{}",
          },
        },
      ],
    });

    const events = await collectEvents(
      agent,
      makeInput({ runId: "agui-run-2" }),
    );
    const value = JSON.parse(
      (events.find((e) => e.type === EventType.CUSTOM) as any).value,
    );
    expect(value.runId).toBe("agui-run-2");
  });
});
