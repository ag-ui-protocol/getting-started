import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// OSS-158 — Google ADK A2UI dynamic schema. The aimock fixtures
// (apps/dojo/e2e/a2ui-adk-fixtures.ts) emulate a real Gemini sub-agent under the
// free-form tool schema: render_a2ui returns components/data as JSON strings,
// which the ADK adapter parses back before validation/emission.

test("[Google ADK] A2UI Dynamic Schema renders hotel comparison surface", async ({
  page,
}) => {
  await page.goto("/adk-middleware/feature/a2ui_dynamic_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Use the generate_a2ui tool to create a comparison of 3 hotels with name, location, price per night, and a star rating.",
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
