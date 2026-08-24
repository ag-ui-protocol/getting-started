/**
 * Regression coverage for the "resume validation happens before session
 * restoration" gap: on a cold process start, `_pendingInterruptsByThread`
 * is empty even though a `sessionManagerProvider`-backed thread may have a
 * genuinely pending native interrupt restored from persisted session state.
 * `run()` must restore the per-thread agent (and its `_interruptState`)
 * before deciding whether to skip resume validation, rather than treating
 * "nothing in the in-memory map yet" as "nothing pending".
 */

import { beforeEach, describe, it, expect, vi } from "vitest";
import { SessionManager } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";
import type { BaseEvent } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput, scriptedAgent, stream } from "./helpers";

// Mock the Strands Agent constructor so tests don't need a real model
// provider, and so we can stamp a pre-activated `_interruptState` onto the
// instance to simulate what a real SessionManager would restore.
type RestoredInterruptState = {
  activated: boolean;
  interrupts: Map<string, unknown> | Record<string, unknown>;
  deactivate?: () => void;
};
let nextInterruptState: RestoredInterruptState | undefined;
let streamCalls = 0;
// Every argument list handed to the mocked `stream()`, so a test can assert
// which interrupt answers were actually submitted rather than only that a call
// happened. Reset per test by the `beforeEach` below.
const streamArgs: unknown[] = [];
/**
 * Results the mocked `stream()` returns, oldest first, one per call. A call
 * past the end of the queue gets the ordinary completed-turn result, so only
 * tests that need a paused turn have to script one.
 */
const scriptedStreamResults: unknown[] = [];
/**
 * Events the mocked `stream()` yields, oldest first, one array per call. A call
 * past the end of the queue yields nothing, so only tests that need the SDK to
 * emit output have to script it.
 */
const scriptedStreamEvents: unknown[][] = [];
/** The most recent `FakeSessionManager` the agent's provider handed out. */
let lastSessionManager: FakeSessionManager | undefined;

/**
 * An interrupt as it appears both on `AgentResult.interrupts` and in the
 * `InterruptStateData` a SessionManager restores. The SDK exports `Interrupt`
 * as a type only, so tests describe one structurally.
 */
type RaisedInterrupt = {
  id: string;
  name: string;
  reason?: unknown;
  response?: unknown;
};

/** Read one entry out of either shape Strands restores `interrupts` as. */
function readRestoredInterrupt(
  interrupts: Map<string, unknown> | Record<string, unknown>,
  id: string,
): unknown {
  return interrupts instanceof Map
    ? interrupts.get(id)
    : (interrupts as Record<string, unknown>)[id];
}

/** Register a newly raised interrupt into either restored shape. */
function writeRestoredInterrupt(
  interrupts: Map<string, unknown> | Record<string, unknown>,
  id: string,
  interrupt: unknown,
): void {
  if (interrupts instanceof Map) interrupts.set(id, interrupt);
  else (interrupts as Record<string, unknown>)[id] = interrupt;
}

/** The `interruptResponse` payloads carried by an invocation's content blocks. */
function invocationInterruptResponses(
  input: unknown,
): Array<{ interruptId: string; response: unknown }> {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (content) =>
        !!content &&
        typeof content === "object" &&
        "interruptResponse" in (content as object),
    )
    .map(
      (content) =>
        (
          content as {
            interruptResponse: { interruptId: string; response: unknown };
          }
        ).interruptResponse,
    );
}

/**
 * The `AgentResult` Strands returns from a turn that halted on an interrupt.
 * `Agent._createInterruptResult()` reports the unanswered interrupts and
 * activates the checkpoint; the mocked `stream()` below mirrors both.
 */
function pausedResult(interrupts: RaisedInterrupt[]) {
  return {
    stopReason: "interrupt" as const,
    interrupts,
    lastMessage: { role: "assistant", content: [] },
  };
}

