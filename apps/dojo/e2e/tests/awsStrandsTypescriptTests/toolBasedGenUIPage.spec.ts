import { test, expect } from "../../test-isolation-helper";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

const pageURL = "/aws-strands-typescript/feature/tool_based_generative_ui";

test("[StrandsTS] Haiku generation and display verification", async ({
  page,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});

test("[StrandsTS] Haiku generation and UI consistency for two different prompts", async ({
  page,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();

  const prompt1 = 'Generate Haiku for "I will always win"';
  await genAIAgent.generateHaiku(prompt1);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  const afterFirst = await genAIAgent.snapshotHaiku(page);

  const prompt2 = 'Generate Haiku for "The moon shines bright"';
  await genAIAgent.generateHaiku(prompt2);
  await genAIAgent.checkLaterHaikuArrived(page, afterFirst);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});
