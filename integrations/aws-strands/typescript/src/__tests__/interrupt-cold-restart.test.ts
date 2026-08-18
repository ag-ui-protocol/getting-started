/**
 * Regression coverage for the "resume validation happens before session
 * restoration" gap: on a cold process start, `_pendingInterruptsByThread`
 * is empty even though a `sessionManagerProvider`-backed thread may have a
 * genuinely pending native interrupt restored from persisted session state.
 * `run()` must restore the per-thread agent (and its `_interruptState`)
 * before deciding whether to skip resume validation, rather than treating
 * "nothing in the in-memory map yet" as "nothing pending".
 */

import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput, scriptedAgent } from "./helpers";

// Mock the Strands Agent constructor so tests don't need a real model
// provider, and so we can stamp a pre-activated `_interruptState` onto the
// instance to simulate what a real SessionManager would restore.
let nextInterruptState:
  | { activated: boolean; interrupts: Map<string, unknown> | Record<string, unknown> }
  | undefined;
let streamCalls = 0;

vi.mock("@strands-agents/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@strands-agents/sdk")>();
  class MockAgent {
    model = { name: "mock" };
    tools: unknown[] = [];
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
    };
    // Start without an interrupt so test cases only see the configured state
    // when initialize() simulates SessionManager's InitializedEvent restore.
    _interruptState: { activated: boolean; interrupts: Map<string, unknown> | Record<string, unknown> } = {
      activated: false,
      interrupts: {},
    };
    async initialize() {
      this._interruptState = nextInterruptState ?? {
        activated: false,
        interrupts: {},
      };
    }
    async *stream() {
      streamCalls += 1;
      return { stopReason: "endTurn", message: { role: "assistant", content: [] } };
    }
  }
  return {
    ...actual,
    Agent: MockAgent,
  };
});

class FakeSessionManager extends SessionManager {
  constructor() {
    super({
      sessionId: `fake-${Math.random().toString(36).slice(2)}`,
      storage: {
        snapshot: { save: vi.fn(), load: vi.fn(), delete: vi.fn() } as never,
      },
    });
  }
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
    streamCalls = 0;

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
    streamCalls = 0;

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => new FakeSessionManager() },
    });

    const events = await collect(
      agent,
      minimalRunInput({ threadId: "cold-thread-fresh-input" }),
    );

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string };
    expect(err.code).toBe("PENDING_INTERRUPTS");
    expect(streamCalls).toBe(0);
  });
});