vi.mock("@strands-agents/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@strands-agents/sdk")>();
  class MockAgent {
    model = { name: "mock" };
    tools: unknown[] = [];
    // The SDK's Agent owns its conversation history and exposes the
    // SessionManager it was constructed with, which is what tells the adapter
    // whether to replay AG-UI history into Strands or forward a prompt.
    messages: unknown[] = [];
    sessionManager: unknown;
    // A real `StateStore`, so the interrupt bookkeeping the adapter writes here
    // round-trips through the same deep-copy/JSON validation production uses.
    appState = new actual.StateStore();
    toolRegistry = {
      _tools: new Map<string, unknown>(),
      add(t: unknown) {
        this._tools.set((t as { name: string }).name, t);
      },
      getByName(name: string) {
        return this._tools.get(name);
      },
      get(name: string) {
        return this._tools.get(name);
      },
      removeByName(name: string) {
        this._tools.delete(name);
      },
      remove(name: unknown) {
        if (typeof name === "string") this._tools.delete(name);
      },
      values() {
        return Array.from(this._tools.values());
      },
      // The real `ToolRegistry` always exposes list(); without it every run
      // here would take the adapter's "registry cannot be enumerated" fallback,
      // which production never reaches.
      list() {
        return Array.from(this._tools.values());
      },
    };
    // Start without an interrupt so test cases only see the configured state
    // when initialize() simulates SessionManager's InitializedEvent restore.
    _interruptState: RestoredInterruptState = {
      activated: false,
      interrupts: {},
    };
    constructor(config?: { sessionManager?: unknown }) {
      this.sessionManager = config?.sessionManager;
    }
    async initialize() {
      this._interruptState = nextInterruptState ?? {
        activated: false,
        interrupts: {},
      };
    }
    async *stream(input?: unknown) {
      streamCalls += 1;
      streamArgs.push(input);
      // Mirror the SDK: it resumes the checkpoint from the invocation input and
      // rejects an invocation carrying no interrupt responses while the
      // checkpoint is still activated. A double that accepts one certifies
      // behaviour production rejects.
      const responses = invocationInterruptResponses(input);
      let resumed = false;
      if (responses.length > 0) {
        // `InterruptState.resume()` records each answer on the restored
        // interrupt and throws for an id the checkpoint never raised.
        if (this._interruptState.activated) {
          for (const { interruptId, response } of responses) {
            const interrupt = readRestoredInterrupt(
              this._interruptState.interrupts,
              interruptId,
            );
            if (!interrupt) {
              throw new Error(
                `interrupt_id=<${interruptId}> | no interrupt found`,
              );
            }
            (interrupt as { response?: unknown }).response = response;
          }
          resumed = true;
        }
      } else if (this._interruptState.activated) {
        throw new TypeError(
          "Agent is in an interrupted state. Resume by invoking with interruptResponse content blocks.",
        );
      }
      const result =
        scriptedStreamResults.shift() ??
        ({
          stopReason: "endTurn",
          message: { role: "assistant", content: [] },
        } as unknown);
      // The parked hooks and tool execution run here, after the answers are
      // recorded and before the checkpoint is cleared. A scripted Error stands
      // for a failure in that window, which is what leaves a persisted
      // checkpoint activated with every interrupt already answered.
      if (result instanceof Error) throw result;
      if (resumed) {
        // Strands clears its own checkpoint once the resumed work succeeds. It
        // does so internally, so this does not go through `deactivate()`: that
        // counter exists to prove the adapter never reaches for the checkpoint.
        this._interruptState.activated = false;
        this._interruptState.interrupts =
          this._interruptState.interrupts instanceof Map ? new Map() : {};
      }
      for (const event of scriptedStreamEvents.shift() ?? []) yield event;
      const paused = result as {
        stopReason?: string;
        interrupts?: RaisedInterrupt[];
      };
      if (paused.stopReason === "interrupt") {
        // `_createInterruptResult()` reports interrupts that are already on the
        // state, then activates it, so the next turn sees them as open.
        for (const raised of paused.interrupts ?? []) {
          writeRestoredInterrupt(
            this._interruptState.interrupts,
            raised.id,
            raised,
          );
        }
        this._interruptState.activated = true;
      }
      return result;
    }
  }
  return {
    ...actual,
    Agent: MockAgent,
  };
});

class FakeSessionManager extends SessionManager {
  /**
   * One entry per explicit `saveSnapshot()`, capturing the agent's `appState`
   * as it stood at that moment. The real `saveSnapshot()` serializes a whole
   * live Agent, which a mocked one cannot satisfy; recording the state the
   * adapter had written by then is what the durability claim rests on.
   */
  readonly savedSnapshots: Array<{
    isLatest: boolean | undefined;
    appState: Record<string, unknown>;
  }> = [];
  saveSnapshot = vi.fn(async (params: { target: unknown; isLatest?: boolean }) => {
    const appState = (
      params.target as {
        appState?: { getAll?: () => Record<string, unknown> };
      }
    ).appState;
    this.savedSnapshots.push({
      isLatest: params.isLatest,
      appState: appState?.getAll?.() ?? {},
    });
  });
  constructor() {
    super({
      sessionId: `fake-${Math.random().toString(36).slice(2)}`,
      storage: {
        snapshot: { save: vi.fn(), load: vi.fn(), delete: vi.fn() } as never,
      },
    });
    lastSessionManager = this;
  }
}

