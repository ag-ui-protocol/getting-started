/**
 * Finding 4 — handleStreamEventsV2 must NOT emit any event after RUN_ERROR.
 *
 * AG-UI verify forbids events after a terminal RUN_ERROR. The v2 handler
 * previously ran its whole post-loop tail (threads.getState → STATE_SNAPSHOT
 * → MESSAGES_SNAPSHOT → RUN_FINISHED) even after emitting RUN_ERROR. The
 * `runErrored` guard (already present on the v3 handler) now short-circuits
 * that tail.
 */

import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

function makeConfig(): { config: LangGraphAgentConfig; getState: any } {
  const getState = vi.fn().mockResolvedValue({
    values: { messages: [] },
    tasks: [],
    next: [],
    metadata: { writes: {} },
  });
  return {
    config: {
      deploymentUrl: "http://localhost:2024",
      graphId: "test-graph",
      client: { threads: { getState }, runs: { cancel: vi.fn() } } as any,
    },
    getState,
  };
}

async function* makeStream(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

describe("v2 RUN_ERROR is terminal", () => {
  it("emits no STATE/MESSAGES snapshot or RUN_FINISHED after RUN_ERROR", async () => {
    const { config, getState } = makeConfig();
    const agent = new LangGraphAgent(config);
    const dispatched: any[] = [];
    agent.dispatchEvent = (event: any) => {
      dispatched.push(event);
      return true as any;
    };
    (agent as any).activeRun = {
      id: "run1",
      threadId: "thread1",
      hasFunctionStreaming: false,
      modelMadeToolCall: false,
    };

    const stream = {
      streamResponse: makeStream([
        { event: "error", data: { message: "boom" } },
      ]),
      state: { values: {} },
    };

    await (agent as any).handleStreamEventsV2(
      stream,
      "thread1",
      { next: (e: any) => dispatched.push(e), error: () => {}, complete: () => {} },
      { runId: "run1", threadId: "thread1", messages: [], state: {}, tools: [], context: [], forwardedProps: {} },
      ["events", "values", "updates", "messages-tuple"],
    );

    const types = dispatched.map((e) => e.type);
    expect(types).toContain(EventType.RUN_ERROR);
    expect(types).not.toContain(EventType.RUN_FINISHED);
    expect(types).not.toContain(EventType.STATE_SNAPSHOT);
    expect(types).not.toContain(EventType.MESSAGES_SNAPSHOT);

    // RUN_ERROR is the last event dispatched — nothing follows it.
    const lastError = types.lastIndexOf(EventType.RUN_ERROR);
    expect(lastError).toBe(types.length - 1);

    // The post-loop getState scan was skipped entirely.
    expect(getState).not.toHaveBeenCalled();
  });
});
