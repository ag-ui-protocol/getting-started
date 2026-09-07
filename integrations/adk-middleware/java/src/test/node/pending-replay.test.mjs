import assert from "node:assert/strict";
import test from "node:test";

import { HttpAgent } from "@ag-ui/client";

import { readJsonLines, startSseServer } from "./support/sse-server.mjs";

const streamsUrl = new URL("../resources/contracts/streams/", import.meta.url);

test("pending replay emits only tool-call IDs absent from client history", async () => {
  const events = await readJsonLines(new URL("pending-replay.jsonl", streamsUrl));
  const server = await startSseServer([events]);
  try {
    const observedEvents = [];
    const agent = new HttpAgent({
      url: server.url,
      threadId: "thread-replay",
      initialMessages: [
        { id: "user-replay", role: "user", content: "Show sports" },
        {
          id: "message-known",
          role: "assistant",
          toolCalls: [{
            id: "known-call",
            type: "function",
            function: { name: "show_sports_list", arguments: '{"league":"premier"}' },
          }],
        },
      ],
    });

    await agent.runAgent({}, {
      onEvent: ({ event }) => observedEvents.push(event),
    });

    assert.deepEqual(
      observedEvents
        .filter(({ type }) => type === "TOOL_CALL_START")
        .map(({ toolCallId }) => toolCallId),
      ["unknown-call"],
    );
    assert.deepEqual(
      server.requests[0].body.messages[1].toolCalls.map(({ id }) => id),
      ["known-call"],
    );
  } finally {
    await server.close();
  }
});