// The mock's captured state is module-level, so clear it before every test to
// keep assertions independent of execution order.
beforeEach(() => {
  nextInterruptState = undefined;
  streamCalls = 0;
  streamArgs.length = 0;
  scriptedStreamResults.length = 0;
  scriptedStreamEvents.length = 0;
  lastSessionManager = undefined;
});

/**
 * The interrupt answers submitted to Strands, one entry per `stream()` call.
 * Resume runs pass `InterruptResponseContent[]`; anything else (a plain prompt
 * string, or `undefined` for a history replay) is passed through untouched so a
 * mismatch is visible in the failure diff.
 */
function submittedInterruptAnswers(): unknown[] {
  return streamArgs.map((args) =>
    Array.isArray(args)
      ? args.map(
          (content) => (content as { interruptResponse?: unknown }).interruptResponse,
        )
      : args,
  );
}

/**
 * An activated restored checkpoint whose `deactivate()` behaves like the SDK's:
 * it clears the recorded interrupts along with the flag. The checkpoint is the
 * SDK's to clear, so a test asserts the adapter never reaches for this.
 */
function restoredCheckpoint(
  interrupts: Map<string, unknown> | Record<string, unknown>,
): RestoredInterruptState & { deactivateCalls: number } {
  const state = {
    activated: true,
    interrupts,
    deactivateCalls: 0,
    deactivate: () => {
      state.deactivateCalls += 1;
      state.activated = false;
      state.interrupts = interrupts instanceof Map ? new Map() : {};
    },
  };
  return state;
}

function newColdAgent(): StrandsAgent {
  return new StrandsAgent({
    agent: scriptedAgent(),
    name: "t",
    config: { sessionManagerProvider: () => new FakeSessionManager() },
  });
}

