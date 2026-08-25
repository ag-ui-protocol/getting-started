import { EventType } from "@ag-ui/client";
import { MastraAgent } from "../mastra";
import {
  FakeLocalAgent,
  collectEvents,
  collectError,
  makeInput,
} from "./helpers";

/**
 * These tests lock in the contract between the @ag-ui/mastra adapter and
 * Mastra's Memory API: every call that takes a `resourceId` MUST receive it.
 *
 * Mastra's real `Memory.getThreadById` REQUIRES `resourceId` and throws
 * `AGENT_MEMORY_MISSING_RESOURCE_ID` when it's missing. The adapter's fake
 * memory accepts `{ threadId }` only, which let this bug slip through.
 *
 * See: integrations/mastra/typescript/src/mastra.ts — the `getThreadById`
 * call AND the `saveThread` call inside the "sync AG-UI input state into
 * Mastra's working memory" block must both forward `resourceId`.
 */

// Memory that mimics real Mastra behavior: throws if resourceId is missing
// or empty on getThreadById. Also records every call for assertions so we
// can verify saveThread receives a thread whose resourceId was plumbed
// through from the adapter.
//
// Mastra itself rejects any falsy value (null, undefined, empty string),
// not just undefined, so we mirror that with `!args.resourceId`.
class StrictMemory {
  threads: Map<string, any> = new Map();
  workingMemoryValue: string | undefined = undefined;
  getThreadByIdCalls: Array<{ threadId: string; resourceId?: string }> = [];
  saveThreadCalls: Array<{ thread: any }> = [];
  getWorkingMemoryCalls: Array<{
    threadId?: string;
    resourceId?: string;
    memoryConfig?: any;
  }> = [];
  updateWorkingMemoryCalls: Array<{
    threadId?: string;
    resourceId?: string;
    workingMemory: string;
    memoryConfig?: any;
  }> = [];

  async getThreadById(args: { threadId: string; resourceId?: string }) {
    this.getThreadByIdCalls.push(args);
    if (!args.resourceId) {
      const err = new Error("AGENT_MEMORY_MISSING_RESOURCE_ID");
      (err as any).code = "AGENT_MEMORY_MISSING_RESOURCE_ID";
      throw err;
    }
    return this.threads.get(args.threadId) ?? null;
  }

  async saveThread(args: { thread: any }) {
    this.saveThreadCalls.push(args);
    // Match Mastra runtime contract: the persisted thread MUST carry a
    // non-empty resourceId. Upstream Memory.saveThread rejects threads
    // without one.
    if (!args.thread?.resourceId) {
      const err = new Error("AGENT_MEMORY_MISSING_RESOURCE_ID");
      (err as any).code = "AGENT_MEMORY_MISSING_RESOURCE_ID";
      throw err;
    }
    this.threads.set(args.thread.id, args.thread);
  }

  async getWorkingMemory(opts: {
    threadId?: string;
    resourceId?: string;
    memoryConfig?: any;
  }): Promise<string | undefined> {
    this.getWorkingMemoryCalls.push(opts);
    // Mirror Mastra's real runtime: reject falsy resourceId the same way
    // getThreadById / saveThread do. Without this, a silent no-op would
    // mask the very regression the test is designed to catch (the
    // adapter's emitWorkingMemorySnapshot used to pass bare
    // `this.resourceId` with no fallback).
    if (!opts?.resourceId) {
      const err = new Error("AGENT_MEMORY_MISSING_RESOURCE_ID");
      (err as any).code = "AGENT_MEMORY_MISSING_RESOURCE_ID";
      throw err;
    }
    return this.workingMemoryValue;
  }

  // The input.state -> working-memory sync writes through here (resource store).
  // Mirror Mastra: reject a falsy resourceId the same way the read path does.
  async updateWorkingMemory(args: {
    threadId?: string;
    resourceId?: string;
    workingMemory: string;
    memoryConfig?: any;
  }): Promise<void> {
    this.updateWorkingMemoryCalls.push(args);
    if (!args.resourceId) {
      const err = new Error("AGENT_MEMORY_MISSING_RESOURCE_ID");
      (err as any).code = "AGENT_MEMORY_MISSING_RESOURCE_ID";
      throw err;
    }
    this.workingMemoryValue = args.workingMemory;
  }
}

