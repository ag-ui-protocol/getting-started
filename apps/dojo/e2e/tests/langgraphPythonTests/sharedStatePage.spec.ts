import { test, expect } from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test.describe("Shared State Feature", () => {
  test("[LangGraph] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    // Update URL to new domain
    await page.goto("/langgraph/feature/shared_state");

    await sharedStateAgent.openChat();
    await sharedStateAgent.sendMessage(
      'Please give me a pasta recipe of your choosing, but one of the ingredients should be "Pasta"',
    );
    await sharedStateAgent.loader();
    await sharedStateAgent.awaitIngredientCard("Pasta");
    await sharedStateAgent.getInstructionItems(
      sharedStateAgent.instructionsContainer,
    );
  });

  test("[LangGraph] should share state between UI and chat", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/langgraph/feature/shared_state");

    await sharedStateAgent.openChat();
    // Wait for the runtime-backed agent to replace the provisional agent before
    // editing shared state, so the graph observes the same recipe as the UI.
    await sharedStateAgent.awaitAgentReady();

    // Add new ingredient via UI
    await sharedStateAgent.addIngredient.click();

    // Fill in the new ingredient details
    const newIngredientCard = page.locator(".ingredient-card").last();
    await newIngredientCard.locator(".ingredient-name-input").fill("Potatoes");
    await newIngredientCard.locator(".ingredient-amount-input").fill("12");

    // Ask chat for all ingredients
    await sharedStateAgent.sendMessage("Give me all the ingredients");
    await sharedStateAgent.loader();

    // Verify chat response includes both existing and new ingredients
    await expect(
      sharedStateAgent.agentMessage.getByText(/Potatoes/i),
    ).toBeVisible();
    await expect(sharedStateAgent.agentMessage.getByText(/12/)).toBeVisible();
    await expect(
      sharedStateAgent.agentMessage.getByText(/Carrots/i),
    ).toBeVisible();
    await expect(
      sharedStateAgent.agentMessage.getByText(
        /All-Purpose Flour|all.purpose flour/i,
      ),
    ).toBeVisible();
  });
});
