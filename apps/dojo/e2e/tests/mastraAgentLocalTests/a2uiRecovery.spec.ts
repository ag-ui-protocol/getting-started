import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// A2UI error-recovery showcase — Mastra (local) port.
//
// Same behavior bar as the LangGraph TS / AWS Strands recovery specs, driven by
// the SAME framework-agnostic aimock fixtures
// (apps/dojo/e2e/a2ui-recovery-fixtures.ts): the render_a2ui subagent's first
// attempt is a Row whose repeated child references a `card` template the model
// "forgot" to include (structural "unresolved child"); the toolkit's recovery
// loop feeds the error back and the second attempt is valid.
//
// DevEx under test: the Mastra dojo agent binds `generate_a2ui` via the shared
// `getA2UITools` factory from `@ag-ui/mastra` (backend-owned; the CopilotKit
// runtime applies @ag-ui/a2ui-middleware with injectA2UITool=false, so it
// renders without double-injecting). The recovery loop runs inside the tool.

test("[MastraAgentLocal] A2UI recovery — invalid render recovers to a valid surface", async ({
  page,
}) => {
  await page.goto("/mastra-agent-local/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 luxury hotels with ratings and prices.");

  // The faulty first attempt is suppressed (no wipe); the regenerated valid
  // surface paints.
  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll([
    "The Ritz",
    "Holiday Inn",
    "Boutique Loft",
  ]);
});

test("[MastraAgentLocal] A2UI recovery — exhaustion: hard-failure UI, no faulty paint, chat stays usable", async ({
  page,
}) => {
  await page.goto("/mastra-agent-local/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 broken hotels with ratings and prices.");

  // Anchor on the run's terminal signal FIRST — asserting count-0 right after
  // send would pass trivially before the agent produced anything. The tasteful
  // hard-failure message rides the shared @ag-ui/a2ui-middleware recovery
  // renderer, regardless of backend framework.
  await expect(page.getByText("Couldn't generate the UI").first()).toBeVisible({
    timeout: 30_000,
  });

  // Every attempt is invalid → no faulty surface ever paints. The no-wipe
  // invariant holds even under total exhaustion (middleware gate + recovery
  // loop, server-side).
  await expect(a2ui.surface("hotel-comparison")).toHaveCount(0);

  // Conversation remains usable after the hard failure: the follow-up turn is
  // accepted and rendered (not swallowed by a stuck/broken stream).
  await a2ui.sendMessage("Thanks anyway.");
  await a2ui.assertUserMessageVisible("Thanks anyway.");
});
