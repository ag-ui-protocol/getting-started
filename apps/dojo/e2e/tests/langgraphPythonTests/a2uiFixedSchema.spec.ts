import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

test("[LangGraph Python] A2UI Fixed Schema renders flight search surface", async ({
  page,
}) => {
  await page.goto("/langgraph/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Find flights from SFO to JFK for next Tuesday.");

  await a2ui.assertUserMessageVisible("Find flights from SFO to JFK");
  await a2ui.assertSurfaceWithIdVisible("flight-search-results");
  // Flight data is bound via the schema template — assert key data fields
  await a2ui.assertSurfaceContainsAll(["UA 123", "DL 456", "$289", "$315"]);
});

test("[LangGraph Python] A2UI Fixed Schema renders hotel search with StarRating", async ({
  page,
}) => {
  await page.goto("/langgraph/feature/a2ui_fixed_schema");

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

test("[LangGraph Python] A2UI Fixed Schema renders multiple surfaces in sequence", async ({
  page,
}) => {
  await page.goto("/langgraph/feature/a2ui_fixed_schema");

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
