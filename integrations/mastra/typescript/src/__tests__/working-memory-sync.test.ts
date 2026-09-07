import { EventType } from "@ag-ui/client";
import {
  FakeMemory,
  makeLocalMastraAgent,
  makeInput,
  collectEvents,
  collectError,
} from "./helpers";

const SIMPLE_STREAM_CHUNKS = [
  { type: "text-delta", payload: { text: "ok" } },
  { type: "finish", payload: {} },
];

/**
 * Memory with thread-scoped working memory: Mastra stores the value in
 * thread.metadata and rejects an update for a thread that does not exist.
 */
class ThreadScopedMemory extends FakeMemory {
  async updateWorkingMemory(args: {
    resourceId?: string;
    threadId?: string;
    workingMemory: string;
    memoryConfig?: any;
  }): Promise<void> {
    if (!this.threads.has(args.threadId!)) {
      throw new Error(`Thread ${args.threadId} not found`);
    }
    await super.updateWorkingMemory(args);
  }
}

describe("input.state -> working memory sync (local agent)", () => {
  it("creates the thread and retries when thread-scoped memory rejects the first turn", async () => {
    const memory = new ThreadScopedMemory();
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    const events = await collectEvents(
      agent,
      makeInput({ threadId: "thread-1", state: { plan: "draft" } }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(memory.createThreadCalls).toEqual([
      { threadId: "thread-1", resourceId: "resource-1" },
    ]);
    expect(memory.updateWorkingMemoryCalls).toHaveLength(1);
    expect(JSON.parse(memory.updateWorkingMemoryCalls[0].workingMemory)).toEqual({
      plan: "draft",
    });
  });

  it("does not create a thread when the update succeeds", async () => {
    const memory = new FakeMemory();
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(agent, makeInput({ state: { plan: "draft" } }));

    expect(memory.createThreadCalls).toEqual([]);
    expect(memory.updateWorkingMemoryCalls).toHaveLength(1);
  });

  it("still fails the run when the update is rejected for an existing thread", async () => {
    const memory = new FakeMemory();
    memory.threads.set("thread-1", { id: "thread-1", resourceId: "resource-1" });
    memory.updateWorkingMemory = async () => {
      throw new Error("storage unavailable");
    };
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    const { error } = await collectError(
      agent,
      makeInput({ threadId: "thread-1", state: { plan: "draft" } }),
    );

    expect(error.message).toBe("storage unavailable");
    expect(memory.createThreadCalls).toEqual([]);
  });
});
