import { test, expect } from "../../test-isolation-helper";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";
import { blockExternalNetwork } from "./network";

test.beforeEach(async ({ page }) => blockExternalNetwork(page));

test("[tRPC-Agent-Go] Haiku tool renders generative UI", async ({ page }) => {
  await page.goto("/trpc-agent-go/feature/tool_based_generative_ui");
  const genUI = new ToolBaseGenUIPage(page);

  await expect(genUI.haikuAgentIntro).toBeVisible();
  await genUI.generateHaiku('Generate Haiku for "I will always win"');
  await genUI.checkGeneratedHaiku();
  await genUI.checkHaikuDisplay(page);
});
