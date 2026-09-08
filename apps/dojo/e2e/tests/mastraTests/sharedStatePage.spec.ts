import { test, expect } from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test.describe("Shared State Feature", () => {
  test("[Mastra] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/mastra/feature/shared_state");

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

  // OSS-414: the bridge maps the remote agent's mid-run `updateWorkingMemory`
  // tool call (delivered over processDataStream) to a STATE_DELTA, so shared
  // state renders live. Asserting on the completed SSE body keeps this
  // flake-free (leading snapshot -> deltas -> RUN_FINISHED, no RUN_ERROR).
  test("[Mastra] streams a STATE_DELTA mid-run as the recipe fills in", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/mastra/feature/shared_state");
    await sharedStateAgent.openChat();

    const marker = "one of the ingredients should be Pasta";
    const ssePromise = sharedStateAgent.captureRuntimeSSE("mastra", marker);

    await sharedStateAgent.sendMessage(
      "Please give me a pasta recipe of your choosing, but one of the ingredients should be Pasta",
    );
    await sharedStateAgent.loader();
    await expect(sharedStateAgent.ingredientCards.first()).toBeVisible();

    sharedStateAgent.assertStreamedStateDelta(await ssePromise);
  });

  // OSS-414 (client -> agent): editing shared state in the UI and hitting
  // "Improve with AI" must reach the REMOTE agent. The bridge syncs input.state
  // into the remote server's working memory via @mastra/client-js. Checking a
  // preference applies it; unchecking removes it and the agent does not re-add.
  test("[Mastra] agent honors a dietary preference toggled in the UI", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/mastra/feature/shared_state");
    await sharedStateAgent.openChat();
    await sharedStateAgent.sendMessage("Create a simple Italian pasta recipe.");
    await sharedStateAgent.loader();

    await sharedStateAgent.setDietary("Spicy", true);
    await sharedStateAgent.improve();
    expect(
      await sharedStateAgent.isDietaryChecked("Spicy"),
      "checking Spicy + Improve must apply the preference",
    ).toBe(true);

    await sharedStateAgent.setDietary("Spicy", false);
    await sharedStateAgent.improve();
    expect(
      await sharedStateAgent.isDietaryChecked("Spicy"),
      "unchecking Spicy + Improve must remove the preference (agent must not re-add it)",
    ).toBe(false);
  });

  test("[Mastra] should share state between UI and chat", async ({ page }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/mastra/feature/shared_state");

    await sharedStateAgent.openChat();

    // Add new ingredient via UI
    await sharedStateAgent.addIngredient.click();

    const newIngredientCard = page.locator(".ingredient-card").last();
    await newIngredientCard.locator(".ingredient-name-input").fill("Potatoes");
    await newIngredientCard.locator(".ingredient-amount-input").fill("12");

    await page.waitForTimeout(1000);

    await sharedStateAgent.sendMessage("Give me all the ingredients");
    await sharedStateAgent.loader();

    await expect(
      sharedStateAgent.agentMessage.getByText(/Potatoes/),
    ).toBeVisible();
    await expect(sharedStateAgent.agentMessage.getByText(/12/)).toBeVisible();
    await expect(
      sharedStateAgent.agentMessage.getByText(/Carrots/),
    ).toBeVisible();
    await expect(
      sharedStateAgent.agentMessage.getByText(/All-Purpose Flour/),
    ).toBeVisible();
  });
});
