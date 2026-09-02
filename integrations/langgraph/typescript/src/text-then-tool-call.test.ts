import { EventType } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { LangGraphAgent } from "./agent";

function createAgent() {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });
  const events: any[] = [];
  (agent as any).subscriber = { next: (e: any) => events.push(e) };
  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
  };
  (agent as any).messagesInProcess = {};
  (agent as any).emittedToolCallStartIds = new Set();
  return { agent, events };
}

function streamChunk(content: unknown[], toolCallChunks: unknown[] = []) {
  return {
    event: "on_chat_model_stream",
    metadata: { "emit-messages": true, "emit-tool-calls": true },
    data: {
      chunk: {
        id: "msg-1",
        content,
        tool_call_chunks: toolCallChunks,
        response_metadata: {},
      },
    },
  };
}

describe("LangGraphAgent text followed by a tool call in one message", () => {
  it("starts the tool call carried by the chunk that ends the streamed text", () => {
    const { agent, events } = createAgent();

    // Anthropic content-block streaming: a text block, then a tool_use block
    // with empty args, then input_json_delta chunks, then the end chunk.
    const chunks = [
      streamChunk([
        { type: "text", text: "Building the dashboard.", index: 0 },
      ]),
      streamChunk(
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "render_ui",
            input: {},
            index: 1,
          },
        ],
        [
          {
            name: "render_ui",
            args: "",
            id: "call-1",
            index: 1,
            type: "tool_call_chunk",
          },
        ],
      ),
      streamChunk(
        [
          {
            type: "input_json_delta",
            partial_json: '{"surfaceId":"x"}',
            index: 1,
          },
        ],
        [
          {
            name: null,
            args: '{"surfaceId":"x"}',
            id: null,
            index: 1,
            type: "tool_call_chunk",
          },
        ],
      ),
      streamChunk([]),
    ];
    for (const chunk of chunks) agent.handleSingleEvent(chunk);

    expect(events.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);
    expect(events[3]).toMatchObject({
      toolCallId: "call-1",
      toolCallName: "render_ui",
    });
    expect(events[4]).toMatchObject({
      toolCallId: "call-1",
      delta: '{"surfaceId":"x"}',
    });
    expect((agent as any).activeRun.hasFunctionStreaming).toBe(true);
  });
});
