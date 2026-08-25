import { test, expect } from "../../test-isolation-helper";
import { AgenticGenUIPage } from "../../pages/crewAIPages/AgenticUIGenPage";

test("[AG-UI .NET SDK] Agentic Gen UI shows task planner on prompt", async ({
  page,
}) => {
  const genUIAgent = new AgenticGenUIPage(page);

  await page.goto("/ag-ui-dotnet/feature/agentic_generative_ui");

  await genUIAgent.openChat();
  await genUIAgent.sendMessage("Hi");
  await genUIAgent.assertAgentReplyVisible(/Hello/);

  await genUIAgent.sendMessage("Give me a plan to make brownies");
  await expect(genUIAgent.agentPlannerContainer).toBeVisible();
  await genUIAgent.plan();
});

test("[AG-UI .NET SDK] Agentic Gen UI plans a Mars mission", async ({ page }) => {
  const genUIAgent = new AgenticGenUIPage(page);

  await page.goto("/ag-ui-dotnet/feature/agentic_generative_ui");

  await genUIAgent.openChat();
  await genUIAgent.sendMessage("Hi");
  await genUIAgent.assertAgentReplyVisible(/Hello/);

  await genUIAgent.sendMessage("Go to Mars");
  await expect(genUIAgent.agentPlannerContainer).toBeVisible();
  await genUIAgent.plan();
});