import { expect, test } from "../../test-isolation-helper";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

test("[OpenAI Agents Python] Tool Based Generative UI renders a haiku", async ({
  page,
}) => {
  await page.goto("/openai-agents-python/feature/tool_based_generative_ui");

  const haiku = new ToolBaseGenUIPage(page);
  await expect(haiku.haikuAgentIntro).toBeVisible();
  await haiku.generateHaiku('Generate Haiku for "I will always win"');
  await haiku.checkGeneratedHaiku();
  await haiku.checkHaikuDisplay(page);
});
