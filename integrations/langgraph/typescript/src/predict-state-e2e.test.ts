/**
 * Outcome tests for the predict_state / state-streaming mechanism.
 *
 * Tests observable behavior: when a tracked tool call streams its args,
 * no STATE_SNAPSHOT with missing state keys should reach subscribers.
 * The fix is correct only if these tests pass.
 */

import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): LangGraphAgentConfig {
  return {
    // Legacy `handleStreamEvents` path — see subgraph-streaming.test.ts
    // for the same opt-out rationale.
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
    client: {
      threads: {
        getState: vi.fn().mockResolvedValue({
          values: { messages: [], copilotkit: {}, todos: [{ id: "real-1", title: "Todo 1" }] },
          tasks: [],
          next: [],
          metadata: { writes: {} },
        }),
      },
      runs: { cancel: vi.fn() },
      assistants: {
        search: vi.fn().mockResolvedValue([{ assistant_id: "asst-1", graph_id: "test-graph", config: {}, metadata: {} }]),
        getGraph: vi.fn().mockResolvedValue({ nodes: [{ id: "model" }, { id: "tools" }], edges: [] }),
      },
    } as any,
  };
}

/** Build an async iterable from an array of stream chunks. */
async function* makeStream(chunks: any[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** Wrap a stream generator in the shape handleStreamEvents expects. */
function makeStreamArg(chunks: any[], initialState: any = {}) {
  return {
    streamResponse: makeStream(chunks),
    state: {
      values: initialState,
      tasks: [],
      next: [],
      metadata: { writes: {} },
    },
  };
}

function makeEventsChunk(event: any) {
  return { event: "events", data: event };
}

function makeValuesChunk(values: any) {
  return { event: "values", data: values };
}

function makeModelStreamEvent(toolName: string, metadata: any = {}) {
  return makeEventsChunk({
    event: "on_chat_model_stream",
    metadata: { langgraph_node: "model", ...metadata },
    data: {
      chunk: {
        content: "",
        response_metadata: {},
        tool_call_chunks: toolName ? [{ name: toolName, args: "", id: "tc1", index: 0 }] : [],
      },
    },
  });
}

function makeChainEndEvent(nodeName: string) {
  return makeEventsChunk({
    event: "on_chain_end",
    metadata: { langgraph_node: nodeName },
    data: { output: { messages: [] } },
  });
}

function makeToolEndEvent(toolName: string, toolCallId: string = "tc1") {
  return makeEventsChunk({
    event: "on_tool_end",
    metadata: { langgraph_node: "tools" },
    data: {
      output: {
        tool_call_id: toolCallId,
        name: toolName,
        content: "Todos updated.",
      },
    },
  });
}

function makeToolErrorEvent(toolName: string) {
  return makeEventsChunk({
    event: "on_tool_error",
    name: toolName,
    metadata: { langgraph_node: "tools" },
    data: { error: new Error("boom") },
  });
}

function makeCommandToolEndEvent(toolName: string, toolCallId: string = "tc1") {
  // LangGraph emits this shape when a tool returns a Command: output has no
  // tool_call_id at the top level; the tool message is nested in update.messages.
  return makeEventsChunk({
    event: "on_tool_end",
    metadata: { langgraph_node: "tools" },
    data: {
      input: {},
      output: {
        update: {
          messages: [
            {
              type: "tool",
              tool_call_id: toolCallId,
              name: toolName,
              content: "Done.",
              id: "msg-1",
            },
          ],
        },
      },
    },
  });
}

async function runStream(chunks: any[], initialState: any = {}) {
  const config = makeConfig();
  const agent = new LangGraphAgent(config);
  const dispatched: any[] = [];
  agent.dispatchEvent = (event: any) => {
    dispatched.push(event);
    return event as any;
  };
  (agent as any).activeRun = {
    id: "run1",
    threadId: "thread1",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
  };

  await (agent as any).handleStreamEventsV2(
    makeStreamArg(chunks, initialState),
    "thread1",
    { next: (e: any) => dispatched.push(e), error: () => {}, complete: () => {} },
    { runId: "run1", threadId: "thread1", messages: [], state: {}, tools: [], context: [] },
    ["events", "values"],
  );

  return dispatched;
}

function stateSnapshots(dispatched: any[]) {
  return dispatched.filter((e) => e.type === EventType.STATE_SNAPSHOT);
}

function snapshotHasTodos(snapshot: any) {
  const s = snapshot.snapshot ?? snapshot;
  return s.todos !== undefined && s.todos !== null;
}

// ---------------------------------------------------------------------------
// Outcome tests
// ---------------------------------------------------------------------------

describe("predict_state: no STATE_SNAPSHOT with absent todos during streaming", () => {

  it("suppresses STATE_SNAPSHOT while manage_todos is streaming args", async () => {
    const predictStateMeta = [{ tool: "manage_todos", state_key: "todos", tool_argument: "todos" }];

    const chunks = [
      // Node name set (snapshot here is fine — before streaming starts)
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "model" }, data: {} }),
      // Tracked tool call starts streaming — modelMadeToolCall set, PredictState fires
      makeModelStreamEvent("manage_todos", { predict_state: predictStateMeta }),
      // State updates with no todos — snapshots must be suppressed from here
      makeValuesChunk({ messages: [], copilotkit: {} }),
      makeValuesChunk({ messages: [{ id: "m1" }], copilotkit: {} }),
      // Tool ends — resets flag
      makeToolEndEvent("manage_todos"),
      // State now has todos
      makeValuesChunk({ messages: [{ id: "m1" }], copilotkit: {}, todos: [{ id: "real-1", title: "Todo 1" }] }),
      makeChainEndEvent("tools"),
    ];

    const dispatched = await runStream(chunks, { messages: [], copilotkit: {} });

    // Find index of PredictState event — snapshots AFTER this must not have absent todos
    const predictStateIdx = dispatched.findIndex(
      (e) => e.type === EventType.CUSTOM && e.name === "PredictState",
    );
    expect(predictStateIdx).toBeGreaterThanOrEqual(0);

    const afterPredictState = dispatched.slice(predictStateIdx + 1);
    const snapshotsWithoutTodos = stateSnapshots(afterPredictState).filter(
      (s) => !snapshotHasTodos(s),
    );
    expect(snapshotsWithoutTodos).toHaveLength(0);
  });

  it("emits STATE_SNAPSHOT with todos after tool completes", async () => {
    const predictStateMeta = [{ tool: "manage_todos", state_key: "todos", tool_argument: "todos" }];

    const chunks = [
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "tools" }, data: {} }),
      makeModelStreamEvent("manage_todos", { predict_state: predictStateMeta }),
      makeValuesChunk({ messages: [], copilotkit: {} }),
      makeToolEndEvent("manage_todos"),
      makeValuesChunk({ messages: [], copilotkit: {}, todos: [{ id: "real-1" }] }),
      makeChainEndEvent("tools"),
    ];

    const dispatched = await runStream(chunks, {});
    const snapshots = stateSnapshots(dispatched);
    const withTodos = snapshots.filter((s) => snapshotHasTodos(s));

    expect(withTodos.length).toBeGreaterThan(0);
  });

  it("untracked tool does NOT suppress STATE_SNAPSHOT", async () => {
    const predictStateMeta = [{ tool: "manage_todos", state_key: "todos", tool_argument: "todos" }];

    const chunks = [
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "model" }, data: {} }),
      // open_canvas is untracked — should NOT suppress
      makeModelStreamEvent("open_canvas", { predict_state: predictStateMeta }),
      makeValuesChunk({ messages: [{ id: "m1" }], copilotkit: {} }),
      makeChainEndEvent("model"),
    ];

    const dispatched = await runStream(chunks, { messages: [], copilotkit: {} });
    const snapshots = stateSnapshots(dispatched);

    // Snapshots should fire (not suppressed) even though they lack todos
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it("PredictState custom event is emitted for tracked tool", async () => {
    const predictStateMeta = [{ tool: "manage_todos", state_key: "todos", tool_argument: "todos" }];

    const chunks = [
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "model" }, data: {} }),
      makeModelStreamEvent("manage_todos", { predict_state: predictStateMeta }),
      makeToolEndEvent("manage_todos"),
    ];

    const dispatched = await runStream(chunks, {});
    const predictStateEvents = dispatched.filter(
      (e) => e.type === EventType.CUSTOM && e.name === "PredictState",
    );

    expect(predictStateEvents).toHaveLength(1);
    expect(predictStateEvents[0].value).toEqual(predictStateMeta);
  });

  it("on_tool_error clears modelMadeToolCall so later snapshots emit", async () => {
    const predictStateMeta = [{ tool: "manage_todos", state_key: "todos", tool_argument: "todos" }];

    const chunks = [
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "model" }, data: {} }),
      makeModelStreamEvent("manage_todos", { predict_state: predictStateMeta }),
      makeToolErrorEvent("manage_todos"),
      // Post-error state update with todos — should emit a snapshot if flag was reset
      makeValuesChunk({ messages: [{ id: "m1" }], copilotkit: {}, todos: [{ id: "real-1" }] }),
      makeChainEndEvent("tools"),
    ];

    const dispatched = await runStream(chunks, { messages: [], copilotkit: {} });
    const snapshots = stateSnapshots(dispatched);
    const withTodos = snapshots.filter(snapshotHasTodos);

    expect(withTodos.length).toBeGreaterThan(0);
  });

  it("Command-style OnToolEnd resets modelMadeToolCall", async () => {
    const predictStateMeta = [{ tool: "manage_todos", state_key: "todos", tool_argument: "todos" }];

    const chunks = [
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "model" }, data: {} }),
      makeModelStreamEvent("manage_todos", { predict_state: predictStateMeta }),
      makeCommandToolEndEvent("manage_todos"),
      makeValuesChunk({ messages: [], copilotkit: {}, todos: [{ id: "real-1" }] }),
      makeChainEndEvent("tools"),
    ];

    const dispatched = await runStream(chunks, { messages: [], copilotkit: {} });
    const snapshots = stateSnapshots(dispatched);
    const withTodos = snapshots.filter(snapshotHasTodos);

    // A snapshot with todos must fire after the Command-style tool end —
    // only possible if modelMadeToolCall/hasFunctionStreaming were reset.
    expect(withTodos.length).toBeGreaterThan(0);
  });

  it("parallel tool calls — untracked OnToolEnd resets flag set by tracked tool", async () => {
    // Documents current behavior: any OnToolEnd unconditionally resets the
    // flag, so an untracked tool finishing first clears the flag before the
    // tracked tool has completed. A post-end state change then emits.
    const predictStateMeta = [{ tool: "manage_todos", state_key: "todos", tool_argument: "todos" }];

    const chunks = [
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "model" }, data: {} }),
      makeModelStreamEvent("manage_todos", { predict_state: predictStateMeta }),
      makeToolEndEvent("search_web", "tc2"),
      makeValuesChunk({ messages: [{ id: "m1" }], copilotkit: {} }),
      makeChainEndEvent("tools"),
    ];

    const dispatched = await runStream(chunks, { messages: [], copilotkit: {} });
    const snapshots = stateSnapshots(dispatched);

    // Flag cleared prematurely → snapshot emits after the untracked tool ended.
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it("PredictState custom event NOT emitted for untracked tool", async () => {
    const predictStateMeta = [{ tool: "manage_todos", state_key: "todos", tool_argument: "todos" }];

    const chunks = [
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "model" }, data: {} }),
      makeModelStreamEvent("open_canvas", { predict_state: predictStateMeta }),
      makeToolEndEvent("open_canvas"),
    ];

    const dispatched = await runStream(chunks, {});
    const predictStateEvents = dispatched.filter(
      (e) => e.type === EventType.CUSTOM && e.name === "PredictState",
    );

    expect(predictStateEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B6 — mid-run state-diff STATE_SNAPSHOT actually fires
//
// updatedState aliased state and was mutated in place, so
// `JSON.stringify(updatedState) !== JSON.stringify(state)` was always false
// and the state-diff branch was dead: state changes while staying on the same
// node emitted no snapshot. Capturing the serialized state before mutation
// restores the trigger.
// ---------------------------------------------------------------------------

describe("B6: state-diff STATE_SNAPSHOT (same node, changing values)", () => {
  it("emits a snapshot when state values change without a node change", async () => {
    const chunks = [
      // First event on node "model" → node-change snapshot (state still empty).
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "model" }, data: {} }),
      // State changes.
      makeValuesChunk({ counter: 1 }),
      // Same node again — only a working state-diff can fire the snapshot here.
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "model" }, data: {} }),
      // State changes again.
      makeValuesChunk({ counter: 2 }),
      // Same node once more.
      makeEventsChunk({ event: "on_chain_start", metadata: { langgraph_node: "model" }, data: {} }),
    ];

    const dispatched = await runStream(chunks, {});
    const snapshots = stateSnapshots(dispatched);
    const counters = snapshots
      .map((s) => (s.snapshot ?? s)?.counter)
      .filter((c) => c !== undefined);

    // The post-run getState mock carries no `counter`, so a snapshot with
    // counter===1 and counter===2 can ONLY come from the mid-run state-diff
    // branch. Before the fix these never appeared (branch was dead).
    expect(counters).toContain(1);
    expect(counters).toContain(2);
  });
});
