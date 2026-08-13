import { test, expect } from "../../test-isolation-helper";
import { AgenticGenUIPage } from "../../pages/langGraphPages/AgenticUIGenPage";

const pageURL = "/adk-middleware-java/feature/agentic_generative_ui";

test.describe("Agentic Generative UI Feature", () => {
  test("[ADK Middleware Java] renders a task planner", async ({ page }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto(pageURL);
    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Give me a plan to make brownies");

    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
  });

  test("[ADK Middleware Java] renders a planner for a second task", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto(pageURL);
    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Go to Mars");

    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
  });
});
