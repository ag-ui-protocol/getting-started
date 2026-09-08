import { test, expect } from "../../test-isolation-helper";
import { AgenticGenUIPage } from "../../pages/crewAIPages/AgenticUIGenPage";
import { blockExternalNetwork } from "./network";

test.beforeEach(async ({ page }) => blockExternalNetwork(page));

test("[tRPC-Agent-Go] Agentic generative UI streams task state", async ({
  page,
}) => {
  const genUI = new AgenticGenUIPage(page);
  await page.goto("/trpc-agent-go/feature/agentic_generative_ui");
  await genUI.openChat();

  await genUI.sendMessage("Give me a plan to make brownies");
  await expect(genUI.agentPlannerContainer).toBeVisible();
  await genUI.plan();
});
