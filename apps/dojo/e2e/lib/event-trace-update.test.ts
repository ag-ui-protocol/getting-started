import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "prettier";
import test from "node:test";
import {
  assertEventTraceMatches,
  createEventTraceUpdateCandidate,
  planEventTraceUpdates,
  renderEventTraceModule,
  summarizeEventTraceDiff,
  writeEventTraceUpdateCandidate,
} from "./event-trace-update";
import { defineEventTrace } from "./event-trace-golden";

async function importGeneratedModule(modulePath: string) {
  const generated: unknown = await import(pathToFileURL(modulePath).href);
  return generated;
}

test("creates an update candidate from invisible golden metadata", () => {
  const golden = defineEventTrace(
    "file:///repo/agenticChatPage.event-trace.ts",
    {
      sendsAndReceivesMessage: [],
    },
  );
  const events = [{ type: "RUN_STARTED" }];

  assert.deepEqual(
    createEventTraceUpdateCandidate({
      lane: "typescript",
      expected: golden.sendsAndReceivesMessage,
      actual: events,
    }),
    {
      lane: "typescript",
      sourceUrl: "file:///repo/agenticChatPage.event-trace.ts",
      journeyKey: "sendsAndReceivesMessage",
      events,
    },
  );
});

test("writes update candidates only to the requested staging directory", async () => {
  const stagingDirectory = await mkdtemp(
    join(tmpdir(), "event-trace-update-test-"),
  );
  const candidate = {
    lane: "typescript",
    sourceUrl: "file:///repo/agenticChatPage.event-trace.ts",
    journeyKey: "sendsAndReceivesMessage",
    events: [{ type: "RUN_STARTED" }],
  };

  try {
    await writeEventTraceUpdateCandidate({
      stagingDirectory,
      testId: "agentic-chat-send",
      candidate,
    });

    const files = await readdir(join(stagingDirectory, "typescript"));
    assert.equal(files.length, 1);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(stagingDirectory, "typescript", files[0]), "utf8"),
      ),
      candidate,
    );
  } finally {
    await rm(stagingDirectory, { recursive: true });
  }
});

test("rejects multiple candidates for one golden destination", () => {
  const events = [{ type: "RUN_STARTED", threadId: "id-1" }];

  assert.throws(
    () =>
      planEventTraceUpdates([
        {
          lane: "typescript",
          sourceUrl: "file:///repo/agenticChatPage.event-trace.ts",
          journeyKey: "sendsAndReceivesMessage",
          events,
        },
        {
          lane: "python",
          sourceUrl: "file:///repo/agenticChatPage.event-trace.ts",
          journeyKey: "sendsAndReceivesMessage",
          events,
        },
      ]),
    /Duplicate Event trace candidates.*typescript and python/,
  );
});

test("reports an ordinary golden mismatch at the first differing event path", () => {
  const expected = defineEventTrace(
    "file:///repo/apps/dojo/e2e/tests/langgraphTypescriptTests/agenticChatPage.event-trace.ts",
    {
      retainsMemory: [
        { type: "RUN_STARTED" },
        {
          type: "STATE_SNAPSHOT",
          snapshot: { messages: [{ content: "expected memory" }] },
        },
      ],
    },
  );

  assert.throws(
    () =>
      assertEventTraceMatches(
        [
          { type: "RUN_STARTED" },
          {
            type: "STATE_SNAPSHOT",
            snapshot: { messages: [{ content: "actual memory" }] },
          },
        ],
        expected.retainsMemory,
      ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /tests\/langgraphTypescriptTests\/agenticChatPage\.event-trace\.ts#retainsMemory/,
      );
      assert.match(error.message, /events: expected=2, actual=2/);
      assert.match(
        error.message,
        /event 1: expected STATE_SNAPSHOT, actual STATE_SNAPSHOT/,
      );
      assert.match(
        error.message,
        /first difference: events\[1\]\.snapshot\.messages\[0\]\.content/,
      );
      assert.match(error.message, /expected: "expected memory"/);
      assert.match(error.message, /actual: "actual memory"/);
      assert.match(error.message, /Full traces are attached/);
      assert.ok(error.message.length < 1_500);
      return true;
    },
  );
});

test("renders deterministic reviewable TypeScript with the update reason", async () => {
  const rendered = await renderEventTraceModule({
    exportName: "agenticChatPageEventTrace",
    importPath: "../../event-trace-test",
    reason: "Establish the main/V2 baseline.",
    journeys: {
      sendsAndReceivesMessage: [{ type: "RUN_STARTED", threadId: "id-1" }],
    },
  });

  assert.match(rendered, /Reason: Establish the main\/V2 baseline\./);
  assert.match(
    rendered,
    /export const agenticChatPageEventTrace = defineEventTrace\(import\.meta\.url/,
  );
  assert.doesNotMatch(rendered, /timestamp|Generated at|202\d-/);
  assert.equal(rendered, await format(rendered, { parser: "typescript" }));
});

test("renders repeated structures compactly without changing the imported trace", async () => {
  const repeatedSnapshot = {
    type: "STATE_SNAPSHOT",
    snapshot: {
      messages: [
        {
          id: "id-1",
          role: "assistant",
          content:
            "A deliberately repeated response with enough structure to intern.",
        },
      ],
      copilotkit: {
        actions: [{ name: "change_background", arguments: { color: "blue" } }],
      },
    },
  };
  const journeys = {
    repeatedSnapshots: Array.from({ length: 6 }, () =>
      structuredClone(repeatedSnapshot),
    ),
  };
  const options = {
    exportName: "eventTrace",
    importPath: new URL("./event-trace-golden.ts", import.meta.url).href,
    reason: "Prove compact exact rendering.",
    journeys,
  };

  const rendered = await renderEventTraceModule(options);
  assert.equal(rendered, await renderEventTraceModule(options));
  assert.match(rendered, /const shared\d+ =/);
  assert.ok(rendered.length < JSON.stringify(journeys, null, 2).length * 0.7);

  const directory = await mkdtemp(join(tmpdir(), "event-trace-module-test-"));
  const modulePath = join(directory, "event-trace.ts");
  try {
    await writeFile(modulePath, rendered, "utf8");
    const generated = await importGeneratedModule(modulePath);
    assert.ok(typeof generated === "object" && generated !== null);
    assert.deepEqual(Reflect.get(generated, "eventTrace"), journeys);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("summarizes the first semantic event difference for review", () => {
  assert.deepEqual(
    summarizeEventTraceDiff(
      {
        sendsAndReceivesMessage: [
          { type: "RUN_STARTED" },
          { type: "RUN_FINISHED" },
        ],
      },
      {
        sendsAndReceivesMessage: [
          { type: "RUN_STARTED" },
          { type: "STATE_SNAPSHOT" },
          { type: "RUN_FINISHED" },
        ],
      },
    ),
    [
      'sendsAndReceivesMessage: 2 -> 3 events; first difference at events[1].type: "RUN_FINISHED" -> "STATE_SNAPSHOT"',
    ],
  );

  assert.deepEqual(
    summarizeEventTraceDiff(
      {
        changesBackground: [
          { type: "STATE_SNAPSHOT", snapshot: { color: "blue" } },
        ],
      },
      {
        changesBackground: [
          { type: "STATE_SNAPSHOT", snapshot: { color: "pink" } },
        ],
      },
    ),
    [
      'changesBackground: 1 -> 1 events; first difference at events[0].snapshot.color: "blue" -> "pink"',
    ],
  );
});
