import { test, expect } from "../../event-trace-test";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";
import { toolBasedGenUIPageEventTrace } from "./toolBasedGenUIPage.event-trace";

const pageURL = "/langgraph-fastapi/feature/tool_based_generative_ui";

test("[LangGraph FastAPI] Haiku generation and display verification", async ({
  page,
  eventTrace,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
  await eventTrace.expectJourney(
    toolBasedGenUIPageEventTrace.haikuGenerationAndDisplayVerification,
  );
});

test("[LangGraph FastAPI] Haiku generation and UI consistency for two different prompts", async ({
  page,
  eventTrace,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();

  const prompt1 = 'Generate Haiku for "I will always win"';
  await genAIAgent.generateHaiku(prompt1);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  const prompt2 = 'Generate Haiku for "The moon shines bright"';
  await genAIAgent.generateHaiku(prompt2);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
  await eventTrace.expectJourney(
    toolBasedGenUIPageEventTrace.haikuGenerationAndUIConsistencyForTwoDifferentPrompts,
  );
});
