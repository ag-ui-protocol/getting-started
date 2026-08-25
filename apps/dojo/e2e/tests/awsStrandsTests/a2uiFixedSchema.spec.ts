import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// OSS-158 — AWS Strands (Python) A2UI fixed schema. The agent exposes two plain
// backend tools (search_flights / search_hotels); the LLM supplies the row data
// and the tool returns a fixed-layout a2ui_operations envelope, which the
// runtime's A2UIMiddleware detects and paints. Rides the SAME framework-agnostic
// aimock fixed-schema fixtures as the LangGraph spec (apps/dojo/e2e/aimock-setup.ts)
// — they match on the search_flights / search_hotels tools + flights/hotels
// keywords, not on the integration.

test("[AWS Strands] A2UI Fixed Schema renders flight search surface", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Find flights from SFO to JFK for next Tuesday.");

  await a2ui.assertUserMessageVisible("Find flights from SFO to JFK");
  await a2ui.assertSurfaceWithIdVisible("flight-search-results");
  // Flight data is bound via the fixed schema template — assert key data fields.
  await a2ui.assertSurfaceContainsAll(["UA 123", "DL 456", "$289", "$315"]);
});

test("[AWS Strands] A2UI Fixed Schema renders hotel search with StarRating", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Find hotels in downtown Manhattan for next weekend.");

  await a2ui.assertUserMessageVisible("Find hotels in downtown Manhattan");
  await a2ui.assertSurfaceWithIdVisible("hotel-search-results");
  await a2ui.assertSurfaceContainsAll([
    "The Manhattan Grand",
    "Downtown Boutique Hotel",
  ]);

  // Verify StarRating custom component rendered (numeric rating value).
  const surface = a2ui.surface("hotel-search-results");
  await expect(surface.getByText("4.5").first()).toBeVisible();
});

test("[AWS Strands] A2UI Fixed Schema renders multiple surfaces in sequence", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();

  // First surface: flights
  await a2ui.sendMessage("Find flights from SFO to JFK.");
  await a2ui.assertSurfaceWithIdVisible("flight-search-results");

  // Second surface: hotels
  await a2ui.sendMessage("Find hotels in downtown Manhattan.");
  await a2ui.assertSurfaceWithIdVisible("hotel-search-results");

  // Both surfaces should be present
  const count = await a2ui.getSurfaceCount();
  expect(count).toBeGreaterThanOrEqual(2);
});
