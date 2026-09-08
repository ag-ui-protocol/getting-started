import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// A2UI progressive-streaming regression net (AWS Strands Python).
//
// The visible symptom this guards: surfaces must paint progressively (cards
// appearing one by one) instead of in one bulk paint after a long wait. The
// load-bearing mechanism is on the wire — the sub-agent's render_a2ui call
// must stream MANY incremental TOOL_CALL_ARGS deltas (aimock chunks tool-call
// arguments, mirroring the OpenAI chat-completions API), and the middleware
// must emit its "building" lifecycle before the surface paints.
//
// Two historical regressions this catches (both shipped green through the
// surface-only specs):
//  1. Sub-agent ran hidden inside the tool (`invoke()`), no inner events on
//     the wire at all → 0 render_a2ui frames.
//  2. Demo model used the OpenAI Responses API, whose Strands adapter buffers
//     `function_call_arguments.delta` and emits one blob at the end → exactly
//     1 ARGS frame.
// Healthy streaming = many small ARGS frames. Asserting on the COMPLETED
// response body keeps this flake-free (no live timing involved).

// Shared between the sent message and the SSE-capture predicate so they can't
// silently drift apart (a predicate miss = opaque test-timeout hang).
const HOTEL_PROMPT =
  "Use the generate_a2ui tool to create a comparison of 3 hotels with name, location, price per night, and star rating using the StarRating component.";

test("[AWS Strands] A2UI streams render_a2ui args incrementally (no bulk paint)", async ({
  page,
}) => {
  // Capture the runtime's SSE body for the chat run.
  const ssePromise = new Promise<string>((resolve, reject) => {
    page.on("response", async (response) => {
      if (
        // Boundary match (not includes): "/api/copilotkit/aws-strands" is a
        // prefix of the TS integration's ".../aws-strands-typescript" path,
        // while a future trailing slash / sub-path must still match.
        /\/api\/copilotkit\/aws-strands(\/|$)/.test(
          new URL(response.url()).pathname,
        ) &&
        response.request().method() === "POST" &&
        (response.headers()["content-type"] ?? "").includes("text/event-stream") &&
        // Scope to THIS test's chat run — other SSE runs (e.g. suggestion
        // generation) can hit the same endpoint first in batch runs.
        (response.request().postData() ?? "").includes(HOTEL_PROMPT)
      ) {
        try {
          resolve(await response.text());
        } catch (e) {
          reject(e);
        }
      }
    });
  });

  await page.goto("/aws-strands/feature/a2ui_dynamic_schema");
  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(HOTEL_PROMPT);
  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");

  const sse = await ssePromise;

  // The inner render_a2ui call started on the wire…
  const startMatches = sse.match(
    /"type":"TOOL_CALL_START"[^\n]*"toolCallName":"render_a2ui"[^\n]*/g,
  );
  expect(
    startMatches,
    "inner render_a2ui TOOL_CALL_START must reach the wire (sub-agent streaming)",
  ).not.toBeNull();

  // …and its args arrived as MANY incremental deltas, not one blob. The
  // hotel-comparison envelope is ~700 chars; aimock chunks it into well over
  // 3 frames. 1 frame = provider buffering; 0 = sub-agent not streamed.
  const renderStart = startMatches![0];
  const renderCallId = renderStart.match(/"toolCallId":"([^"]+)"/)?.[1];
  expect(renderCallId).toBeTruthy();
  // The id comes off the wire — escape it before regex interpolation.
  const renderCallIdRe = renderCallId!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const argFrames = sse.match(
    new RegExp(`"type":"TOOL_CALL_ARGS"[^\\n]*"toolCallId":"${renderCallIdRe}"`, "g"),
  );
  expect(
    argFrames?.length ?? 0,
    "render_a2ui args must stream as multiple incremental deltas",
  ).toBeGreaterThanOrEqual(3);

  // The middleware's pre-paint lifecycle fired (the "Building interface"
  // skeleton's data source) before the surface painted.
  expect(
    sse.includes('"status":"building"') || sse.includes('\\"status\\":\\"building\\"'),
    "middleware must emit the building lifecycle on the wire",
  ).toBe(true);
});
