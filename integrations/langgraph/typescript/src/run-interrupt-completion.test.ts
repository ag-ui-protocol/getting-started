/**
 * Finding 3 — an interrupt-without-resume turn must NOT error the subscriber.
 *
 * When prepareStream sees a pending interrupt and no resume, it fully handles
 * the run (RUN_STARTED + interrupt-finish + RUN_FINISHED) and completes the
 * subscriber, returning a falsy value. runAgentStream previously treated that
 * falsy return as "no stream" and called subscriber.error("No stream to
 * regenerate") on the ALREADY-COMPLETED subscriber (an RxJS unhandled error
 * on a common HITL path). It must now recognise the run as already settled.
 */

import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

function makeConfig(): LangGraphAgentConfig {
  const agentState = {
    values: { messages: [] },
    // A pending interrupt parked on the thread, no resume incoming.
    tasks: [{ interrupts: [{ id: "int-1", value: "approve?" }] }],
    next: ["node"],
    metadata: { writes: {} },
  };
  const client: any = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      getState: vi.fn().mockResolvedValue(agentState),
      updateState: vi.fn().mockResolvedValue({ checkpoint: { checkpoint_id: "ck-1" } }),
      stream: vi.fn(),
    },
    runs: { cancel: vi.fn(), stream: vi.fn() },
    assistants: {
      search: vi.fn().mockResolvedValue([
        { assistant_id: "asst-1", graph_id: "test-graph", config: {}, metadata: {} },
      ]),
      getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getSchemas: vi.fn().mockResolvedValue({
        input_schema: { properties: { messages: {} } },
        output_schema: { properties: { messages: {} } },
        config_schema: { properties: {} },
        context_schema: { properties: {} },
      }),
    },
  };
  return { deploymentUrl: "http://localhost:2024", graphId: "test-graph", client };
}

describe("interrupt-only run completes without erroring the subscriber", () => {
  it("does not call subscriber.error after completing on an interrupt", async () => {
    const agent = new LangGraphAgent(makeConfig());
    const dispatched: any[] = [];
    agent.dispatchEvent = (event: any) => {
      dispatched.push(event);
      return true as any;
    };

    const next = vi.fn();
    const error = vi.fn();
    const complete = vi.fn();
    const subscriber: any = { next, error, complete, closed: false };

    await agent.runAgentStream(
      {
        threadId: "thread-1",
        runId: "run-1",
        messages: [{ id: "u1", role: "user", content: "hi" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      } as any,
      subscriber,
    );

    // The bug: subscriber.error("No stream to regenerate") fired here.
    expect(error).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);

    // The interrupt turn still surfaced a full lifecycle.
    const types = dispatched.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(
      dispatched.some((e) => e.type === EventType.CUSTOM && e.name === "on_interrupt"),
    ).toBe(true);
  });
});
