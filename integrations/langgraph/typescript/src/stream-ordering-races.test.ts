import {
  EventType,
  type MessagesSnapshotEvent,
  type StateSnapshotEvent,
} from "@ag-ui/core";
// @langchain/langgraph-sdk is a graph persistence client, not an LLM provider;
// aimock does not apply to these synthetic stream-reader tests.
import type {
  Assistant,
  EventsStreamEvent,
  Message as LangGraphMessage,
  MessagesTupleStreamEvent,
  ThreadState,
} from "@langchain/langgraph-sdk";
import { describe, expect, it, vi } from "vitest";
import { LangGraphAgent, type ProcessedEvents } from "./agent";

type StreamChunk = EventsStreamEvent | MessagesTupleStreamEvent;

const TEST_ASSISTANT: Assistant = {
  assistant_id: "assistant-1",
  graph_id: "test-graph",
  config: {},
  context: {},
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  metadata: {},
  version: 1,
  name: "test assistant",
};

function threadState(values: Record<string, unknown>): ThreadState {
  return {
    values,
    next: [],
    checkpoint: {
      thread_id: "thread-1",
      checkpoint_ns: "",
      checkpoint_id: null,
      checkpoint_map: null,
    },
    metadata: {},
    created_at: null,
    parent_checkpoint: null,
    tasks: [],
  };
}

function eventChunk(
  event: string,
  metadata: Record<string, unknown>,
  data: unknown,
): EventsStreamEvent {
  return {
    event: "events",
    data: {
      event,
      name: "test event",
      tags: [],
      run_id: "run-1",
      metadata,
      parent_ids: [],
      data,
    },
  };
}

function lateMessageTuple(): MessagesTupleStreamEvent {
  const message: LangGraphMessage = {
    id: "late-message",
    type: "ai",
    content: "",
  };
  return {
    event: "messages",
    data: [message, { tags: [], langgraph_node: "tools" }],
  };
}