describe("Cold restart: resume validation must see session-restored interrupt state", () => {
  it("rejects an unknown interruptId on a cold thread with a session provider instead of skipping validation", async () => {
    // Simulate a genuinely pending native interrupt "int-1" that a real
    // SessionManager would have restored onto the freshly-constructed agent.
    nextInterruptState = {
      activated: true,
      interrupts: { "int-1": {} },
    };

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => new FakeSessionManager() },
    });

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "cold-thread",
        resume: [{ interruptId: "totally-unknown-id", status: "resolved", payload: {} }],
      }),
    );

    const err = events.find(
      (e) => e.type === EventType.RUN_ERROR,
    ) as unknown as { code: string; message: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.code).toBe("UNKNOWN_INTERRUPT_ID");
  });

  it("rejects a partial resume on a cold thread with a session provider instead of skipping validation", async () => {
    nextInterruptState = {
      activated: true,
      interrupts: new Map([
        ["int-1", {}],
        ["int-2", {}],
      ]),
    };

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => new FakeSessionManager() },
    });

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "cold-thread-partial",
        resume: [{ interruptId: "int-1", status: "resolved", payload: {} }],
      }),
    );

    const err = events.find(
      (e) => e.type === EventType.RUN_ERROR,
    ) as unknown as { code: string; message: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.code).toBe("PARTIAL_RESUME");
  });

  it("allows resume to proceed when the restored native interrupt state has no pending interrupts", async () => {
    nextInterruptState = { activated: false, interrupts: new Map() };

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => new FakeSessionManager() },
    });

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "cold-thread-none-pending",
        resume: [{ interruptId: "stale-id", status: "resolved", payload: {} }],
      }),
    );

    const err = events.find(
      (e) => e.type === EventType.RUN_ERROR,
    ) as unknown as { code: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.code).toBe("UNKNOWN_INTERRUPT_ID");
  });

  it("accepts a known interruptId restored as Strands' record-shaped state", async () => {
    nextInterruptState = {
      activated: true,
      interrupts: { "int-1": {} },
    };

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => new FakeSessionManager() },
    });

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "cold-thread-record-shaped",
        resume: [{ interruptId: "int-1", status: "resolved", payload: {} }],
      }),
    );

    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
    expect(streamCalls).toBe(1);
  });

  it("rejects fresh input on a cold thread when SessionManager restores a pending interrupt", async () => {
    nextInterruptState = {
      activated: true,
      interrupts: new Map([["int-1", {}]]),
    };

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => new FakeSessionManager() },
    });

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "cold-thread-fresh-input",
        // A real fresh turn carries the user's new text. Submitting none would
        // leave the adapter forwarding its placeholder prompt, so the run would
        // not be the one production has to reject.
        messages: [{ id: "u1", role: "user", content: "ship it" }],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string };
    expect(err.code).toBe("PENDING_INTERRUPTS");
    expect(streamCalls).toBe(0);
  });

  it("keeps blocking fresh input on a restored checkpoint whose every interrupt is answered", async () => {
    // A restored checkpoint stays activated after its last answer is recorded.
    // Clearing it here to let the turn through is the SDK's call, not the
    // adapter's: `deactivate()` drops the tool execution parked behind the
    // checkpoint, which nothing has appended to the conversation yet.
    const answered = new Map<string, unknown>([
      ["int-1", { id: "int-1", name: "approve", response: { approved: true } }],
      ["int-2", { id: "int-2", name: "clarify", response: false }],
    ]);
    const checkpoint = restoredCheckpoint(answered);
    nextInterruptState = checkpoint;

    const events = await collect(
      newColdAgent(),
      minimalRunInput({
        threadId: "cold-thread-all-answered",
        messages: [{ id: "u1", role: "user", content: "what now?" }],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    expect(events[1]).toMatchObject({
      code: "PENDING_INTERRUPTS",
      message: "Thread has pending interrupts. Include resume[] to address them.",
    });
    // Nothing reached the SDK, and the checkpoint is exactly as restored.
    expect(streamCalls).toBe(0);
    expect(checkpoint.deactivateCalls).toBe(0);
    expect(checkpoint.activated).toBe(true);
    expect(checkpoint.interrupts).toEqual(answered);
  });

  it("keeps blocking fresh input while a restored interrupt is still open, leaving it intact", async () => {
    // Deactivating here would drop the pending question on the floor: the
    // client is told to resume, and that resume must still find the interrupt
    // open.
    const open = { id: "int-2", name: "clarify" };
    const answered = { id: "int-1", name: "approve", response: { approved: true } };
    const checkpoint = restoredCheckpoint(
      new Map<string, unknown>([
        ["int-1", answered],
        ["int-2", open],
      ]),
    );
    nextInterruptState = checkpoint;

    const events = await collect(
      newColdAgent(),
      minimalRunInput({
        threadId: "cold-thread-still-open",
        messages: [{ id: "u1", role: "user", content: "ship it" }],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    expect(events[1]).toMatchObject({
      code: "PENDING_INTERRUPTS",
      message: "Thread has pending interrupts. Include resume[] to address them.",
    });
    expect(streamCalls).toBe(0);
    expect(checkpoint.deactivateCalls).toBe(0);
    expect(checkpoint.activated).toBe(true);
    expect(checkpoint.interrupts).toEqual(
      new Map<string, unknown>([
        ["int-1", answered],
        ["int-2", open],
      ]),
    );
  });

  describe("A resume that pauses again on a freshly raised interrupt", () => {
    // The other half of cold restart: once the restored checkpoint is answered,
    // the tool can raise a new interrupt and the turn halts again. The adapter
    // has to report it, checkpoint it durably (an interrupt exits the native
    // loop before Strands' own invocation-boundary save), and re-arm its own
    // bookkeeping so the following turn is gated against the NEW interrupt.
    const THREAD = "cold-thread-repause";
    const APPROVAL_NAME = "ag_ui:tool_call:deploy";

    /** Built per test: the mocked stream records answers onto this object. */
    const reRaisedApproval = (): RaisedInterrupt => ({
      id: "int-2",
      name: APPROVAL_NAME,
      reason: {
        tool_call: true,
        tool_name: "deploy",
        tool_input: {},
        tool_use_id: "tc-2",
      },
    });

    /**
     * First turn: a cold thread whose restored checkpoint holds one open
     * interrupt, resumed, with the SDK halting again on a newly raised one.
     */
    async function resumeThenPauseAgain(): Promise<{
      agent: StrandsAgent;
      events: BaseEvent[];
    }> {
      nextInterruptState = restoredCheckpoint(
        new Map<string, unknown>([
          ["int-1", { id: "int-1", name: APPROVAL_NAME }],
        ]),
      );
      scriptedStreamResults.push(pausedResult([reRaisedApproval()]));
      const agent = newColdAgent();
      const events = await collect(
        agent,
        minimalRunInput({
          threadId: THREAD,
          resume: [
            { interruptId: "int-1", status: "resolved", payload: { approved: true } },
          ],
        }),
      );
      return { agent, events };
    }

    it("reports the re-raised interrupt on RUN_FINISHED", async () => {
      const { events } = await resumeThenPauseAgain();

      expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
        false,
      );
      expect(submittedInterruptAnswers()).toEqual([
        [{ interruptId: "int-1", response: { approved: true } }],
      ]);
      expect(events[events.length - 1]).toMatchObject({
        type: EventType.RUN_FINISHED,
        threadId: THREAD,
        runId: "run-1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "int-2",
              reason: "tool_call",
              message: "Approve call to deploy?",
              toolCallId: "tc-2",
            },
          ],
        },
      });
    });

    it("checkpoints the re-raised interrupt through the session manager", async () => {
      await resumeThenPauseAgain();

      // One explicit save at the interrupt boundary, and the state it captured
      // must already name the new interrupt, or a restart resumes a thread
      // whose only record of the open question is gone.
      expect(
        lastSessionManager!.savedSnapshots.map((snapshot) => snapshot.isLatest),
      ).toEqual([true]);
      expect(
        lastSessionManager!.savedSnapshots[0]!.appState[
          "ag_ui_interrupt_bookkeeping"
        ],
      ).toMatchObject({
        pendingInterrupts: {
          "int-2": { id: "int-2", reason: "tool_call", toolCallId: "tc-2" },
        },
      });
    });

    it("forwards an answer for the re-raised interrupt on the next turn", async () => {
      const { agent } = await resumeThenPauseAgain();

      const events = await collect(
        agent,
        minimalRunInput({
          threadId: THREAD,
          runId: "run-2",
          resume: [
            { interruptId: "int-2", status: "resolved", payload: { approved: false } },
          ],
        }),
      );

      expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
        false,
      );
      expect(submittedInterruptAnswers()).toEqual([
        [{ interruptId: "int-1", response: { approved: true } }],
        [{ interruptId: "int-2", response: { approved: false } }],
      ]);
    });

    // Each row is a next turn the re-armed bookkeeping has to refuse, and the
    // reason it refuses: the gate is closed again, the new interrupt's response
    // contract is enforced, and the answered one is no longer outstanding.
    const refusedNextTurns: Array<{
      turn: string;
      code: string;
      input: Partial<Parameters<typeof minimalRunInput>[0]>;
    }> = [
      {
        turn: "fresh input",
        code: "PENDING_INTERRUPTS",
        input: { messages: [{ id: "u2", role: "user", content: "ship it" }] },
      },
      {
        turn: "an answer violating the re-raised interrupt's response schema",
        code: "INVALID_PAYLOAD",
        input: {
          resume: [
            { interruptId: "int-2", status: "resolved", payload: { approved: "yes" } },
          ],
        },
      },
      {
        // A different payload, so this is a new request rather than a replay of
        // the resume that closed "int-1".
        turn: "an answer for the interrupt the previous turn closed",
        code: "UNKNOWN_INTERRUPT_ID",
        input: {
          resume: [
            { interruptId: "int-1", status: "resolved", payload: { approved: false } },
          ],
        },
      },
    ];

    it.each(refusedNextTurns)("refuses $turn with $code", async ({ code, input }) => {
      const { agent } = await resumeThenPauseAgain();
      const streamCallsSoFar = streamCalls;

      const events = await collect(
        agent,
        minimalRunInput({ threadId: THREAD, runId: "run-2", ...input }),
      );

      expect(events.map((event) => event.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.RUN_ERROR,
      ]);
      expect(events[1]).toMatchObject({ code });
      expect(streamCalls).toBe(streamCallsSoFar);
    });
  });

  describe("tool-approval payload validation without AG-UI bookkeeping", () => {
    // A tool approval's response contract is fixed ({ approved: boolean }), so
    // it holds even when the adapter bookkeeping carrying `responseSchema` was
    // lost to the restart. Waving the payload through here would forward a
    // falsy answer raw, Strands would record it as "no answer", and the same
    // interrupt would re-raise forever.
    const toolApproval = (id: string) => ({
      id,
      name: "ag_ui:tool_call:my_tool",
      reason: { tool_call: true, tool_name: "my_tool", tool_input: {} },
    });

    const coldAgent = (id: string) => {
      nextInterruptState = {
        activated: true,
        interrupts: new Map<string, unknown>([[id, toolApproval(id)]]),
      };
      return new StrandsAgent({
        agent: scriptedAgent(),
        name: "t",
        config: { sessionManagerProvider: () => new FakeSessionManager() },
      });
    };

    it("rejects a missing approval payload", async () => {
      const agent = coldAgent("int-approve");

      const events = await collect(
        agent,
        minimalRunInput({
          threadId: "cold-thread-approval-missing-payload",
          resume: [{ interruptId: "int-approve", status: "resolved" }],
        }),
      );

      const errors = events.filter(
        (event) => event.type === EventType.RUN_ERROR,
      ) as unknown as { code: string; message: string }[];
      expect(errors.map((error) => error.code)).toEqual(["INVALID_PAYLOAD"]);
      expect(errors[0]!.message).toContain("expected an object");
      expect(streamCalls).toBe(0);
    });

    it("rejects a non-boolean approval payload", async () => {
      const agent = coldAgent("int-approve");

      const events = await collect(
        agent,
        minimalRunInput({
          threadId: "cold-thread-approval-non-boolean",
          resume: [
            {
              interruptId: "int-approve",
              status: "resolved",
              payload: { approved: "true" },
            },
          ],
        }),
      );

      const errors = events.filter(
        (event) => event.type === EventType.RUN_ERROR,
      ) as unknown as { code: string; message: string }[];
      expect(errors.map((error) => error.code)).toEqual(["INVALID_PAYLOAD"]);
      expect(errors[0]!.message).toContain("approved");
      expect(streamCalls).toBe(0);
    });

    it("still forwards a valid approval payload to Strands unchanged", async () => {
      const agent = coldAgent("int-approve");

      const events = await collect(
        agent,
        minimalRunInput({
          threadId: "cold-thread-approval-valid",
          resume: [
            {
              interruptId: "int-approve",
              status: "resolved",
              payload: { approved: true },
            },
          ],
        }),
      );

      expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
        false,
      );
      expect(streamCalls).toBe(1);
      expect(submittedInterruptAnswers()).toEqual([
        [{ interruptId: "int-approve", response: { approved: true } }],
      ]);
    });
  });
});

