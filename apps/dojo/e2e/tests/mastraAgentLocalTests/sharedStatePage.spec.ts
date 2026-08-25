import { test, expect } from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test.describe("Shared State Feature", () => {
  test("[MastraAgentLocal] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    // Update URL to new domain
    await page.goto("/mastra-agent-local/feature/shared_state");

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

  // OSS-414: the bridge maps Mastra's mid-run `updateWorkingMemory` tool call
  // to a STATE_DELTA, so shared state renders live as the model builds it —
  // not only via the run-end STATE_SNAPSHOT. Asserting on the completed SSE
  // body (delta appears before RUN_FINISHED) keeps this flake-free.
  test("[MastraAgentLocal] streams a STATE_DELTA mid-run as the recipe fills in", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/mastra-agent-local/feature/shared_state");
    await sharedStateAgent.openChat();

    // Quote-free marker (the prompt's quotes get JSON-escaped in the body).
    const marker = "one of the ingredients should be Pasta";
    const ssePromise = sharedStateAgent.captureRuntimeSSE(
      "mastra-agent-local",
      marker,
    );

    await sharedStateAgent.sendMessage(
      "Please give me a pasta recipe of your choosing, but one of the ingredients should be Pasta",
    );
    await sharedStateAgent.loader();
    // The recipe rendered live from streamed state (any ingredient card is
    // enough — the exact ingredient names are model-nondeterministic).
    await expect(sharedStateAgent.ingredientCards.first()).toBeVisible();

    sharedStateAgent.assertStreamedStateDelta(await ssePromise);
  });

  // OSS-414 (client -> agent): editing shared state in the UI and hitting
  // "Improve with AI" must reach the agent, which then honors it. The bridge
  // syncs input.state into Mastra's resource-scoped working memory (the store
  // the model actually reads). Checking a preference applies it; unchecking it
  // removes it and the agent does NOT re-add it.
  test("[MastraAgentLocal] agent honors a dietary preference toggled in the UI", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/mastra-agent-local/feature/shared_state");
    await sharedStateAgent.openChat();
    await sharedStateAgent.sendMessage("Create a simple Italian pasta recipe.");
    await sharedStateAgent.loader();

    // Check "Spicy" and improve -> the agent applies and keeps it.
    await sharedStateAgent.setDietary("Spicy", true);
    await sharedStateAgent.improve();
    expect(
      await sharedStateAgent.isDietaryChecked("Spicy"),
      "checking Spicy + Improve must apply the preference",
    ).toBe(true);

    // Uncheck "Spicy" and improve -> the agent must NOT re-add it.
    await sharedStateAgent.setDietary("Spicy", false);
    await sharedStateAgent.improve();
    expect(
      await sharedStateAgent.isDietaryChecked("Spicy"),
      "unchecking Spicy + Improve must remove the preference (agent must not re-add it)",
    ).toBe(false);
  });

  test("[MastraAgentLocal] should share state between UI and chat", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/mastra-agent-local/feature/shared_state");

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
    await sharedStateAgent.sendMessage("Give me all the ingredients");
    await sharedStateAgent.loader();

    // Verify chat response includes both existing and new ingredients
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
