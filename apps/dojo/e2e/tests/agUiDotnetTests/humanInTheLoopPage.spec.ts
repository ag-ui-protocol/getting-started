import { test, expect } from "../../test-isolation-helper";
import { HumanInLoopPage } from "../../pages/serverStarterAllFeaturesPages/HumanInLoopPage";

test.describe("Human in the Loop Feature", () => {
  test("[AG-UI .NET SDK] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    const humanInLoop = new HumanInLoopPage(page);

    await page.goto("/ag-ui-dotnet/feature/human_in_the_loop");

    await humanInLoop.openChat();

    await humanInLoop.sendMessage("one step with eggs");
    await expect(humanInLoop.plan).toBeVisible();
    await humanInLoop.performStepsAndAwait();
  });
});
