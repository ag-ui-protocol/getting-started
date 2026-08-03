import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// CrewAI A2UI fixed schema. The main agent calls the backend
// search_flights / search_hotels tools directly (no sub-agent); each returns
// the pre-authored a2ui_operations envelope the A2UIMiddleware paints. aimock
// fixtures live in apps/dojo/e2e/a2ui-crewai-fixtures.ts.

test("[CrewAI] A2UI Fixed Schema renders flight search results", async ({
  page,
}) => {
  await page.goto("/crewai/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Search for flights from SFO to JFK for next Tuesday.");

  await a2ui.assertSurfaceWithIdVisible("flight-search-results");
  await a2ui.assertSurfaceContainsAll(["UA 123", "DL 456", "$289", "$315"]);
});

test("[CrewAI] A2UI Fixed Schema renders hotel search results", async ({
  page,
}) => {
  await page.goto("/crewai/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Search for hotels in downtown Manhattan for next weekend.");

  await a2ui.assertSurfaceWithIdVisible("hotel-search-results");
  await a2ui.assertSurfaceContainsAll(["The Manhattan Grand", "Downtown Boutique Hotel"]);

  // HotelCard renders the numeric rating value via StarRating.
  const surface = a2ui.surface("hotel-search-results");
  await expect(surface.getByText("4.5").first()).toBeVisible();
});
