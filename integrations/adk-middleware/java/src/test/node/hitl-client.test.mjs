import assert from "node:assert/strict";
import test from "node:test";

import { HttpAgent } from "@ag-ui/client";

import { readJsonLines, startSseServer } from "./support/sse-server.mjs";

const streamsUrl = new URL("../resources/contracts/streams/", import.meta.url);

test("real HttpAgent submits an approved HITL result on the next turn", async () => {
  const requestEvents = await readJsonLines(new URL("hitl-approval-request.jsonl", streamsUrl));
  const approvedEvents = await readJsonLines(new URL("hitl-approved.jsonl", streamsUrl));
  const server = await startSseServer([requestEvents, approvedEvents]);
  try {
    const agent = new HttpAgent({
      url: server.url,
      threadId: "thread-hitl-approval",
      initialMessages: [{ id: "user-hitl-approval", role: "user", content: "Publish" }],
    });

    const firstResult = await agent.runAgent();
    agent.addMessage({
      id: "approval-result",
      role: "tool",
      toolCallId: "approval-call",
      content: '{"approved":true}',
    });
    const secondResult = await agent.runAgent();

    assert.deepEqual(firstResult.result, { status: "pending-confirmation" });
    assert.deepEqual(secondResult.result, { status: "approved" });
    assert.equal(server.requests.length, 2);
    assert.deepEqual(
      server.requests[1].body.messages.at(-1),
      {
        id: "approval-result",
        role: "tool",
        toolCallId: "approval-call",
        content: '{"approved":true}',
      },
    );
    assert.equal(secondResult.newMessages[0].content, "Approval accepted");
  } finally {
    await server.close();
  }
});

test("real HttpAgent submits a rejected HITL result on the next turn", async () => {
  const requestEvents = await readJsonLines(new URL("hitl-rejection-request.jsonl", streamsUrl));
  const rejectedEvents = await readJsonLines(new URL("hitl-rejected.jsonl", streamsUrl));
  const server = await startSseServer([requestEvents, rejectedEvents]);
  try {
    const agent = new HttpAgent({
      url: server.url,
      threadId: "thread-hitl-rejection",
      initialMessages: [{ id: "user-hitl-rejection", role: "user", content: "Delete" }],
    });

    const firstResult = await agent.runAgent();
    agent.addMessage({
      id: "rejection-result",
      role: "tool",
      toolCallId: "rejection-call",
      content: '{"approved":false}',
    });
    const secondResult = await agent.runAgent();

    assert.deepEqual(firstResult.result, { status: "pending-confirmation" });
    assert.deepEqual(secondResult.result, { status: "rejected" });
    assert.equal(server.requests.length, 2);
    assert.deepEqual(
      server.requests[1].body.messages.at(-1),
      {
        id: "rejection-result",
        role: "tool",
        toolCallId: "rejection-call",
        content: '{"approved":false}',
      },
    );
    assert.equal(secondResult.newMessages[0].content, "Approval rejected");
  } finally {
    await server.close();
  }
});
