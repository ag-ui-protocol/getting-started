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
  const surface = a2ui.visibleSurface("hotel-comparison");
  await expect(surface.getByText("4.8").first()).toBeVisible();
});

test("[CrewAI] A2UI Dynamic Schema answers an action click about that choice", async ({
  page,
}) => {
  await page.goto("/crewai/feature/a2ui_dynamic_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Compare three boutique hotels - The Ritz, Holiday Inn, and Boutique Loft - with location, nightly price, and rating.",
  );
  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");

  // The generation turn ends on the generate_a2ui call, so this closing reply
  // exists only because the flow loops the model over its own tool result.
  await a2ui.assertAgentReplyVisible(/here is the comparison you asked for/i);

  // Book the SECOND card; the reply is built from the forwarded action context.
  await a2ui.clickSurfaceAction("Book", "hotel-comparison", { nth: 1 });

  // Counted inside ONE surface node: a repaint of the same surface id would
  // otherwise double the count.
  await expect(a2ui.surfaceActions("Booked", "hotel-comparison")).toHaveCount(
    1,
  );
  await a2ui.assertAgentReplyVisible(/booked at Holiday Inn/i);
});
