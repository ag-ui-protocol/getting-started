import assert from "node:assert/strict";
import test from "node:test";
import { isEventTraceResponse } from "./event-trace-response";

test("identifies only POST SSE responses from the Dojo CopilotKit route", () => {
  assert.equal(
    isEventTraceResponse({
      method: "POST",
      url: "http://dojo.test/api/copilotkit/langgraph",
      contentType: "text/event-stream; charset=utf-8",
    }),
    true,
  );
  assert.equal(
    isEventTraceResponse({
      method: "POST",
      url: "http://dojo.test/api/copilotkit/langgraph",
      contentType: "application/json",
    }),
    false,
  );
  assert.equal(
    isEventTraceResponse({
      method: "GET",
      url: "http://dojo.test/api/copilotkit/langgraph",
      contentType: "text/event-stream",
    }),
    false,
  );
  assert.equal(
    isEventTraceResponse({
      method: "POST",
      url: "http://dojo.test/api/unrelated",
      contentType: "text/event-stream",
    }),
    false,
  );
});
