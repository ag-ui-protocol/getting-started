import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { EventSchemas } from "@ag-ui/core";

const eventsUrl = new URL("../resources/contracts/events/", import.meta.url);
const streamsUrl = new URL("../resources/contracts/streams/", import.meta.url);

async function readEvent(name) {
  return JSON.parse(await readFile(new URL(name, eventsUrl), "utf8"));
}

test("canonical JSON events satisfy the official AG-UI schemas", async () => {
  const names = (await readdir(eventsUrl)).filter((name) => name.endsWith(".json"));
  const events = await Promise.all(names.map(readEvent));

  for (const event of events) {
    assert.doesNotThrow(() => EventSchemas.parse(event));
  }

  assert.deepEqual(new Set(events.map(({ type }) => type)), new Set([
    "RUN_STARTED",
    "RUN_FINISHED",
    "RUN_ERROR",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_RESULT",
    "TOOL_CALL_CHUNK",
    "REASONING_START",
    "REASONING_MESSAGE_START",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_END",
    "REASONING_ENCRYPTED_VALUE",
    "REASONING_END",
    "STATE_DELTA",
    "STATE_SNAPSHOT",
    "MESSAGES_SNAPSHOT",
    "CUSTOM",
  ]));
});

test("canonical JSONL streams contain exact schema-valid wire lines", async () => {
  const names = (await readdir(streamsUrl)).filter((name) => name.endsWith(".jsonl"));
  assert.ok(names.length > 0);

  for (const name of names) {
    const content = await readFile(new URL(name, streamsUrl), "utf8");
    for (const line of content.split("\n").filter((candidate) => candidate.length > 0)) {
      const event = JSON.parse(line);
      assert.doesNotThrow(() => EventSchemas.parse(event));
      assert.equal(JSON.stringify(event), line);
    }
  }
});