async function runUntilStreamError(
  agent: LangGraphAgent,
  chunks: StreamChunk[],
  initialState: ThreadState,
) {
  const streamError = new Error("stop after inspected chunk");
  async function* streamResponse(): AsyncGenerator<StreamChunk> {
    yield* chunks;
    throw streamError;
  }

  agent.assistant = TEST_ASSISTANT;
  vi.spyOn(agent, "prepareStream").mockResolvedValue({
    streamResponse: streamResponse(),
    state: initialState,
  });

  const events: ProcessedEvents[] = [];
  await new Promise<void>((resolve, reject) => {
    agent
      .run({
        threadId: "thread-1",
        runId: "run-1",
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .subscribe({
        next: (event) => events.push(event),
        error: (error) => {
          if (error === streamError) resolve();
          else reject(error);
        },
        complete: () => reject(new Error("stream completed before sentinel")),
      });
  });
  return events;
}

describe("load-dependent stream ordering", () => {
  it("does not let a late ignored messages tuple trigger a state snapshot", async () => {
    const agent = new LangGraphAgent({
      deploymentUrl: "http://localhost:2024",
      graphId: "test-graph",
    });
    const state = threadState({ messages: [] });

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chat_model_stream",
          { langgraph_node: "tools" },
          { chunk: { content: "", response_metadata: {} } },
        ),
        eventChunk(
          "on_chain_end",
          { langgraph_node: "tools" },
          { output: state.values },
        ),
        eventChunk(
          "on_tool_end",
          { langgraph_node: "tools" },
          {
            output: {
              tool_call_id: "tool-1",
              name: "test_tool",
              content: "done",
            },
          },
        ),
        lateMessageTuple(),
      ],
      state,
    );

    const tupleSnapshots = events.filter(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT &&
        event.rawEvent?.event === "messages",
    );
    expect(tupleSnapshots).toEqual([]);
  });

  it("uses the pre-entry root state when live thread state is ahead", async () => {
    const agent = new LangGraphAgent({
      deploymentUrl: "http://localhost:2024",
      graphId: "test-graph",
    });
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const rootAssistant: LangGraphMessage = {
      id: "root-1",
      type: "ai",
      content: "I will find experiences next",
    };
    const futureExperience: LangGraphMessage = {
      id: "experience-1",
      type: "ai",
      content: "Future experiences response",
    };
    const preEntryState = threadState({
      messages: [user, rootAssistant],
      itinerary: { city: "Amsterdam" },
    });
    const getState = vi
      .spyOn(agent.client.threads, "getState")
      .mockResolvedValue(
        threadState({
          messages: [user, rootAssistant, futureExperience],
          itinerary: {
            city: "Amsterdam",
            experience: "Canal tour",
          },
        }),
      );

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "experiences_agent",
            langgraph_checkpoint_ns:
              "experiences_agent:outer|experiences_agent_node:inner",
          },
          {},
        ),
      ],
      preEntryState,
    );

    expect(getState).not.toHaveBeenCalled();
    const stateSnapshot = events.find(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT,
    );
    expect(stateSnapshot?.snapshot).toEqual(preEntryState.values);
    const messagesSnapshot = events.find(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshot?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "root-1",
    ]);
    expect(
      messagesSnapshot?.messages.map((message) => message.id),
    ).not.toContain("experience-1");
  });

  it("seeds the first subgraph boundary from root on_chain_end object output without a values chunk", async () => {
    const agent = new LangGraphAgent({
      deploymentUrl: "http://localhost:2024",
      graphId: "test-graph",
    });
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const preEntryState = threadState({
      messages: [user],
      itinerary: { city: "Amsterdam" },
    });
    const getState = vi
      .spyOn(agent.client.threads, "getState")
      .mockResolvedValue(
        threadState({
          messages: [
            user,
            { id: "live-1", type: "ai", content: "Live thread state" },
          ],
          itinerary: { city: "Rotterdam" },
        }),
      );

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chain_end",
          { langgraph_node: "planner", langgraph_checkpoint_ns: "" },
          { output: { itinerary: { city: "Amsterdam", hotel: "Hotel Zoe" } } },
        ),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "experiences_agent",
            langgraph_checkpoint_ns:
              "experiences_agent:outer|experiences_agent_node:inner",
          },
          {},
        ),
      ],
      preEntryState,
    );

    expect(getState).not.toHaveBeenCalled();
    // The boundary snapshot is the one without a rawEvent; per-chunk node
    // change snapshots carry the triggering chunk.
    const boundarySnapshot = events.find(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT && event.rawEvent === undefined,
    );
    expect(boundarySnapshot?.snapshot).toEqual({
      messages: [user],
      itinerary: { city: "Amsterdam", hotel: "Hotel Zoe" },
    });
    const messagesSnapshot = events.find(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshot?.messages.map((message) => message.id)).toEqual([
      "user-1",
    ]);
  });

  it("seeds the first subgraph boundary from root on_chain_end Command.update without a values chunk", async () => {
    const agent = new LangGraphAgent({
      deploymentUrl: "http://localhost:2024",
      graphId: "test-graph",
    });
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const preEntryState = threadState({
      messages: [user],
      itinerary: { city: "Amsterdam" },
    });
    const getState = vi
      .spyOn(agent.client.threads, "getState")
      .mockResolvedValue(
        threadState({
          messages: [
            user,
            { id: "live-1", type: "ai", content: "Live thread state" },
          ],
          itinerary: { city: "Rotterdam" },
        }),
      );

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chain_end",
          { langgraph_node: "planner", langgraph_checkpoint_ns: "" },
          {
            output: [
              {
                lg_name: "Command",
                update: {
                  itinerary: { city: "Amsterdam", hotel: "Hotel Zoe" },
                },
              },
            ],
          },
        ),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "experiences_agent",
            langgraph_checkpoint_ns:
              "experiences_agent:outer|experiences_agent_node:inner",
          },
          {},
        ),
      ],
      preEntryState,
    );

    expect(getState).not.toHaveBeenCalled();
    const boundarySnapshot = events.find(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT && event.rawEvent === undefined,
    );
    expect(boundarySnapshot?.snapshot).toEqual({
      messages: [user],
      itinerary: { city: "Amsterdam", hotel: "Hotel Zoe" },
    });
    const messagesSnapshot = events.find(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshot?.messages.map((message) => message.id)).toEqual([
      "user-1",
    ]);
  });
});
