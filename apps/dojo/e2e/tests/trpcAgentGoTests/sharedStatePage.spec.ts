import { expect, test } from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";
import { blockExternalNetwork } from "./network";

test.beforeEach(async ({ page }) => blockExternalNetwork(page));

test("[tRPC-Agent-Go] Shared state synchronizes the recipe in both directions", async ({
  page,
}) => {
  const sharedState = new SharedStatePage(page);
  await page.goto("/trpc-agent-go/feature/shared_state");
  await sharedState.openChat();

  await sharedState.sendMessage(
    'Please give me a pasta recipe, with "Pasta" as an ingredient',
  );
  await sharedState.awaitIngredientCard("Pasta");
  await sharedState.getInstructionItems(sharedState.instructionsContainer);

  await sharedState.addIngredient.click();
  const ingredientCard = page.locator(".ingredient-card").last();
  await ingredientCard.locator(".ingredient-name-input").fill("Potatoes");
  await ingredientCard.locator(".ingredient-amount-input").fill("12");

  await sharedState.sendMessage("Give me all the ingredients");

  await expect(sharedState.agentMessage.getByText(/Potatoes/)).toBeVisible();
  await expect(sharedState.agentMessage.getByText(/12/)).toBeVisible();
});
