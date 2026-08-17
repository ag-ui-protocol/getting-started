import assert from "node:assert/strict";
import test from "node:test";
import {
  EventTraceSseParseError,
  normalizeEventTrace,
  parseEventTraceSse,
} from "./event-trace-events";

test("parses every ordered non-RAW event without deduplicating snapshots", () => {
  const events = parseEventTraceSse(
    [
      'data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}',
      "",
      'data: {"type":"STATE_SNAPSHOT","snapshot":{"count":1}}',
      "",
      'data: {"type":"RAW","event":{"private":true}}',
      "",
      'data: {"type":"STATE_SNAPSHOT","snapshot":{"count":1}}',
      "",
      'data: {"type":"RUN_FINISHED","threadId":"thread-a","runId":"run-a"}',
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["RUN_STARTED", "STATE_SNAPSHOT", "STATE_SNAPSHOT", "RUN_FINISHED"],
  );
});

test("ignores empty SSE data frames", () => {
  const events = parseEventTraceSse(
    [
      "data:",
      "",
      "data:   ",
      "",
      "data",
      "",
      'data: {"type":"RUN_STARTED"}',
      "",
    ].join("\n"),
  );

  assert.deepEqual(events, [{ type: "RUN_STARTED" }]);
});

test("normalizes generated identities while retaining their relationships", () => {
  const normalized = normalizeEventTrace([
    {
      type: "TOOL_CALL_START",
      toolCallId: "generated-call",
      toolCallName: "lookup",
      timestamp: 123,
    },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        {
          id: "generated-message",
          role: "assistant",
          toolCalls: [{ id: "generated-call", name: "lookup" }],
        },
        {
          id: "generated-result",
          role: "tool",
          toolCallId: "generated-call",
        },
      ],
    },
  ]);

  assert.deepEqual(normalized, [
    {
      type: "TOOL_CALL_START",
      toolCallId: "id-1",
      toolCallName: "lookup",
    },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        {
          id: "id-2",
          role: "assistant",
          toolCalls: [{ id: "id-1", name: "lookup" }],
        },
        { id: "id-3", role: "tool", toolCallId: "id-1" },
      ],
    },
  ]);
});

test("normalizes LangGraph and model identities only in captured test traces", () => {
  const runId = "019fff57-a2dc-76a8-9006-130a727563d9";
  const threadId = "cbf4e664-85d5-48fe-9c3e-f9f6e47102d1";
  // LangGraph checkpoint IDs are UUID-shaped but do not always carry RFC
  // version/variant bits, so identity normalization must accept the shape.
  const checkpointId = "f80e7e50-053d-ad30-c895-22300a175b85";
  const requestId = "d1642ee1-80e8-4b3e-888d-202c3789c86f";
  const appContext =
    'App Context:\n{\n  "copilotkit_forwarded_headers": {\n    "x-forwarded-for": "::1",\n    "x-forwarded-host": "localhost:8989",\n    "x-forwarded-port": "8989",\n    "x-forwarded-proto": "http"\n  }\n}';

  const normalized = normalizeEventTrace([
    {
      type: "STATE_SNAPSHOT",
      snapshot: {
        timestamp: "application-owned-timestamp",
        copilotkit: { originalAIMessageId: "message-generated-at-runtime" },
      },
      rawEvent: {
        data: {
          run_id: runId,
          chunk: { id: "chatcmpl-generated-at-runtime", content: "hello" },
          output: { id: "chatcmpl-generated-at-runtime", content: "hello" },
          metadata: {
            thread_id: threadId,
            run_id: runId,
            langgraph_request_id: requestId,
            parent_ids: [runId, requestId],
            langgraph_api_url: "http://127.0.0.1:8985",
            langgraph_version: "1.3.0",
            langgraph_api_version: "0.7.96",
            graph_id: "semantic-agent-id",
            langgraph_checkpoint_ns: `agent:${checkpointId}:tools`,
            checkpoint_ns: checkpointId,
          },
        },
      },
    },
    {
      type: "STATE_SNAPSHOT",
      rawEvent: {
        data: [
          {
            id: "chatcmpl-generated-at-runtime",
            type: "ai",
            content: "hello",
            response_metadata: { model_provider: "openai" },
          },
          {
            id: "5325dca2-a9cd-4eef-82fb-78a2f1723278",
            type: "system",
            content: appContext,
          },
        ],
      },
    },
  ]);

  assert.deepEqual(normalized, [
    {
      type: "STATE_SNAPSHOT",
      snapshot: {
        timestamp: "application-owned-timestamp",
        copilotkit: { originalAIMessageId: "id-1" },
      },
      rawEvent: {
        data: {
          run_id: "id-2",
          chunk: { id: "id-3", content: "hello" },
          output: { id: "id-3", content: "hello" },
          metadata: {
            thread_id: "id-4",
            run_id: "id-2",
            langgraph_request_id: "id-5",
            parent_ids: ["id-2", "id-5"],
            langgraph_api_url: "<langgraph-api-url>",
            langgraph_version: "<langgraph-version>",
            langgraph_api_version: "<langgraph-api-version>",
            graph_id: "semantic-agent-id",
            langgraph_checkpoint_ns: "agent:id-6:tools",
            checkpoint_ns: "id-6",
          },
        },
      },
    },
    {
      type: "STATE_SNAPSHOT",
      rawEvent: {
        data: [
          {
            id: "id-3",
            type: "ai",
            content: "hello",
            response_metadata: { model_provider: "openai" },
          },
          {
            id: "id-7",
            type: "system",
            content:
              'App Context:\n{\n  "copilotkit_forwarded_headers": {\n    "x-forwarded-for": "<forwarded-for>",\n    "x-forwarded-host": "<forwarded-host>",\n    "x-forwarded-port": "<forwarded-port>",\n    "x-forwarded-proto": "<forwarded-proto>"\n  }\n}',
          },
        ],
      },
    },
  ]);
});

test("retains the complete SSE response when a data frame is malformed", () => {
  const body = [
    'data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}',
    "",
    "data: definitely-not-json",
    "",
  ].join("\n");

  assert.throws(
    () => parseEventTraceSse(body),
    (error) =>
      error instanceof EventTraceSseParseError &&
      error.responseBody === body &&
      error.frameIndex === 1,
  );
});