// Both shapes Strands' restored `_interruptState.interrupts` can take: the
// current SDK serializes a Record, older mocks used a Map.
const interruptShapes = [
  {
    shape: "Map-shaped",
    build: (entries: Array<[string, unknown]>) =>
      new Map<string, unknown>(entries) as Map<string, unknown>,
  },
  {
    shape: "record-shaped",
    build: (entries: Array<[string, unknown]>) =>
      Object.fromEntries(entries) as Record<string, unknown>,
  },
];

// A response that was recorded, however falsy, is an answer. The Strands TS SDK
// decides with `interrupt.response === undefined` (`InterruptState
// .getUnansweredInterrupts`, `interruptFromAgent`), so a recorded `null` counts
// as answered here even though Python's `None` does not.
const answeredResponses: Array<{ answer: string; response: unknown }> = [
  { answer: "false", response: false },
  { answer: "zero", response: 0 },
  { answer: "an empty string", response: "" },
  { answer: "null", response: null },
];

// Two ways a restored interrupt can carry no response at all. Both stay open.
const unansweredShapes: Array<{
  absence: string;
  fields: Record<string, unknown>;
}> = [
  { absence: "no response property", fields: {} },
  { absence: "an explicitly undefined response", fields: { response: undefined } },
];

describe.each(interruptShapes)(
  "Answered-vs-open classification of $shape restored interrupt state",
  ({ build }) => {
    it.each(answeredResponses)(
      "submits only the open interrupt's answer when a sibling was answered with $answer",
      async ({ response }) => {
        nextInterruptState = {
          activated: true,
          interrupts: build([
            ["int-answered", { id: "int-answered", name: "approve", response }],
            ["int-open", { id: "int-open", name: "clarify" }],
          ]),
        };

        const events = await collect(
          newColdAgent(),
          minimalRunInput({
            threadId: "cold-thread-answered-sibling",
            resume: [
              {
                interruptId: "int-open",
                status: "resolved",
                payload: { environment: "prod" },
              },
            ],
          }),
        );

        expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
          false,
        );
        // The answered sibling is neither demanded nor re-submitted.
        expect(submittedInterruptAnswers()).toEqual([
          [{ interruptId: "int-open", response: { environment: "prod" } }],
        ]);
      },
    );

    it.each(unansweredShapes)(
      "still demands a restored interrupt that carries $absence",
      async ({ fields }) => {
        nextInterruptState = {
          activated: true,
          interrupts: build([
            ["int-addressed", { id: "int-addressed", name: "approve" }],
            ["int-unanswered", { id: "int-unanswered", name: "clarify", ...fields }],
          ]),
        };

        const events = await collect(
          newColdAgent(),
          minimalRunInput({
            threadId: "cold-thread-unanswered-sibling",
            resume: [
              { interruptId: "int-addressed", status: "resolved", payload: {} },
            ],
          }),
        );

        const err = events.find(
          (event) => event.type === EventType.RUN_ERROR,
        ) as unknown as { code: string; message: string } | undefined;
        expect(err).toBeDefined();
        expect(err!.code).toBe("PARTIAL_RESUME");
        expect(err!.message).toContain("int-unanswered");
        expect(submittedInterruptAnswers()).toEqual([]);
      },
    );
  },
);

