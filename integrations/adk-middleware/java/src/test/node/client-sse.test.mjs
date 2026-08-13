import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { HttpAgent } from "./support/ag-ui-client-esm.mjs";
import { readJsonLines, startSseServer } from "./support/sse-server.mjs";

const { HttpAgent: CommonJsHttpAgent } = createRequire(import.meta.url)("@ag-ui/client");

const streamsUrl = new URL("../resources/contracts/streams/", import.meta.url);

test("real HttpAgent consumes canonical SSE text and terminal events", async () => {
  const events = await readJsonLines(new URL("client-success.jsonl", streamsUrl));
  const server = await startSseServer([events]);
  try {
    const observedTypes = [];
    const agent = new HttpAgent({
      url: server.url,
      threadId: "thread-client",
      initialMessages: [{ id: "user-client", role: "user", content: "Hello" }],
    });

    const result = await agent.runAgent({}, {
      onEvent: ({ event }) => observedTypes.push(event.type),
    });

    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, "POST");
    assert.equal(server.requests[0].body.threadId, "thread-client");
    assert.deepEqual(observedTypes, events.map(({ type }) => type));
    assert.deepEqual(result.result, { status: "ok" });
    assert.equal(result.newMessages.length, 1);
    assert.equal(result.newMessages[0].content, "Hello from ADK");
  } finally {
    await server.close();
  }
});

