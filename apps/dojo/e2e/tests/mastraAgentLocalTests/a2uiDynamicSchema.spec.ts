import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// A2UI dynamic-schema (generate_a2ui subagent) — Mastra local (auto-inject).
test("[MastraAgentLocal] A2UI dynamic schema — generates a surface from the subagent", async ({
  page,
}, testInfo) => {
  await page.goto("/mastra-agent-local/feature/a2ui_dynamic_schema");
  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Compare 3 luxury hotels in different cities with ratings and prices.",
  );
  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll(["The Ritz", "Holiday Inn", "Boutique Loft"]);
  await page.screenshot({
    path: testInfo.outputPath("a2ui-dynamic-local.png"),
    fullPage: true,
  });
});
