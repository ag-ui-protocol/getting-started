import { test } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// A2UI fixed-schema (direct-tool) — Mastra REMOTE (server-wired tool). The
// server tool returns a pre-authored a2ui_operations envelope which MastraClient
// forwards to the bridge; the middleware paints it.
test("[Mastra Remote] A2UI fixed schema — backend tool paints a pre-authored surface", async ({
  page,
}) => {
  await page.goto("/mastra/feature/a2ui_fixed_schema");
  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Find hotels in downtown Manhattan for next weekend.");
  await a2ui.assertSurfaceWithIdVisible("hotel-search-results");
  await a2ui.assertSurfaceContainsAll([
    "The Manhattan Grand",
    "Downtown Boutique Hotel",
  ]);
});
