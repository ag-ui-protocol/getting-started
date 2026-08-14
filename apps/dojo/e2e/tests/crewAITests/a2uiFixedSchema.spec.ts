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
  await a2ui.sendMessage(
    "Search for flights from SFO to JFK for next Tuesday.",
  );

  await a2ui.assertSurfaceWithIdVisible("flight-search-results");
  await a2ui.assertSurfaceContainsAll(["UA 123", "DL 456", "$289", "$315"]);
});

test("[CrewAI] A2UI Fixed Schema renders hotel search results", async ({
  page,
}) => {
  await page.goto("/crewai/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Search for hotels in downtown Manhattan for next weekend.",
  );

  await a2ui.assertSurfaceWithIdVisible("hotel-search-results");
  await a2ui.assertSurfaceContainsAll([
    "The Manhattan Grand",
    "Downtown Boutique Hotel",
  ]);

  // HotelCard renders the numeric rating value via StarRating.
  const surface = a2ui.visibleSurface("hotel-search-results");
  await expect(surface.getByText("4.5").first()).toBeVisible();
});

test("[CrewAI] A2UI Fixed Schema answers an action click about that choice", async ({
  page,
}) => {
  await page.goto("/crewai/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Search for hotels in downtown Manhattan for next weekend.",
  );
  await a2ui.assertSurfaceWithIdVisible("hotel-search-results");

  // The search turn ends on the tool call, so this closing reply exists only
  // because the flow loops the model over its own tool result. A single-shot
  // flow renders the surface and says nothing, failing here.
  await a2ui.assertAgentReplyVisible(/here are your results/i);

  // Counted through the page object's single-surface helper: an action run can
  // repaint the same surface id, and a count across every node with that id
  // would then double and report the wrong number of clicks.
  const booked = a2ui.surfaceActions("Booked", "hotel-search-results");

  // Book the SECOND card. The reply is built from the forwarded action context,
  // so naming the first hotel (or a hotel at all on a flight surface) fails.
  await a2ui.clickSurfaceAction("Book", "hotel-search-results", { nth: 1 });
  await expect(booked).toHaveCount(1);
  await a2ui.assertAgentReplyVisible(
    /booked at Downtown Boutique Hotel for \$280/i,
  );

  // A second click is answered about the second choice; the earlier report is
  // still in the history, so replaying the first reply here is a failure.
  await a2ui.clickSurfaceAction("Book", "hotel-search-results", { nth: 0 });
  await expect(booked).toHaveCount(2);
  await a2ui.assertAgentReplyVisible(
    /booked at The Manhattan Grand for \$350/i,
  );
});

test("[CrewAI] A2UI Fixed Schema answers a flight selection about that flight", async ({
  page,
}) => {
  await page.goto("/crewai/feature/a2ui_fixed_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Search for flights from SFO to JFK for next Tuesday.",
  );
  await a2ui.assertSurfaceWithIdVisible("flight-search-results");
  await a2ui.assertAgentReplyVisible(/here are your results/i);

  await a2ui.clickSurfaceAction("Select", "flight-search-results", { nth: 1 });
  await expect(
    a2ui.surfaceActions("Selected", "flight-search-results"),
  ).toHaveCount(1);
  await a2ui.assertAgentReplyVisible(
    /booked on DL 456 from SFO to JFK for \$315/i,
  );
});
