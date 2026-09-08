import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// A2UI error-recovery showcase — Mastra REMOTE (MastraClient) port.
//
// Same behavior bar as the local / LangGraph / Strands recovery specs, driven by
// the SAME framework-agnostic aimock fixtures (apps/dojo/e2e/a2ui-recovery-fixtures.ts).
//
// DevEx under test: the REMOTE Mastra dev server wires `generate_a2ui` via the
// shared `getA2UITools` factory server-side (matches LangGraph's remote graph).
// The render subagent streams over the server fullStream, which MastraClient
// forwards to the AG-UI bridge — so recovery + subagent + progressive streaming
// all work over the remote wire.

test("[Mastra Remote] A2UI recovery — invalid render recovers to a valid surface", async ({
  page,
}) => {
  await page.goto("/mastra/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 luxury hotels with ratings and prices.");

  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll([
    "The Ritz",
    "Holiday Inn",
    "Boutique Loft",
  ]);
});

test("[Mastra Remote] A2UI recovery — exhaustion: hard-failure UI, no faulty paint, chat stays usable", async ({
  page,
}) => {
  await page.goto("/mastra/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 broken hotels with ratings and prices.");

  await expect(page.getByText("Couldn't generate the UI").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(a2ui.surface("hotel-comparison")).toHaveCount(0);

  await a2ui.sendMessage("Thanks anyway.");
  await a2ui.assertUserMessageVisible("Thanks anyway.");
});
