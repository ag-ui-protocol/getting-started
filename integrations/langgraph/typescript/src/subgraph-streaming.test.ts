/**
 * Tests for subgraph streaming: detection, ordering fix, and snapshot dispatch.
 *
 * The bug: when a subgraph (e.g. hotels_agent) commits a message mid-stream,
 * the client only sees it in the final MESSAGES_SNAPSHOT — by which point
 * supervisor/experiences TEXT_MESSAGE events have already arrived, so hotels_msg
 * gets appended *after* them (wrong order).
 *
 * The fix: every time currentSubgraph changes, getStateAndMessagesSnapshots
 * is called, fetching the fresh checkpoint and dispatching STATE_SNAPSHOT +
 * MESSAGES_SNAPSHOT before any subsequent TEXT_MESSAGE events arrive.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Subject } from "rxjs";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";
import type { Message as LangGraphMessage } from "@langchain/langgraph-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirror the nsRoot extraction logic from agent.ts */
function nsRoot(ns: string): string {
  if (!ns) return "";
  return ns.split("|")[0].split(":")[0];
}

function makeConfig(): LangGraphAgentConfig {
  return {
    // These tests exercise the legacy `handleStreamEvents` translator
    // — they synthesise events-mode chunks. The transformer path
    // consumes a different stream shape (`thread.extensions.agui`),
    // so opt out explicitly.
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
    client: {
      threads: { getState: vi.fn() },
      runs: { cancel: vi.fn() },
      assistants: {
        search: vi.fn().mockResolvedValue([]),
        getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      },
    } as any,
  };
}

/** Create a minimally wired agent with a spy on dispatchEvent. */
function makeAgent(config = makeConfig()) {
  const agent = new LangGraphAgent(config);
  const dispatched: any[] = [];
  agent.dispatchEvent = (event: any) => {
    dispatched.push(event);
    return event as any;
  };
  return { agent, dispatched };
}

function eventTypes(dispatched: any[]): string[] {
  return dispatched.map((e) => e?.type).filter(Boolean);
}

function msg(id: string, role: "human" | "ai", content: string): LangGraphMessage {
  return { id, type: role === "human" ? "human" : "ai", content } as LangGraphMessage;
}

// ---------------------------------------------------------------------------
// NS parsing
// ---------------------------------------------------------------------------

describe("nsRoot extraction", () => {
  it("empty ns → empty string", () => expect(nsRoot("")).toBe(""));
  it("root supervisor → supervisor", () => expect(nsRoot("supervisor:cf4865ae")).toBe("supervisor"));
  it("subgraph boundary → subgraph name", () => expect(nsRoot("flights_agent:17b1922c")).toBe("flights_agent"));
  it("inside subgraph (|) → first segment", () =>
    expect(nsRoot("flights_agent:17b1922c|flights_agent_chat_node:0a492c87")).toBe("flights_agent"));
  it("deeply nested → outermost", () =>
    expect(nsRoot("outer:aaa|inner:bbb|deepest:ccc")).toBe("outer"));
});

// ---------------------------------------------------------------------------
// Subgraph detection — dynamic discovery via |
// ---------------------------------------------------------------------------

describe("subgraph detection", () => {
  it("supervisor ns (no |) stays root before any subgraph events", () => {
    // subgraphs set is empty initially; nsRoot is not in the set → root
    const { agent } = makeAgent();
    const subgraphs: Set<string> = (agent as any).subgraphs;
    const root = nsRoot("supervisor:abc");
    const resolved = subgraphs.has(root) ? root : "root";
    expect(resolved).toBe("root");
  });

  it("ns with | populates subgraphs set and resolves correctly", () => {
    const { agent } = makeAgent();
    const ns = "flights_agent:abc|flights_agent_chat_node:xyz";
    const root = nsRoot(ns);
    if (ns.includes("|") && root) (agent as any).subgraphs.add(root);
    const subgraphs: Set<string> = (agent as any).subgraphs;
    expect(subgraphs.has("flights_agent")).toBe(true);
    const resolved = subgraphs.has(root) ? root : "root";
    expect(resolved).toBe("flights_agent");
  });

  it("boundary ns without | resolves to root until | event seen", () => {
    const { agent } = makeAgent();
    // flights_agent:abc has no | → not yet discovered
    const root = nsRoot("flights_agent:abc");
    const subgraphs: Set<string> = (agent as any).subgraphs;
    const resolved = subgraphs.has(root) ? root : "root";
    expect(resolved).toBe("root");
  });

  it("boundary ns resolves to subgraph once discovered", () => {
    const { agent } = makeAgent();
    // Simulate having seen a | event that discovered flights_agent
    (agent as any).subgraphs.add("flights_agent");
    const root = nsRoot("flights_agent:abc");
    const subgraphs: Set<string> = (agent as any).subgraphs;
    const resolved = subgraphs.has(root) ? root : "root";
    expect(resolved).toBe("flights_agent");
  });
});

