import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// A2UI error-recovery showcase — AWS Strands (Python) port.
//
// Same behavior bar as the LangGraph TS recovery spec, driven by the SAME
// framework-agnostic aimock fixtures (apps/dojo/e2e/a2ui-recovery-fixtures.ts):
// the sub-agent's first render_a2ui is a Row whose repeated child references a
// `card` template the model "forgot" to include (structural "unresolved
// child"); the toolkit feeds the error back and the second attempt is valid.
//
// DevEx under test: the Strands dojo agent is a plain Strands agent with
// NO a2ui tool wiring. The CopilotKit runtime sends
// `injectA2UITool`, and the ag_ui_strands adapter infers the model from
// the wrapped agent and auto-injects `generate_a2ui` — no get_a2ui_tools()
// call in the example server.

test("[AWS Strands] A2UI recovery — invalid render recovers to a valid surface", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 luxury hotels with ratings and prices.");

  // The faulty first attempt is suppressed (no wipe); the regenerated valid
  // surface paints.
  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll(["The Ritz", "Holiday Inn", "Boutique Loft"]);
});

test("[AWS Strands] A2UI recovery — exhaustion: hard-failure UI, no faulty paint, chat stays usable", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 broken hotels with ratings and prices.");

  // Anchor on the run's terminal signal FIRST — asserting count-0 right after
  // send would pass trivially before the agent produced anything. The
  // tasteful hard-failure message rides the same renderer path as the
  // LangGraph recovery demo (the recovery activity is produced by the shared
  // @ag-ui/a2ui-middleware, regardless of backend framework). Target the
  // title specifically to avoid Playwright strict-mode matching the
  // "Something went wrong…" subtitle as well.
  await expect(
    page.getByText("Couldn't generate the UI").first(),
  ).toBeVisible({ timeout: 30_000 });

  // Every attempt is invalid → no faulty surface ever paints. The no-wipe
  // invariant holds even under total exhaustion. This is the server-side
  // guarantee (middleware gate + adapter loop) and is independent of the
  // client renderer.
  await expect(a2ui.surface("hotel-comparison")).toHaveCount(0);

  // Conversation remains usable after the hard failure: the follow-up turn is
  // accepted and rendered (not swallowed by a stuck/broken stream).
  await a2ui.sendMessage("Thanks anyway.");
  await a2ui.assertUserMessageVisible("Thanks anyway.");
});
