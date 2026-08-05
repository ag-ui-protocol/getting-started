import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// CrewAI A2UI dynamic schema. The aimock fixtures
// (apps/dojo/e2e/a2ui-crewai-fixtures.ts) emulate a gpt-4o sub-agent: the main
// agent calls generate_a2ui, and the sub-agent's render_a2ui returns a valid
// hotel-comparison surface against the dojo dynamic catalog.

test("[CrewAI] A2UI Dynamic Schema renders hotel comparison surface", async ({
  page,
}) => {
  await page.goto("/crewai/feature/a2ui_dynamic_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Compare three boutique hotels - The Ritz, Holiday Inn, and Boutique Loft - with location, nightly price, and rating.",
  );

  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll([
    "The Ritz",
    "Holiday Inn",
    "Boutique Loft",
    "$450/night",
    "$180/night",
    "$320/night",
  ]);

  // HotelCard renders the numeric rating value.
  const surface = a2ui.surface("hotel-comparison");
  await expect(surface.getByText("4.8").first()).toBeVisible();
});
