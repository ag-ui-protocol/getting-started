import { test, expect } from "../../test-isolation-helper";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";

const pageURL = "/adk-middleware-java/feature/human_in_the_loop";

test.describe("Human in the Loop Feature", () => {
  test("[ADK Middleware Java] creates a plan and performs selected steps", async ({
    page,
  }) => {
    const humanInLoop = new HumanInTheLoopPage(page);

    await page.goto(pageURL);
    await humanInLoop.openChat();
    await humanInLoop.sendMessage(
      "Give me a plan to make brownies, with one step mentioning eggs and one step mentioning the oven",
    );
    await expect(humanInLoop.plan).toBeVisible();

    await humanInLoop.uncheckItem("eggs");
    await expect(await humanInLoop.isStepItemUnchecked("eggs")).toBe(true);
    await humanInLoop.performStepsAndAwait();
  });

  test("[ADK Middleware Java] preserves the user's step selection", async ({
    page,
  }) => {
    const humanInLoop = new HumanInTheLoopPage(page);

    await page.goto(pageURL);
    await humanInLoop.openChat();
    await humanInLoop.sendMessage(
      "Plan a mission to Mars with the first step being Start The Planning",
    );
    await expect(humanInLoop.plan).toBeVisible();

    const uncheckedItem = await humanInLoop.uncheckItem(0);
    await expect(await humanInLoop.isStepItemUnchecked(0)).toBe(true);
    await humanInLoop.performStepsAndAwait();

    await humanInLoop.sendMessage(
      `Does the planner include ${uncheckedItem}? Reply with only Yes or No.`,
    );
  });
});
