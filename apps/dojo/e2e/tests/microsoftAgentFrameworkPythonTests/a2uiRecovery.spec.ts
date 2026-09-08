import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// OSS-162 A2UI error-recovery showcase. The aimock fixtures
// (apps/dojo/e2e/a2ui-recovery-fixtures.ts) drive the sub-agent's render_a2ui:
// the first attempt is a Row whose repeated child references a `card` template
// the model "forgot" to include (structural "unresolved child"); the loop feeds
// the error back and the second attempt is valid.

test("[MS Agent Framework Python] A2UI recovery — invalid render recovers to a valid surface", async ({
  page,
}) => {
  await page.goto("/microsoft-agent-framework-python/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 luxury hotels with ratings and prices.");

  // The faulty first attempt is suppressed (no wipe); the regenerated valid
  // surface paints.
  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll(["The Ritz", "Holiday Inn", "Boutique Loft"]);
});

test("[MS Agent Framework Python] A2UI recovery — exhaustion never paints a faulty surface, chat stays usable", async ({
  page,
}) => {
  await page.goto("/microsoft-agent-framework-python/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 broken hotels with ratings and prices.");

  // Wait for the run to actually exhaust (the hard-failure panel appears) BEFORE asserting
  // no faulty surface painted — a bare toHaveCount(0) right after send passes trivially,
  // before the agent has produced anything, and would not verify the no-wipe invariant.
  await expect(
    page.getByText("Couldn't generate the UI").first(),
  ).toBeVisible({ timeout: 30_000 });
  // Every attempt was invalid → no faulty surface ever painted. The no-wipe invariant holds
  // even under total exhaustion (server-side middleware gate + adapter loop).
  await expect(a2ui.surface("hotel-comparison")).toHaveCount(0);

  // Conversation remains usable after the hard failure.
  await a2ui.sendMessage("Thanks anyway.");
  await a2ui.assertUserMessageVisible("Thanks anyway");
});

test("[MS Agent Framework Python] A2UI recovery — exhaustion shows the hard-failure UI", async ({
  page,
}) => {
  await page.goto("/microsoft-agent-framework-python/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 broken hotels with ratings and prices.");

  // Wait for the tasteful hard-failure message first (proves the run reached exhaustion).
  // Target the title specifically: the panel also has a "Something went wrong…" subtitle, so a
  // broad /went wrong/ regex would match two elements and trip Playwright strict mode.
  await expect(
    page.getByText("Couldn't generate the UI").first(),
  ).toBeVisible({ timeout: 30_000 });
  // ...and, now that the terminal state is reached, no faulty surface ever painted (asserting
  // this before the terminal state would pass trivially).
  await expect(a2ui.surface("hotel-comparison")).toHaveCount(0);

  // Conversation remains usable after the hard failure.
  await a2ui.sendMessage("Thanks anyway.");
  await a2ui.assertUserMessageVisible("Thanks anyway");
});
