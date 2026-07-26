import { test, expect } from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test.describe("Shared State Feature", () => {
  test("[CLI Agent Orchestrator] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/cli-agent-orchestrator/feature/shared_state");

    await sharedStateAgent.openChat();
    await sharedStateAgent.sendMessage(
      "Give me a spicy chicken recipe with low-carb ingredients",
    );
    await sharedStateAgent.loader();
    await sharedStateAgent.awaitIngredientCard("chicken breast");
    await sharedStateAgent.getInstructionItems(
      sharedStateAgent.instructionsContainer,
    );
  });

  test("[CLI Agent Orchestrator] renders agent reply after a UI-side ingredient edit", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/cli-agent-orchestrator/feature/shared_state");

    await sharedStateAgent.openChat();

    // Add new ingredient via UI
    await sharedStateAgent.addIngredient.click();

    const newIngredientCard = page.locator(".ingredient-card").last();
    await newIngredientCard.locator(".ingredient-name-input").fill("Potatoes");
    await newIngredientCard.locator(".ingredient-amount-input").fill("12");

    await page.waitForTimeout(1000);

    await sharedStateAgent.sendMessage("Give me all the ingredients");
    await sharedStateAgent.loader();

    // The server streams a static response about the chicken recipe
    await expect(
      sharedStateAgent.agentMessage.getByText(/chicken/i),
    ).toBeVisible();
  });
});
