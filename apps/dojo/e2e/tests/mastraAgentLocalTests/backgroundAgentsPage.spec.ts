import { test } from "../../test-isolation-helper";
import { BackgroundAgentsPage } from "../../featurePages/BackgroundAgentsPage";

const pageURL = "/mastra-agent-local/feature/background_agents";

test("[Mastra Agent Local] background task surfaces as a distinct activity card", async ({
  page,
}) => {
  await page.goto(pageURL);

  const bg = new BackgroundAgentsPage(page);

  await bg.dispatchResearch("Research the Solana ecosystem for me.");
  await bg.expectActivityCard("Solana");
  await bg.expectNoOrphanToolRender();
});