test("real HttpAgent expands same-name frontend chunks into distinct tool calls", async () => {
  const events = await readJsonLines(new URL("frontend-tool-chunks.jsonl", streamsUrl));
  const server = await startSseServer([events]);
  try {
    const observedEvents = [];
    const agent = new HttpAgent({
      url: server.url,
      threadId: "thread-tool-chunks",
      initialMessages: [{ id: "user-tool-chunks", role: "user", content: "Show sports" }],
    });

    const result = await agent.runAgent({}, {
      onEvent: ({ event }) => observedEvents.push(event),
    });

    assert.deepEqual(observedEvents.map(({ type }) => type), [
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
    assert.deepEqual(
      observedEvents
        .filter(({ type }) => type === "TOOL_CALL_START")
        .map(({ toolCallId, toolCallName }) => ({ toolCallId, toolCallName })),
      [
        { toolCallId: "frontend-call-one", toolCallName: "show_sports_list" },
        { toolCallId: "frontend-call-two", toolCallName: "show_sports_list" },
      ],
    );
    assert.deepEqual(
      result.newMessages[0].toolCalls.map(({ id, function: call }) => ({
        id,
        name: call.name,
        arguments: call.arguments,
      })),
      [
        { id: "frontend-call-one", name: "show_sports_list", arguments: '{"league":"premier"}' },
        { id: "frontend-call-two", name: "show_sports_list", arguments: '{"league":"championship"}' },
      ],
    );
  } finally {
    await server.close();
  }
});

test("real HttpAgent keeps encrypted reasoning separate and applies state updates", async () => {
  assert.notEqual(HttpAgent, CommonJsHttpAgent);

  const events = await readJsonLines(new URL("state-reasoning.jsonl", streamsUrl));
  const server = await startSseServer([events]);
  try {
    const observedEvents = [];
    const stateBeforeSnapshots = [];
    const agent = new HttpAgent({
      url: server.url,
      threadId: "thread-state-reasoning",
      initialMessages: [{ id: "user-state-reasoning", role: "user", content: "Explain" }],
      initialState: { phase: "draft", score: 0 },
    });

    const result = await agent.runAgent({}, {
      onEvent: ({ event }) => observedEvents.push(event),
      onStateSnapshotEvent: ({ state }) => stateBeforeSnapshots.push(structuredClone(state)),
    });

    assert.deepEqual(observedEvents.map(({ type }) => type), events.map(({ type }) => type));
    assert.deepEqual(stateBeforeSnapshots, [{ phase: "ready", score: 1 }]);
    assert.deepEqual(agent.state, { phase: "complete", score: 2 });
    assert.deepEqual(
      result.newMessages.map(({ role, content, encryptedValue }) => ({
        role,
        content,
        encryptedValue,
      })),
      [
        {
          role: "reasoning",
          content: "Private reasoning",
          encryptedValue: "ciphertext-reasoning",
        },
        {
          role: "assistant",
          content: "Public answer",
          encryptedValue: undefined,
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("real HttpAgent preserves history through third and subsequent ordinary turns", async () => {
  const firstEvents = await readJsonLines(new URL("ordinary-turn-one.jsonl", streamsUrl));
  const secondEvents = await readJsonLines(new URL("ordinary-turn-two.jsonl", streamsUrl));
  const thirdEvents = await readJsonLines(new URL("ordinary-turn-three.jsonl", streamsUrl));
  const server = await startSseServer([firstEvents, secondEvents, thirdEvents]);
  try {
    const agent = new HttpAgent({
      url: server.url,
      threadId: "thread-ordinary-turns",
      initialMessages: [{ id: "user-ordinary-one", role: "user", content: "First" }],
    });

    const firstResult = await agent.runAgent({ runId: "run-request-one" });
    agent.addMessage({ id: "user-ordinary-two", role: "user", content: "Second" });
    const secondResult = await agent.runAgent({ runId: "run-request-two" });
    agent.addMessage({ id: "user-ordinary-three", role: "user", content: "Third" });
    const thirdResult = await agent.runAgent({ runId: "run-request-three" });

    assert.deepEqual(
      [firstResult, secondResult, thirdResult].map(({ result, newMessages }) => ({
        result,
        content: newMessages[0].content,
      })),
      [
        { result: { turn: 1 }, content: "First answer" },
        { result: { turn: 2 }, content: "Second answer" },
        { result: { turn: 3 }, content: "Third answer" },
      ],
    );
    assert.deepEqual(
      server.requests.map(({ body }) => body),
      [
        {
          threadId: "thread-ordinary-turns",
          runId: "run-request-one",
          tools: [],
          context: [],
          forwardedProps: {},
          state: {},
          messages: [{ id: "user-ordinary-one", role: "user", content: "First" }],
        },
        {
          threadId: "thread-ordinary-turns",
          runId: "run-request-two",
          tools: [],
          context: [],
          forwardedProps: {},
          state: {},
          messages: [
            { id: "user-ordinary-one", role: "user", content: "First" },
            { id: "assistant-ordinary-one", role: "assistant", content: "First answer" },
            { id: "user-ordinary-two", role: "user", content: "Second" },
          ],
        },
        {
          threadId: "thread-ordinary-turns",
          runId: "run-request-three",
          tools: [],
          context: [],
          forwardedProps: {},
          state: {},
          messages: [
            { id: "user-ordinary-one", role: "user", content: "First" },
            { id: "assistant-ordinary-one", role: "assistant", content: "First answer" },
            { id: "user-ordinary-two", role: "user", content: "Second" },
            { id: "assistant-ordinary-two", role: "assistant", content: "Second answer" },
            { id: "user-ordinary-three", role: "user", content: "Third" },
          ],
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("real HttpAgent exposes coded terminal run errors", async () => {
  const events = await readJsonLines(new URL("terminal-error.jsonl", streamsUrl));
  const server = await startSseServer([events]);
  try {
    const observedEvents = [];
    const terminalErrors = [];
    const agent = new HttpAgent({
      url: server.url,
      threadId: "thread-terminal-error",
      initialMessages: [{ id: "user-terminal-error", role: "user", content: "Persist" }],
    });

    const result = await agent.runAgent({}, {
      onEvent: ({ event }) => observedEvents.push(event),
      onRunErrorEvent: ({ event }) => terminalErrors.push(event),
    });

    assert.deepEqual(observedEvents.map(({ type }) => type), ["RUN_STARTED", "RUN_ERROR"]);
    assert.deepEqual(
      terminalErrors.map(({ message, code }) => ({ message, code })),
      [{ message: "Persistence failed", code: "PERSISTENCE_FAILURE" }],
    );
    assert.equal(result.result, undefined);
    assert.deepEqual(result.newMessages, []);
  } finally {
    await server.close();
  }
});

test("real HttpAgent correlates backend tool results with complete tool calls", async () => {
  const events = await readJsonLines(new URL("backend-tool-result.jsonl", streamsUrl));
  const server = await startSseServer([events]);
  try {
    const observedEvents = [];
    const agent = new HttpAgent({
      url: server.url,
      threadId: "thread-backend-tool",
      initialMessages: [{ id: "user-backend-tool", role: "user", content: "Get score" }],
    });

    const result = await agent.runAgent({}, {
      onEvent: ({ event }) => observedEvents.push(event),
    });

    assert.deepEqual(observedEvents.map(({ type }) => type), [
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ]);
    assert.deepEqual(
      result.newMessages[0].toolCalls.map(({ id, function: call }) => ({
        id,
        name: call.name,
        arguments: call.arguments,
      })),
      [{ id: "backend-call-one", name: "lookup_score", arguments: '{"team":"Lions"}' }],
    );
    assert.deepEqual(
      {
        role: result.newMessages[1].role,
        toolCallId: result.newMessages[1].toolCallId,
        content: result.newMessages[1].content,
      },
      {
        role: "tool",
        toolCallId: "backend-call-one",
        content: '{"score":"2-1"}',
      },
    );
  } finally {
    await server.close();
  }
});
