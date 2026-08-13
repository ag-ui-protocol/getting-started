/**
 * Regression tests for two code-review findings in agent.ts:
 *
 *  - B3: getCheckpointByMessage recursed on parent_checkpoint; a null parent
 *    re-fetched the full history and recursed forever. A base-case guard now
 *    throws a clear error instead of hanging.
 *
 *  - B7: handleSingleEventV2's OnChatModelStream branch dereferenced
 *    `event.data.chunk.response_metadata.finish_reason` without optional
 *    chaining, crashing when response_metadata is undefined.
 */

import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/client";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

function makeAgent(client: any): LangGraphAgent {
  const config: LangGraphAgentConfig = {
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
    client,
  };
  return new LangGraphAgent(config);
}

// ---------------------------------------------------------------------------
// B3 — getCheckpointByMessage recursion guard
// ---------------------------------------------------------------------------

describe("B3: getCheckpointByMessage recursion guard", () => {
  it("throws (instead of recursing forever) when the message is not last and there is no parent checkpoint", async () => {
    // Single root checkpoint containing the target message with a message
    // AFTER it, and NO parent_checkpoint. The old code would re-fetch the
    // full history with no narrowing and recurse indefinitely.
    const history = [
      {
        values: { messages: [{ id: "m1" }, { id: "m2" }] },
        parent_checkpoint: null,
        checkpoint: { checkpoint_id: "ck-root" },
      },
    ];
    const getHistory = vi.fn().mockResolvedValue(history);
    const agent = makeAgent({ threads: { getHistory }, runs: { cancel: vi.fn() } });

    await expect(
      agent.getCheckpointByMessage("m1", "thread-1"),
    ).rejects.toThrow(/no parent checkpoint/i);
    // The guard fires without a runaway loop of history fetches.
    expect(getHistory).toHaveBeenCalledTimes(1);
  });

  it("still resolves normally when the target message is the last in its checkpoint", async () => {
    // getHistory returns newest → oldest; the implementation reverses it.
    const history = [
      {
        values: { messages: [{ id: "m1" }, { id: "m2" }] },
        parent_checkpoint: { checkpoint_id: "ck-0", checkpoint_ns: "" },
        checkpoint: { checkpoint_id: "ck-1" },
      },
      {
        values: { messages: [{ id: "m1" }] },
        parent_checkpoint: null,
        checkpoint: { checkpoint_id: "ck-0" },
      },
    ];
    const getHistory = vi.fn().mockResolvedValue(history);
    const agent = makeAgent({ threads: { getHistory }, runs: { cancel: vi.fn() } });

    // m2 is the last message in ck-1 → no recursion, returns a checkpoint.
    const result = await agent.getCheckpointByMessage("m2", "thread-1");
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// B7 — OnChatModelStream tolerates a missing response_metadata
// ---------------------------------------------------------------------------

describe("B7: OnChatModelStream missing response_metadata", () => {
  function agentWithRun() {
    const agent = makeAgent({ runs: { cancel: vi.fn() } });
    const events: any[] = [];
    (agent as any).dispatchEvent = (e: any) => {
      events.push(e);
      return true;
    };
    (agent as any).activeRun = {
      id: "run-1",
      threadId: "thread-1",
      hasFunctionStreaming: false,
      modelMadeToolCall: false,
    };
    (agent as any).messagesInProcess = {};
    (agent as any).emittedToolCallStartIds = new Set();
    return { agent, events };
  }

  it("does not throw and streams the text when the chunk has no response_metadata", () => {
    const { agent, events } = agentWithRun();

    expect(() =>
      agent.handleSingleEventV2({
        event: "on_chat_model_stream",
        metadata: {},
        data: {
          chunk: {
            id: "m1",
            content: "hello",
            // response_metadata deliberately omitted (was a hard crash).
          },
        },
      }),
    ).not.toThrow();

    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_START)).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_CONTENT && e.delta === "hello",
      ),
    ).toBe(true);
  });
});
