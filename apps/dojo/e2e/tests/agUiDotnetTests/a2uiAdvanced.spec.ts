import { test } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// The exact names asserted below (The Ritz, …) come from the deterministic
// aimock fixtures (apps/dojo/e2e/aimock-setup.ts); these specs are not meant
// to run against a live model.

test("[AG-UI .NET SDK] A2UI Advanced renders surface with hotel comparison", async ({
  page,
}) => {
  await page.goto("/ag-ui-dotnet/feature/a2ui_advanced");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Create a comparison of 3 hotels with name, location, price per night, and star rating using the StarRating component.",
  );

  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll([
    "The Ritz",
    "Holiday Inn",
    "Boutique Loft",
  ]);
});

test("[AG-UI .NET SDK] A2UI Advanced renders team directory surface", async ({
  page,
}) => {
  await page.goto("/ag-ui-dotnet/feature/a2ui_advanced");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Create a team directory with 4 people showing name, role, department, and a Contact button.",
  );

  await a2ui.assertSurfaceWithIdVisible("team-roster");
  await a2ui.assertSurfaceContainsAll([
    "Alice Chen",
    "Bob Martinez",
    "Carol Davis",
    "Dan Wilson",
  ]);
});
