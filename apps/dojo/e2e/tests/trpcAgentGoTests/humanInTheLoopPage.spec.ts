import { test, expect } from "../../test-isolation-helper";
import { HumanInLoopPage } from "../../pages/agnoPages/HumanInLoopPage";
import { blockExternalNetwork } from "./network";

test.beforeEach(async ({ page }) => blockExternalNetwork(page));

test("[tRPC-Agent-Go] Human in the loop reviews task steps", async ({
  page,
}) => {
  const humanInLoop = new HumanInLoopPage(page);
  await page.goto("/trpc-agent-go/feature/human_in_the_loop");
  await humanInLoop.openChat();

  await humanInLoop.sendMessage(
    "Give me a plan to make brownies, there should be only one step with eggs and one step with oven",
  );
  await expect(humanInLoop.plan).toBeVisible();
  await humanInLoop.uncheckItem("eggs");
  await humanInLoop.performStepsAndAwait();
});