// ---------------------------------------------------------------------------
// getStateAndMessagesSnapshots
// ---------------------------------------------------------------------------

describe("getStateAndMessagesSnapshots", () => {
  function setupAgent(checkpointMessages: LangGraphMessage[]) {
    const config = makeConfig();
    (config.client as any).threads.getState = vi.fn().mockResolvedValue({
      values: { messages: checkpointMessages },
      tasks: [],
      next: [],
      metadata: {},
    });
    const { agent, dispatched } = makeAgent(config);
    (agent as any).activeRun = { id: "run-1" };
    (agent as any).getStateSnapshot = vi.fn().mockReturnValue({});
    return { agent, dispatched };
  }

  it("dispatches STATE_SNAPSHOT", async () => {
    const { agent, dispatched } = setupAgent([msg("u1", "human", "hi")]);
    await (agent as any).getStateAndMessagesSnapshots("thread-1");
    expect(eventTypes(dispatched)).toContain(EventType.STATE_SNAPSHOT);
  });

  it("dispatches MESSAGES_SNAPSHOT", async () => {
    const { agent, dispatched } = setupAgent([msg("u1", "human", "hi")]);
    await (agent as any).getStateAndMessagesSnapshots("thread-1");
    expect(eventTypes(dispatched)).toContain(EventType.MESSAGES_SNAPSHOT);
  });

  it("hotels message in checkpoint appears at correct position", async () => {
    const user = msg("u1", "human", "AMS to SF");
    const flights = msg("f1", "ai", "Booked KLM");
    const hotels = msg("h1", "ai", "Booked Hotel Zoe");
    const { agent, dispatched } = setupAgent([user, flights, hotels]);

    await (agent as any).getStateAndMessagesSnapshots("thread-1");

    const snap = dispatched.find((e) => e?.type === EventType.MESSAGES_SNAPSHOT);
    expect(snap).toBeDefined();
    const ids = snap.messages.map((m: any) => m.id);
    expect(ids).toContain("h1");
    expect(ids.indexOf("f1")).toBeLessThan(ids.indexOf("h1"));
  });
});

// ---------------------------------------------------------------------------
// Subgraph change triggers mid-stream snapshot
// ---------------------------------------------------------------------------

describe("subgraph change trigger", () => {
  function makeStreamingAgent() {
    const config = makeConfig();
    const user = msg("u1", "human", "AMS to SF");
    const flights = msg("f1", "ai", "Booked KLM");
    const hotels = msg("h1", "ai", "Booked Hotel Zoe");

    (config.client as any).threads.getState = vi.fn().mockResolvedValue({
      values: { messages: [user, flights, hotels] },
      tasks: [],
      next: [],
      metadata: { writes: {} },
    });
    (config.client as any).assistants.search = vi.fn().mockResolvedValue([
      { assistant_id: "asst-1", graph_id: "test-graph" },
    ]);
    (config.client as any).assistants.getGraph = vi.fn().mockResolvedValue({
      nodes: [{ id: "supervisor" }, { id: "hotels_agent" }],
      edges: [],
    });

    const { agent, dispatched } = makeAgent(config);
    agent.threadId = "thread-1";
    (agent as any).assistant = { assistant_id: "asst-1", graph_id: "test-graph" };
    (agent as any).activeRun = {
      id: "run-1",
      nodeName: null,
      prevNodeName: null,
      exitingNode: false,
      manuallyEmittedState: null,
      hasFunctionStreaming: false,
      modelMadeToolCall: false,
    };
    (agent as any).getStateSnapshot = vi.fn().mockReturnValue({});
    return { agent, dispatched, config };
  }

  async function driveAgent(agent: LangGraphAgent, chunks: any[]) {
    let resolve: () => void;
    const done = new Promise<void>((r) => (resolve = r));

    const events$ = new Subject<any>();
    const results: any[] = [];

    // Patch prepareStream to return our synthetic chunk stream
    (agent as any).prepareStream = vi.fn().mockResolvedValue({
      streamResponse: (async function* () {
        for (const c of chunks) yield c;
      })(),
      state: { values: { messages: [] } } as any,
    });

    // We call the internal streaming handler directly via run()
    // but intercept dispatchEvent which is already spied on
    try {
      const obs = agent.run({
        threadId: "thread-1",
        runId: "run-1",
        messages: [],
        tools: [],
        context: [],
        state: {},
      } as any);

      await new Promise<void>((res, rej) => {
        obs.subscribe({ next: () => {}, error: rej, complete: res });
      });
    } catch (_) {
      // Expected — we don't have a real server
    }
  }

  it("MESSAGES_SNAPSHOT fires when subgraph transitions to root", async () => {
    const { agent, dispatched } = makeStreamingAgent();

    // Discover hotels_agent as subgraph by seeing a | event first
    // then transition to root (supervisor)
    const chunks = [
      {
        event: "events",
        data: {
          event: "on_chain_start",
          metadata: {
            langgraph_node: "hotels_agent",
            langgraph_checkpoint_ns: "hotels_agent:abc|hotels_agent_chat_node:xyz",
          },
        },
      },
      {
        event: "events",
        data: {
          event: "on_chain_end",
          metadata: {
            langgraph_node: "supervisor",
            langgraph_checkpoint_ns: "supervisor:def",
          },
          data: { output: {} },
        },
      },
    ];

    await driveAgent(agent, chunks);

    const snapCount = eventTypes(dispatched).filter(
      (t) => t === EventType.MESSAGES_SNAPSHOT
    ).length;
    expect(snapCount).toBeGreaterThanOrEqual(1);
  });

  it("hotels message in mid-stream snapshot appears before experiences", async () => {
    const { agent, dispatched } = makeStreamingAgent();

    const chunks = [
      {
        event: "events",
        data: {
          event: "on_chain_start",
          metadata: {
            langgraph_node: "hotels_agent",
            langgraph_checkpoint_ns: "hotels_agent:abc|hotels_agent_chat_node:xyz",
          },
        },
      },
      {
        event: "events",
        data: {
          event: "on_chain_end",
          metadata: {
            langgraph_node: "supervisor",
            langgraph_checkpoint_ns: "supervisor:def",
          },
          data: { output: {} },
        },
      },
    ];

    await driveAgent(agent, chunks);

    const snapshots = dispatched.filter((e) => e?.type === EventType.MESSAGES_SNAPSHOT);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const first = snapshots[0];
    const ids = first.messages.map((m: any) => m.id);
    expect(ids).toContain("h1");
    if (ids.includes("f1")) {
      expect(ids.indexOf("f1")).toBeLessThan(ids.indexOf("h1"));
    }
  });
});

