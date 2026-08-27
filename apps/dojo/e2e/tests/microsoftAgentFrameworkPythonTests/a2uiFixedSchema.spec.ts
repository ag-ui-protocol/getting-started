import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// The exact data values asserted below (UA 123, $289, …) come from the
// deterministic aimock fixtures (apps/dojo/e2e/aimock-setup.ts); these specs
// are not meant to run against a live model. Fixed-schema wires its OWN backend
// search tools whose result carries the surface envelope — the agent never
// emits a generate_a2ui call, so no tool is injected here.

test("[MS Agent Framework Python] A2UI Fixed Schema renders flight search surface", async ({
  page,
}) => {
  await page.goto("/microsoft-agent-framework-python/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Find flights from SFO to JFK for next Tuesday.");

  await a2ui.assertUserMessageVisible("Find flights from SFO to JFK");
  await a2ui.assertSurfaceWithIdVisible("flight-search-results");
  // Flight data is bound via the schema template — assert key data fields
  await a2ui.assertSurfaceContainsAll(["UA 123", "DL 456", "$289", "$315"]);
});

test("[MS Agent Framework Python] A2UI Fixed Schema renders hotel search with StarRating", async ({
  page,
}) => {
  await page.goto("/microsoft-agent-framework-python/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Find hotels in downtown Manhattan for next weekend.");

  await a2ui.assertUserMessageVisible("Find hotels in downtown Manhattan");
  await a2ui.assertSurfaceWithIdVisible("hotel-search-results");
  await a2ui.assertSurfaceContainsAll([
    "The Manhattan Grand",
    "Downtown Boutique Hotel",
  ]);

  // Verify StarRating custom component rendered (numeric rating value)
  const surface = a2ui.surface("hotel-search-results");
  await expect(surface.getByText("4.5").first()).toBeVisible();
});

test("[MS Agent Framework Python] A2UI Fixed Schema renders multiple surfaces in sequence", async ({
  page,
}) => {
  await page.goto("/microsoft-agent-framework-python/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();

  // First surface: flights
  await a2ui.sendMessage("Find flights from SFO to JFK.");
  await a2ui.assertSurfaceWithIdVisible("flight-search-results");

  // Second surface: hotels
  await a2ui.sendMessage("Find hotels in downtown Manhattan.");
  await a2ui.assertSurfaceWithIdVisible("hotel-search-results");

  // Both surfaces should be present. Re-assert the flight surface with the
  // retrying locator before the point-in-time count: sendMessage's
  // running-state wait can return early on multi-turn pages, and the two
  // visibility assertions absorb any remaining paint latency.
  await a2ui.assertSurfaceWithIdVisible("flight-search-results");
  const count = await a2ui.getSurfaceCount();
  expect(count).toBeGreaterThanOrEqual(2);
});
