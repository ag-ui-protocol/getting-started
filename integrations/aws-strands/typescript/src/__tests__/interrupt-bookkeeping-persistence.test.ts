/**
 * Regression coverage for interrupt bookkeeping surviving a process restart.
 *
 * `_pendingInterruptsByThread` and `_lastResumeFingerprint` are the
 * adapter's own bookkeeping, layered on top of Strands' native
 * `_interruptState` (which SessionManager already persists/restores on its
 * own). Prior to this, the adapter's bookkeeping lived purely in an
 * in-process Map, so a real process restart lost it:
 *
 * - Rule 6 (responseSchema payload validation) and Rule 7 (expiresAt
 *   enforcement) silently degrade, since they read AG-UI-specific interrupt
 *   metadata that only exists in this bookkeeping.
 * - Rule 5 (idempotency) breaks: a replayed resume request is no longer
 *   recognized as a duplicate and can re-invoke the model/tool.
 *
 * These tests use a REAL `StateStore` instance (not a mock) to prove the
 * adapter actually round-trips through `strandsAgent.appState`, matching
 * what a real SessionManager restores after a restart.
 */

import { describe, it, expect, vi } from "vitest";
import { SessionManager, StateStore } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput, scriptedAgent } from "./helpers";

let nextAppState: StateStore | undefined;
let nextInterruptState:
  | { activated: boolean; interrupts: Map<string, unknown> }
  | undefined;

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
    appState = nextAppState ?? new actual.StateStore();
    _interruptState = nextInterruptState;
    async *stream() {
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

describe("Idempotency fingerprint survives restart", () => {
  it("recognizes a replayed resume from persisted appState without touching Strands", async () => {
    const resume = [{ interruptId: "int-1", status: "resolved" as const, payload: { approved: true } }];

    // Compute the fingerprint exactly as the adapter does (md5 of the
    // sorted resume tuple), and pre-seed it into a REAL StateStore —
    // simulating what a prior process persisted before restarting.
    const { createHash } = await import("crypto");
    const fingerprint = createHash("md5")
      .update(JSON.stringify(resume.map((e) => [e.interruptId, e.status, e.payload])))
      .digest("hex");

    const appState = new StateStore();
    appState.set("ag_ui_interrupt_bookkeeping", {
      lastResumeFingerprint: fingerprint,
      pendingInterrupts: {},
    });
    nextAppState = appState;
    nextInterruptState = undefined;

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => new FakeSessionManager() },
    });

    const events = await collect(
      agent,
      minimalRunInput({ threadId: "restart-fp-thread", resume }),
    );

    const finished = events.find((e) => e.type === EventType.RUN_FINISHED);
    expect(finished).toBeDefined();
    expect((finished as unknown as { outcome: { type: string } }).outcome.type).toBe(
      "success",
    );
    expect(events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
  });
});

describe("Pending-interrupt metadata survives restart", () => {
  it("still enforces Rule 7 (expiresAt) from persisted appState", async () => {
    const appState = new StateStore();
    appState.set("ag_ui_interrupt_bookkeeping", {
      lastResumeFingerprint: null,
      pendingInterrupts: {
        "int-1": {
          id: "int-1",
          reason: "tool_call",
          toolCallId: "tc-1",
          expiresAt: "2000-01-01T00:00:00.000Z", // long expired
        },
      },
    });
    nextAppState = appState;
    nextInterruptState = { activated: true, interrupts: new Map([["int-1", {}]]) };

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => new FakeSessionManager() },
    });

    const resume = [{ interruptId: "int-1", status: "resolved" as const, payload: { approved: true } }];
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "restart-expiry-thread", resume }),
    );

    const err = events.find((e) => e.type === EventType.RUN_ERROR) as unknown as
      | { code: string }
      | undefined;
    expect(err).toBeDefined();
    expect(err!.code).toBe("INTERRUPT_EXPIRED");
  });

  it("still enforces Rule 6 (responseSchema) from persisted appState", async () => {
    const appState = new StateStore();
    appState.set("ag_ui_interrupt_bookkeeping", {
      lastResumeFingerprint: null,
      pendingInterrupts: {
        "int-2": {
          id: "int-2",
          reason: "tool_call",
          toolCallId: "tc-2",
          responseSchema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"],
          },
        },
      },
    });
    nextAppState = appState;
    nextInterruptState = { activated: true, interrupts: new Map([["int-2", {}]]) };

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => new FakeSessionManager() },
    });

    // Missing the required "approved" key.
    const resume = [{ interruptId: "int-2", status: "resolved" as const, payload: {} }];
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "restart-schema-thread", resume }),
    );

    const err = events.find((e) => e.type === EventType.RUN_ERROR) as unknown as
      | { code: string }
      | undefined;
    expect(err).toBeDefined();
    expect(err!.code).toBe("INVALID_PAYLOAD");
  });
});

describe("Persistence helpers are defensive against non-conforming appState", () => {
  it("never throws when appState.get returns something unexpected", async () => {
    nextAppState = { get: () => "not-an-object" } as unknown as StateStore;
    nextInterruptState = undefined;

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => new FakeSessionManager() },
    });

    const resume = [{ interruptId: "whatever", status: "resolved" as const, payload: { approved: true } }];
    // Must not throw — just falls through to the normal "no pending" gate.
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "restart-broken-state-thread", resume }),
    );
    expect(events.some((e) => e.type === EventType.RUN_ERROR)).toBe(true);
  });
});
