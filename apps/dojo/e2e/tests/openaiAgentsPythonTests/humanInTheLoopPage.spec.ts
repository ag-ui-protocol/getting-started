import { expect, test } from "../../test-isolation-helper";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";

test("[OpenAI Agents Python] Human in the Loop renders and submits selected steps", async ({
  page,
}) => {
  test.slow();
  await page.goto("/openai-agents-python/feature/human_in_the_loop");

  const humanInLoop = new HumanInTheLoopPage(page);
  await humanInLoop.openChat();
  await humanInLoop.sendMessage(
    "Give me a plan to make brownies, there should be only one step with eggs and one step with oven",
  );

  await expect(humanInLoop.plan).toBeVisible();
  await humanInLoop.uncheckItem("eggs");
  expect(await humanInLoop.isStepItemUnchecked("eggs")).toBe(true);
  await humanInLoop.performSteps();
});
