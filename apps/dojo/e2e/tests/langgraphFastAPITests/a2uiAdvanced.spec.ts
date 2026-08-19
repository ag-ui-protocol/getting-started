import { test, expect } from "../../event-trace-test";
import { A2UIPage } from "../../featurePages/A2UIPage";
import { a2uiAdvancedEventTrace } from "./a2uiAdvanced.event-trace";

test("[LangGraph FastAPI] A2UI Advanced renders surface with hotel comparison", async ({
  page,
  eventTrace,
}) => {
  await page.goto("/langgraph-fastapi/feature/a2ui_advanced");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Use the generate_a2ui tool to create a comparison of 3 hotels with name, location, price per night, and star rating using the StarRating component.",
  );

  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll([
    "The Ritz",
    "Holiday Inn",
    "Boutique Loft",
  ]);
  await eventTrace.expectJourney(
    a2uiAdvancedEventTrace.a2uiAdvancedRendersSurfaceWithHotelComparison,
  );
});

test("[LangGraph FastAPI] A2UI Advanced renders team directory surface", async ({
  page,
  eventTrace,
}) => {
  await page.goto("/langgraph-fastapi/feature/a2ui_advanced");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Use the generate_a2ui tool to create a team directory with 4 people showing name, role, department, and a Contact button.",
  );

  await a2ui.assertSurfaceWithIdVisible("team-roster");
  await a2ui.assertSurfaceContainsAll([
    "Alice Chen",
    "Bob Martinez",
    "Carol Davis",
    "Dan Wilson",
  ]);
  await eventTrace.expectJourney(
    a2uiAdvancedEventTrace.a2uiAdvancedRendersTeamDirectorySurface,
  );
});
