import assert from "node:assert/strict";
import test from "node:test";
import { EventTraceRecorder } from "./event-trace-recorder";

function sse(...events: readonly object[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n`).join("\n");
}

test("compares one flattened journey across sequential AG-UI streams", async () => {
  const recorder = new EventTraceRecorder({ settleMs: 0 });

  recorder.observeStream({
    url: "http://dojo.test/api/copilotkit/first",
    body: Promise.resolve(
      sse(
        { type: "RUN_STARTED", threadId: "thread-a", runId: "run-a" },
        { type: "RUN_FINISHED", threadId: "thread-a", runId: "run-a" },
      ),
    ),
  });
  await recorder.settle();
  recorder.observeStream({
    url: "http://dojo.test/api/copilotkit/second",
    body: Promise.resolve(
      sse(
        { type: "RUN_STARTED", threadId: "thread-a", runId: "run-b" },
        { type: "RUN_FINISHED", threadId: "thread-a", runId: "run-b" },
      ),
    ),
  });

  const expected = [
    { type: "RUN_STARTED", threadId: "id-1", runId: "id-2" },
    { type: "RUN_FINISHED", threadId: "id-1", runId: "id-2" },
    { type: "RUN_STARTED", threadId: "id-1", runId: "id-3" },
    { type: "RUN_FINISHED", threadId: "id-1", runId: "id-3" },
  ];

  await recorder.expectJourney(expected, (actual, golden) => {
    assert.deepEqual(actual, golden);
  });
});

test("reports an unasserted journey only when the test would otherwise pass", async () => {
  const passingTestRecorder = new EventTraceRecorder({ settleMs: 0 });
  passingTestRecorder.observeStream({
    url: "http://dojo.test/api/copilotkit/run",
    body: Promise.resolve(sse({ type: "RUN_STARTED" })),
  });

  await assert.rejects(
    passingTestRecorder.finalize({ testAlreadyFailed: false }),
    /emitted AG-UI events but never called expectJourney/,
  );

  const failedTestRecorder = new EventTraceRecorder({ settleMs: 0 });
  failedTestRecorder.observeStream({
    url: "http://dojo.test/api/copilotkit/run",
    body: Promise.resolve(sse({ type: "RUN_STARTED" })),
  });

  await failedTestRecorder.finalize({ testAlreadyFailed: true });
});

test("does not wait for a pending SSE body after the test already failed", async () => {
  const recorder = new EventTraceRecorder({ settleMs: 0 });
  recorder.observeStream({
    url: "http://dojo.test/api/copilotkit/hung",
    body: new Promise(() => {}),
  });

  const result = await Promise.race([
    recorder
      .finalize({ testAlreadyFailed: true })
      .then(() => "finalized" as const),
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), 25),
    ),
  ]);

  assert.equal(result, "finalized");
});

test("fails clearly when an SSE body does not settle before the deadline", async () => {
  const recorder = new EventTraceRecorder({
    settleMs: 0,
    settleTimeoutMs: 10,
  });
  recorder.observeStream({
    url: "http://dojo.test/api/copilotkit/hung",
    body: new Promise(() => {}),
  });

  await assert.rejects(
    recorder.settle(),
    /AG-UI response bodies did not settle within 10ms/,
  );
});

test("rejects a second journey assertion in one test", async () => {
  const recorder = new EventTraceRecorder({ settleMs: 0 });
  recorder.observeStream({
    url: "http://dojo.test/api/copilotkit/run",
    body: Promise.resolve(sse({ type: "RUN_STARTED" })),
  });
  const compare = () => {};

  await recorder.expectJourney([{ type: "RUN_STARTED" }], compare);

  await assert.rejects(
    recorder.expectJourney([{ type: "RUN_STARTED" }], compare),
    /Only one AG-UI journey assertion is allowed per test/,
  );
});

test("rejects an empty journey assertion", async () => {
  const recorder = new EventTraceRecorder({ settleMs: 0 });

  await assert.rejects(
    recorder.expectJourney([], () => {}),
    /captured no non-RAW events/,
  );
});

test("rejects AG-UI events emitted after the journey assertion", async () => {
  const recorder = new EventTraceRecorder({ settleMs: 0 });
  recorder.observeStream({
    url: "http://dojo.test/api/copilotkit/first",
    body: Promise.resolve(sse({ type: "RUN_STARTED" })),
  });
  await recorder.expectJourney([{ type: "RUN_STARTED" }], () => {});

  recorder.observeStream({
    url: "http://dojo.test/api/copilotkit/late",
    body: Promise.resolve(sse({ type: "RUN_FINISHED" })),
  });

  await assert.rejects(
    recorder.finalize({ testAlreadyFailed: false }),
    /emitted AG-UI events after expectJourney/,
  );
});

test("rejects overlapping AG-UI streams", async () => {
  const recorder = new EventTraceRecorder({ settleMs: 0 });
  const first = Promise.withResolvers<string>();

  recorder.observeStream({
    url: "http://dojo.test/api/copilotkit/first",
    body: first.promise,
  });
  recorder.observeStream({
    url: "http://dojo.test/api/copilotkit/second",
    body: Promise.resolve(sse({ type: "RUN_FINISHED" })),
  });
  first.resolve(sse({ type: "RUN_STARTED" }));

  await assert.rejects(
    recorder.expectJourney(
      [{ type: "RUN_STARTED" }, { type: "RUN_FINISHED" }],
      () => {},
    ),
    /Overlapping AG-UI streams/,
  );
});

test("exposes raw and normalized journey artifacts", async () => {
  const recorder = new EventTraceRecorder({ settleMs: 0 });
  const body = sse({
    type: "RUN_STARTED",
    threadId: "generated-thread",
    timestamp: 123,
  });
  recorder.observeStream({
    url: "http://dojo.test/api/copilotkit/run",
    body: Promise.resolve(body),
  });
  await recorder.settle();

  assert.deepEqual(recorder.getArtifacts(), {
    rawStreams: [
      {
        sequence: 0,
        url: "http://dojo.test/api/copilotkit/run",
        body,
      },
    ],
    normalizedJourney: [{ type: "RUN_STARTED", threadId: "id-1" }],
  });
});
