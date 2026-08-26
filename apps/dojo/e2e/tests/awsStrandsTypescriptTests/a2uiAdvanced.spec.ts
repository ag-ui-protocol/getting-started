import { test } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// A2UI advanced for AWS Strands (TypeScript). The backend is the SAME agent as the
// dynamic-schema demo, so what this spec covers is that the advanced page is
// wired to that backend and paints real surfaces through it.
//
// What it does NOT cover, deliberately: the page's one distinguishing feature is
// a custom `render_a2ui` progress renderer, which by construction only exists
// while the render call is in flight and is replaced by the surface the moment
// it completes. Asserting it was tried and is genuinely unreliable: it is caught
// when a worker runs alone and missed under parallel load, because the
// completed state can land inside a single React batch with no intermediate
// paint. A test that passes or fails on machine timing reads as coverage
// without being any, so the assertion is left out rather than quarantined. The
// langgraph and ag-ui-dotnet advanced specs assert the same surface-level
// behaviour for the same reason.
//
// Rides the same framework-agnostic aimock dynamic-schema fixtures as the
// dynamic-schema spec, which match on the generate_a2ui / render_a2ui tools plus
// hotel/team keywords rather than on the integration.

const PAGE_URL = "/aws-strands-typescript/feature/a2ui_advanced";

test("[AWS Strands TS] A2UI Advanced renders surface with hotel comparison", async ({
  page,
}) => {
  await page.goto(PAGE_URL);

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

test("[AWS Strands TS] A2UI Advanced renders team directory surface", async ({
  page,
}) => {
  await page.goto(PAGE_URL);

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
