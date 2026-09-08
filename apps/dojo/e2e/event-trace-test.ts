import type { Response, TestInfo } from "@playwright/test";
import { test as isolatedTest, expect } from "./test-isolation-helper";
import type { TraceEvent } from "./lib/event-trace-events";
import { defineEventTrace } from "./lib/event-trace-golden";
import { EventTraceRecorder } from "./lib/event-trace-recorder";
import { isEventTraceResponse } from "./lib/event-trace-response";
import {
  assertEventTraceMatches,
  createEventTraceUpdateCandidate,
  writeEventTraceUpdateCandidate,
} from "./lib/event-trace-update";

type EventTraceAssertions = {
  expectJourney(expected: readonly TraceEvent[]): Promise<void>;
};

function getUpdateMode() {
  const stagingDirectory = process.env.EVENT_TRACE_UPDATE_STAGING_DIR;
  const lane = process.env.EVENT_TRACE_UPDATE_LANE;
  if (!stagingDirectory && !lane) return undefined;
  if (!stagingDirectory || !lane) {
    throw new Error(
      "Event trace update mode requires EVENT_TRACE_UPDATE_STAGING_DIR and EVENT_TRACE_UPDATE_LANE",
    );
  }
  return { stagingDirectory, lane };
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: "application/json",
  });
}

async function attachEventTraceArtifacts(
  testInfo: TestInfo,
  recorder: EventTraceRecorder,
  expected?: readonly TraceEvent[],
) {
  const artifacts = recorder.getArtifacts();
  await attachJson(testInfo, "event-trace-raw-streams", artifacts.rawStreams);
  await attachJson(
    testInfo,
    "event-trace-normalized-journey",
    artifacts.normalizedJourney ?? {
      captureError: artifacts.captureError,
    },
  );
  if (expected) {
    await attachJson(testInfo, "event-trace-expected-journey", expected);
  }
}

function observeResponse(response: Response, recorder: EventTraceRecorder) {
  const request = response.request();
  if (
    !isEventTraceResponse({
      method: request.method(),
      url: response.url(),
      contentType: response.headers()["content-type"],
    })
  ) {
    return;
  }

  recorder.observeStream({
    url: response.url(),
    body: response.body().then((body) => body.toString("utf8")),
  });
}

export const test = isolatedTest.extend<{ eventTrace: EventTraceAssertions }>({
  eventTrace: [
    async ({ page }, provide, testInfo) => {
      const recorder = new EventTraceRecorder();
      const updateMode = getUpdateMode();
      let artifactsAttached = false;
      const responseListener = (response: Response) => {
        observeResponse(response, recorder);
      };
      page.on("response", responseListener);

      const eventTrace: EventTraceAssertions = {
        expectJourney: async (expected) => {
          try {
            await recorder.expectJourney(expected, async (actual, golden) => {
              if (!updateMode) {
                assertEventTraceMatches(actual, golden);
                return;
              }

              const candidate = createEventTraceUpdateCandidate({
                lane: updateMode.lane,
                expected: golden,
                actual,
              });
              await writeEventTraceUpdateCandidate({
                stagingDirectory: updateMode.stagingDirectory,
                testId: testInfo.testId,
                candidate,
              });
            });
          } catch (error) {
            await attachEventTraceArtifacts(testInfo, recorder, expected);
            artifactsAttached = true;
            throw error;
          }
        },
      };

      await provide(eventTrace);

      const testAlreadyFailed = testInfo.status !== testInfo.expectedStatus;
      try {
        await recorder.finalize({ testAlreadyFailed });
      } catch (error) {
        if (!artifactsAttached) {
          await attachEventTraceArtifacts(testInfo, recorder);
          artifactsAttached = true;
        }
        throw error;
      } finally {
        page.off("response", responseListener);
        if (testAlreadyFailed && !artifactsAttached) {
          await attachEventTraceArtifacts(testInfo, recorder);
        }
      }
    },
    { auto: true },
  ],
});

export { defineEventTrace, expect };
export type { TraceEvent };
