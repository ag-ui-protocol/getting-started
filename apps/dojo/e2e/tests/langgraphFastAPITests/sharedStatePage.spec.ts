import { test, expect } from "../../event-trace-test";
import { SharedStatePage } from "../../featurePages/SharedStatePage";
import { sharedStatePageEventTrace } from "./sharedStatePage.event-trace";

test.describe("Shared State Feature", () => {
  test("[LangGraph FastAPI] should interact with the chat to get a recipe on prompt", async ({
    page,
    eventTrace,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    // Update URL to new domain
    await page.goto("/langgraph-fastapi/feature/shared_state");

    await sharedStateAgent.openChat();
    await sharedStateAgent.sendMessage(
      'Please give me a pasta recipe of your choosing, but one of the ingredients should be "Pasta"',
    );
    await sharedStateAgent.loader();
    await sharedStateAgent.awaitIngredientCard("Pasta");
    await sharedStateAgent.getInstructionItems(
      sharedStateAgent.instructionsContainer,
    );
    await eventTrace.expectJourney(
      sharedStatePageEventTrace.interactWithTheChatToGetARecipeOnPrompt,
    );
  });

  test("[LangGraph FastAPI] should share state between UI and chat", async ({
    page,
    eventTrace,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/langgraph-fastapi/feature/shared_state");

    await sharedStateAgent.openChat();

    // Add new ingredient via UI
    await sharedStateAgent.addIngredient.click();

    // Fill in the new ingredient details
    const newIngredientCard = page.locator(".ingredient-card").last();
    await newIngredientCard.locator(".ingredient-name-input").fill("Potatoes");
    await newIngredientCard.locator(".ingredient-amount-input").fill("12");

    // Wait for UI to update
    await page.waitForTimeout(1000);

    // Ask chat for all ingredients
    await sharedStateAgent.sendMessage(
      "Give me all the ingredients, also list them in your message",
    );
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
    await eventTrace.expectJourney(
      sharedStatePageEventTrace.shareStateBetweenUIAndChat,
    );
  });
});
