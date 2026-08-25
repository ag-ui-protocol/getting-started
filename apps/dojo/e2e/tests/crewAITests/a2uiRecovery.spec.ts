import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// CrewAI A2UI error recovery. Reuses the shared recovery fixtures
// (apps/dojo/e2e/a2ui-recovery-fixtures.ts, model-agnostic "luxury" / "broken"
// prompts): the first "luxury" render is a Row whose repeated child references
// a `card` template the model "forgot" (structural "unresolved child"); the
// toolkit loop feeds the error back and the second attempt is valid. "broken"
// always fails -> exhaustion (no faulty surface ever paints).

test("[CrewAI] A2UI recovery - invalid render recovers to a valid surface", async ({
  page,
}) => {
  await page.goto("/crewai/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 luxury hotels with ratings and prices.");

  // Faulty first attempt is suppressed (no wipe); the regenerated valid surface paints.
  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll(["The Ritz", "Holiday Inn", "Boutique Loft"]);
});

test("[CrewAI] A2UI recovery - exhaustion never paints a faulty surface, chat stays usable", async ({
  page,
}) => {
  await page.goto("/crewai/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 broken hotels with ratings and prices.");

  // Every attempt invalid -> no faulty surface ever paints.
  await expect(a2ui.surface("hotel-comparison")).toHaveCount(0);

  // Conversation remains usable after the hard failure.
  await a2ui.sendMessage("Thanks anyway.");
});
