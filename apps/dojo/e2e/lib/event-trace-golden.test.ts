import assert from "node:assert/strict";
import test from "node:test";
import {
  defineEventTrace,
  getEventTraceDestination,
} from "./event-trace-golden";

test("associates each plain journey array with its generated destination", () => {
  const golden = defineEventTrace("file:///agenticChatPage.event-trace.ts", {
    sendsAndReceivesMessage: [{ type: "RUN_STARTED" }],
    retainsMemory: [{ type: "RUN_FINISHED" }],
  });

  assert.deepEqual(getEventTraceDestination(golden.sendsAndReceivesMessage), {
    sourceUrl: "file:///agenticChatPage.event-trace.ts",
    journeyKey: "sendsAndReceivesMessage",
  });
  assert.deepEqual(getEventTraceDestination(golden.retainsMemory), {
    sourceUrl: "file:///agenticChatPage.event-trace.ts",
    journeyKey: "retainsMemory",
  });
});

test("keeps distinct destinations when compact goldens reuse one journey array", () => {
  const sharedJourney = [{ type: "RUN_STARTED" }] as const;
  const golden = defineEventTrace("file:///a2uiRecovery.event-trace.ts", {
    staysUsable: sharedJourney,
    showsHardFailure: sharedJourney,
  });

  assert.deepEqual(getEventTraceDestination(golden.staysUsable), {
    sourceUrl: "file:///a2uiRecovery.event-trace.ts",
    journeyKey: "staysUsable",
  });
  assert.deepEqual(getEventTraceDestination(golden.showsHardFailure), {
    sourceUrl: "file:///a2uiRecovery.event-trace.ts",
    journeyKey: "showsHardFailure",
  });
});
