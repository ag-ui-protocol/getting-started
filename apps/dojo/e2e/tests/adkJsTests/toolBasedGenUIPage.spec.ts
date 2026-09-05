import { expect, test } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

test("[ADK JavaScript] renders a frontend-tool haiku", async ({ page }) => {
  await gotoAndAwaitRuntimeInfo(page, "/adk-js/feature/tool_based_generative_ui");

  const haiku = new ToolBaseGenUIPage(page);
  await expect(haiku.haikuAgentIntro).toBeVisible();
  await haiku.generateHaiku('Generate Haiku for "I will always win"');
  await haiku.checkGeneratedHaiku();
  await haiku.checkHaikuDisplay(page);
});
