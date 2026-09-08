import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

test("[LangGraph Python] A2UI Advanced renders surface with hotel comparison", async ({
  page,
}) => {
  await page.goto("/langgraph/feature/a2ui_advanced");

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
});

test("[LangGraph Python] A2UI Advanced renders team directory surface", async ({
  page,
}) => {
  await page.goto("/langgraph/feature/a2ui_advanced");

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
});