describe("resourceId is always plumbed to Mastra Memory in the working-memory sync block", () => {
  it("passes resourceId to updateWorkingMemory when syncing input.state", async () => {
    const memory = new StrictMemory();

    // This mirrors the production flow:
    //   MastraAgent.getLocalAgents({ mastra, resourceId: "resource-1" })
    // The adapter constructs the agent with resourceId stored on `this`.
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: new FakeLocalAgent({
        memory: memory as any,
        streamChunks: [],
      }) as any,
      resourceId: "resource-1",
    });

    // input.state triggers the "Sync AG-UI input state into Mastra's working
    // memory" block, which writes through memory.updateWorkingMemory (the
    // resource-scoped store), forwarding resourceId. Without it Mastra's real
    // Memory throws AGENT_MEMORY_MISSING_RESOURCE_ID.
    const events = await collectEvents(
      agent,
      makeInput({ state: { userName: "Alice" } }),
    );

    expect(memory.updateWorkingMemoryCalls.length).toBeGreaterThan(0);
    for (const call of memory.updateWorkingMemoryCalls) {
      expect(call.resourceId).toBe("resource-1");
    }
    // The client state is written to working memory verbatim (merged over the
    // empty existing store).
    expect(
      JSON.parse(memory.updateWorkingMemoryCalls.at(-1)!.workingMemory),
    ).toEqual({ userName: "Alice" });

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("surfaces AGENT_MEMORY_MISSING_RESOURCE_ID when resourceId is falsy (red-harness sanity)", async () => {
    // Red harness: construct an agent whose `this.resourceId` is the empty
    // string. The adapter uses `this.resourceId ?? input.threadId`, which
    // only falls back for null/undefined — empty-string passes through as
    // the real resourceId. StrictMemory rejects it on updateWorkingMemory,
    // surfacing the exact upstream sentinel a real Mastra deployment would.
    //
    // This proves the harness CAN fail — so the green result in the first
    // test is meaningful, not a no-op. If the adapter ever stopped
    // forwarding resourceId, the first test would fail the same way this
    // one intentionally does.
    const memory = new StrictMemory();
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: new FakeLocalAgent({
        memory: memory as any,
        streamChunks: [],
      }) as any,
      resourceId: "",
    });

    const { error } = await collectError(
      agent,
      makeInput({ state: { userName: "Alice" } }),
    );

    expect(error.message).toContain("AGENT_MEMORY_MISSING_RESOURCE_ID");
    // Confirm the failure originated at the working-memory sync boundary.
    expect(memory.updateWorkingMemoryCalls.length).toBeGreaterThan(0);
    expect(memory.updateWorkingMemoryCalls[0].resourceId).toBe("");
  });

  it("forwards resourceId to getWorkingMemory on run completion", async () => {
    // emitWorkingMemorySnapshot used to pass bare `this.resourceId` with no
    // fallback. When `resourceId` was undefined, Mastra's real Memory
    // throws AGENT_MEMORY_MISSING_RESOURCE_ID inside getWorkingMemory,
    // which the snapshot helper swallows silently (best-effort). That
    // silent failure shipped working-memory loss without an observable
    // signal. This test asserts getWorkingMemory always receives a
    // non-falsy resourceId — either `this.resourceId` or the threadId
    // fallback — matching every other resourceId site in the adapter.
    const memory = new StrictMemory();
    memory.workingMemoryValue = JSON.stringify({ userName: "Alice" });

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: new FakeLocalAgent({
        memory: memory as any,
        streamChunks: [],
      }) as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(agent, makeInput());

    // getWorkingMemory must have been invoked (fires from onRunFinished
    // via emitWorkingMemorySnapshot) and must have received resourceId.
    expect(memory.getWorkingMemoryCalls.length).toBeGreaterThan(0);
    for (const call of memory.getWorkingMemoryCalls) {
      expect(call.resourceId).toBe("resource-1");
    }

    // The run should complete normally — if getWorkingMemory had thrown
    // AGENT_MEMORY_MISSING_RESOURCE_ID, the snapshot helper would have
    // logged a warning but RUN_FINISHED would still fire. The stronger
    // signal is that no AGENT_MEMORY_MISSING_RESOURCE_ID was thrown.
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("falls back to threadId when this.resourceId is absent on getWorkingMemory", async () => {
    // Load-bearing regression guard for the line-342 consistency fix.
    // Prior to the fix, emitWorkingMemorySnapshot passed `this.resourceId`
    // without a `?? threadId` fallback. If the agent was constructed
    // without a resourceId, getWorkingMemory received undefined and the
    // real Mastra Memory threw AGENT_MEMORY_MISSING_RESOURCE_ID — silently
    // swallowed by the best-effort catch. Every sibling memory call
    // (getThreadById, saveThread, streamMastraAgent.resource) already
    // uses `this.resourceId ?? input.threadId`, so this site must match.
    const memory = new StrictMemory();
    memory.workingMemoryValue = JSON.stringify({ userName: "Alice" });

    // Construct WITHOUT resourceId so the fallback path is exercised.
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: new FakeLocalAgent({
        memory: memory as any,
        streamChunks: [],
      }) as any,
    });

    const events = await collectEvents(
      agent,
      makeInput({ threadId: "thread-xyz" }),
    );

    // getWorkingMemory must receive the threadId fallback, matching the
    // pattern used everywhere else in the adapter.
    expect(memory.getWorkingMemoryCalls.length).toBeGreaterThan(0);
    for (const call of memory.getWorkingMemoryCalls) {
      expect(call.resourceId).toBe("thread-xyz");
    }

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });
});