/**
 * Both SDKs record the submitted answers onto the checkpoint before they rerun
 * the parked hooks and tool execution, and clear the checkpoint only once that
 * work succeeds. A failure in between, or a crash after session persistence,
 * restores a checkpoint that is activated with every interrupt already
 * answered. That thread has no way forward: fresh input is refused because the
 * checkpoint is active (covered above), and a resume finds nothing open to
 * address. Replaying the exact batch is the way out, because it hands Strands
 * the answers it already holds and lets it finish the parked execution. The
 * checkpoint is never torn down here, since that would discard exactly that
 * execution.
 */
describe("A resume the SDK parked after recording its answers", () => {
  const APPROVAL_NAME = "ag_ui:tool_call:deploy";
  const INTERRUPT_ID = "int-1";
  const PARKED_OUTPUT = "Deployed to production.";

  const submittedBatch = (approved = true) => [
    {
      interruptId: INTERRUPT_ID,
      status: "resolved" as const,
      payload: { approved },
    },
  ];

  const parkedApproval = () => ({
    id: INTERRUPT_ID,
    name: APPROVAL_NAME,
    reason: { tool_name: "deploy", tool_input: {}, tool_use_id: "tc-1" },
  });

  /** The checkpoint as it stands once the resumed work has failed. */
  function strandedCheckpoint(): ReturnType<typeof restoredCheckpoint> {
    return restoredCheckpoint(
      new Map<string, unknown>([
        [INTERRUPT_ID, { ...parkedApproval(), response: { approved: true } }],
      ]),
    );
  }

  /** The text the parked tool streams once its execution finally runs. */
  function scriptParkedOutput(): void {
    scriptedStreamEvents.push([stream.textDelta(PARKED_OUTPUT)]);
  }

  function emittedText(events: BaseEvent[]): string[] {
    return events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
  }

  it("leaves the answer recorded and the checkpoint active when the resumed work fails", async () => {
    const checkpoint = restoredCheckpoint(
      new Map<string, unknown>([[INTERRUPT_ID, parkedApproval()]]),
    );
    nextInterruptState = checkpoint;
    scriptedStreamResults.push(new Error("post-approval hook failed"));

    const events = await collect(
      newColdAgent(),
      minimalRunInput({
        threadId: "cold-thread-parked-premise",
        resume: submittedBatch(),
      }),
    );

    expect(events[events.length - 1]).toMatchObject({
      type: EventType.RUN_ERROR,
    });
    expect(checkpoint.activated).toBe(true);
    expect(
      readRestoredInterrupt(checkpoint.interrupts, INTERRUPT_ID),
    ).toMatchObject({ response: { approved: true } });
    expect(checkpoint.deactivateCalls).toBe(0);
  });

  it("completes the parked execution when the exact batch is replayed after a restart", async () => {
    // A fresh process: nothing cached for the thread, and SessionManager
    // restores the checkpoint the failed attempt left behind.
    const checkpoint = strandedCheckpoint();
    nextInterruptState = checkpoint;
    scriptParkedOutput();

    const events = await collect(
      newColdAgent(),
      minimalRunInput({
        threadId: "cold-thread-parked-replay",
        resume: submittedBatch(),
      }),
    );

    // Strands got back the answer it already held, unchanged.
    expect(submittedInterruptAnswers()).toEqual([
      [{ interruptId: INTERRUPT_ID, response: { approved: true } }],
    ]);
    // The parked tool's output reached the client, so its execution ran.
    expect(emittedText(events)).toEqual([PARKED_OUTPUT]);
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    // The terminal finish carries no outcome, which is what separates a run
    // Strands actually completed from the fingerprint shortcut's synthetic
    // success outcome and from the interrupt variant of a run still parked.
    expect(events[events.length - 1]).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "cold-thread-parked-replay",
      runId: "run-1",
    });
    // The SDK cleared its own checkpoint once the parked work succeeded, and
    // the adapter never reached for it.
    expect(checkpoint.activated).toBe(false);
    expect(checkpoint.deactivateCalls).toBe(0);
  });

  it("reaches Strands on a replay the idempotency fingerprint already knows", async () => {
    // The fingerprint shortcut answers a resume the thread already completed.
    // A parked resume has not completed, so answering it from the cache would
    // report success while the checkpoint never advances.
    const THREAD = "cold-thread-parked-fingerprint";
    const agent = newColdAgent();

    // Turn one completes the resume, which is what caches its fingerprint.
    nextInterruptState = restoredCheckpoint(
      new Map<string, unknown>([[INTERRUPT_ID, parkedApproval()]]),
    );
    await collect(
      agent,
      minimalRunInput({ threadId: THREAD, resume: submittedBatch() }),
    );

    // The SDK restores a checkpoint snapshotted before it was cleared: active,
    // with the same answer already recorded.
    const checkpoint = strandedCheckpoint();
    (
      (
        agent as unknown as { _agentsByThread: Map<string, unknown> }
      )._agentsByThread.get(THREAD) as { _interruptState: unknown }
    )._interruptState = checkpoint;
    scriptParkedOutput();

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: THREAD,
        runId: "run-2",
        resume: submittedBatch(),
      }),
    );

    expect(submittedInterruptAnswers()).toEqual([
      [{ interruptId: INTERRUPT_ID, response: { approved: true } }],
      [{ interruptId: INTERRUPT_ID, response: { approved: true } }],
    ]);
    expect(emittedText(events)).toEqual([PARKED_OUTPUT]);
    // No outcome, so this finish came from Strands rather than the shortcut.
    expect(events[events.length - 1]).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: THREAD,
      runId: "run-2",
    });
    expect(checkpoint.activated).toBe(false);
  });

  it("still refuses a batch that replays only some of the recorded answers", async () => {
    const checkpoint = restoredCheckpoint(
      new Map<string, unknown>([
        [INTERRUPT_ID, { ...parkedApproval(), response: { approved: true } }],
        [
          "int-2",
          { id: "int-2", name: APPROVAL_NAME, response: { approved: true } },
        ],
      ]),
    );
    nextInterruptState = checkpoint;

    const events = await collect(
      newColdAgent(),
      minimalRunInput({
        threadId: "cold-thread-parked-partial",
        resume: submittedBatch(),
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    expect(events[1]).toMatchObject({ code: "UNKNOWN_INTERRUPT_ID" });
    expect(submittedInterruptAnswers()).toEqual([]);
    expect(checkpoint.activated).toBe(true);
  });

  it("still refuses a batch that repeats one id instead of covering both", async () => {
    const checkpoint = restoredCheckpoint(
      new Map<string, unknown>([
        [INTERRUPT_ID, { ...parkedApproval(), response: { approved: true } }],
        [
          "int-2",
          { id: "int-2", name: APPROVAL_NAME, response: { approved: true } },
        ],
      ]),
    );
    nextInterruptState = checkpoint;

    const events = await collect(
      newColdAgent(),
      minimalRunInput({
        threadId: "cold-thread-parked-duplicate",
        resume: [...submittedBatch(), ...submittedBatch()],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    expect(events[1]).toMatchObject({ code: "UNKNOWN_INTERRUPT_ID" });
    expect(submittedInterruptAnswers()).toEqual([]);
    expect(checkpoint.activated).toBe(true);
  });

  it("does not treat an inactive checkpoint holding answers as a parked resume", async () => {
    // Only a checkpoint the SDK still holds active has a parked execution to
    // finish. An inactive one has already completed, so the resume is the
    // ordinary stale replay and must not reach Strands again.
    nextInterruptState = {
      activated: false,
      interrupts: new Map<string, unknown>([
        [INTERRUPT_ID, { ...parkedApproval(), response: { approved: true } }],
      ]),
    };

    const events = await collect(
      newColdAgent(),
      minimalRunInput({
        threadId: "cold-thread-parked-inactive",
        resume: submittedBatch(),
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    expect(events[1]).toMatchObject({
      code: "UNKNOWN_INTERRUPT_ID",
      message: "No pending interrupts for this thread.",
    });
    expect(submittedInterruptAnswers()).toEqual([]);
  });

  it("still refuses a batch that does not replay the recorded answers", async () => {
    const checkpoint = strandedCheckpoint();
    nextInterruptState = checkpoint;

    const events = await collect(
      newColdAgent(),
      minimalRunInput({
        threadId: "cold-thread-parked-mismatch",
        resume: submittedBatch(false),
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    expect(events[1]).toMatchObject({ code: "UNKNOWN_INTERRUPT_ID" });
    // Nothing reached the SDK and the checkpoint stands exactly as restored.
    expect(submittedInterruptAnswers()).toEqual([]);
    expect(checkpoint.activated).toBe(true);
    expect(
      readRestoredInterrupt(checkpoint.interrupts, INTERRUPT_ID),
    ).toMatchObject({ response: { approved: true } });
    expect(checkpoint.deactivateCalls).toBe(0);
  });
});