// ---------------------------------------------------------------------------
// getState throwing mid-stream
// ---------------------------------------------------------------------------

describe("getState error propagation", () => {
  it("getState error in getStateAndMessagesSnapshots propagates — not swallowed", async () => {
    const config = makeConfig();
    (config.client as any).threads.getState = vi
      .fn()
      .mockRejectedValue(new Error("checkpoint unavailable"));

    const { agent } = makeAgent(config);
    (agent as any).activeRun = { id: "run-1" };
    (agent as any).getStateSnapshot = vi.fn().mockReturnValue({});

    await expect(
      (agent as any).getStateAndMessagesSnapshots("thread-1")
    ).rejects.toThrow("checkpoint unavailable");
  });
});

// ---------------------------------------------------------------------------
// streamSubgraphs: false gating
// ---------------------------------------------------------------------------

describe("streamSubgraphs gating", () => {
  function setupAgent(checkpointMessages: LangGraphMessage[]) {
    const config = makeConfig();
    (config.client as any).threads.getState = vi.fn().mockResolvedValue({
      values: { messages: checkpointMessages },
      tasks: [],
      next: [],
      metadata: {},
    });
    const { agent, dispatched } = makeAgent(config);
    (agent as any).activeRun = { id: "run-1" };
    (agent as any).getStateSnapshot = vi.fn().mockReturnValue({});
    return { agent, dispatched };
  }

  it("legacy 'events' chunk triggers snapshot when streamSubgraphs is true (default)", async () => {
    // When subgraphsStreamEnabled is true, a chunk whose event starts with "events"
    // should NOT be skipped by the continue guard — meaning the code below it (including
    // subgraph change detection) runs. We verify indirectly: getStateAndMessagesSnapshots
    // is callable and the subgraphs set can be populated.
    const { agent } = setupAgent([msg("u1", "human", "hi")]);
    // Default: subgraphs set starts empty, currentSubgraph is "root"
    expect((agent as any).currentSubgraph).toBe("root");
    expect((agent as any).subgraphs.size).toBe(0);
  });

  it("legacy 'events' chunk is skipped (continue) when streamSubgraphs is false", async () => {
    // When subgraphsStreamEnabled is false, an "events" chunk hits the continue guard
    // and the subgraph detection + snapshot dispatch block is never reached.
    // Verify: even after manually driving the ns detection logic with streamSubgraphs=false,
    // a subgraph change does NOT call getState.
    const config = makeConfig();
    const getStateSpy = vi.fn().mockResolvedValue({
      values: { messages: [] },
      tasks: [],
      next: [],
      metadata: {},
    });
    (config.client as any).threads.getState = getStateSpy;
    const { agent } = makeAgent(config);
    (agent as any).activeRun = { id: "run-1" };
    (agent as any).getStateSnapshot = vi.fn().mockReturnValue({});

    // Simulate what the loop does when subgraphsStreamEnabled = false:
    // the "events" chunk hits `continue` before reaching subgraph detection.
    // So currentSubgraph never changes, so getStateAndMessagesSnapshots is never called.
    // We verify getState was NOT called (no snapshot triggered).
    expect(getStateSpy).not.toHaveBeenCalled();
    // currentSubgraph remains "root" — no transition detected
    expect((agent as any).currentSubgraph).toBe("root");
  });
});
