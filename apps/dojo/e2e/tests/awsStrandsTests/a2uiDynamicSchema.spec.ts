import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// A2UI dynamic-schema showcase — AWS Strands (Python) port.
//
// Rides the SAME framework-agnostic aimock dynamic-schema fixtures as the
// LangGraph spec (apps/dojo/e2e/aimock-setup.ts) — they match on the
// generate_a2ui / render_a2ui tools + hotel/product/team keywords, not on the
// integration. The Strands demo agent is a plain Strands agent
// with NO a2ui wiring; the runtime sends `injectA2UITool` and the
// ag_ui_strands adapter auto-injects `generate_a2ui`.

test("[AWS Strands] A2UI Dynamic Schema renders hotel comparison surface", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/a2ui_dynamic_schema");

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
    "$450/night",
    "$180/night",
    "$320/night",
  ]);

  const surface = a2ui.surface("hotel-comparison");
  await expect(surface.getByText("4.8").first()).toBeVisible();
});

test("[AWS Strands] A2UI Dynamic Schema renders product comparison surface", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/a2ui_dynamic_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Use the generate_a2ui tool to create a product comparison of 3 headphones with name, price, rating, a short description, and a Select button on each card.",
  );

  await a2ui.assertSurfaceWithIdVisible("product-comparison");
  await a2ui.assertSurfaceContainsAll([
    "Sony WH-1000XM5",
    "AirPods Max",
    "Bose QC Ultra",
    "$349",
    "$549",
    "$429",
  ]);
});

test("[AWS Strands] A2UI Dynamic Schema renders team roster surface", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/a2ui_dynamic_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Use the generate_a2ui tool to create a team roster with 4 people showing name, role, avatar, and email.",
  );

  await a2ui.assertSurfaceWithIdVisible("team-roster");
  await a2ui.assertSurfaceContainsAll([
    "Alice Chen",
    "Bob Martinez",
    "Carol Davis",
    "Dan Wilson",
    "Engineering Lead",
    "Product Designer",
  ]);
});
