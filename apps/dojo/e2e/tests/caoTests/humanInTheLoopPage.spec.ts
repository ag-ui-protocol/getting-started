import { test, expect } from "../../test-isolation-helper";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";

test.describe("Human in the Loop Feature", () => {
  test("[CLI Agent Orchestrator] should interact with the chat and perform steps", async ({
    page,
  }) => {
    const humanInLoop = new HumanInTheLoopPage(page);

    await page.goto("/cli-agent-orchestrator/feature/human_in_the_loop");

    await humanInLoop.openChat();

    await humanInLoop.sendMessage("Hi");

    await humanInLoop.sendMessage(
      "Give me a plan to set up and validate the project",
    );
    await expect(humanInLoop.plan).toBeVisible();

    const itemText = "Run linting checks";
    await humanInLoop.uncheckItem(itemText);
    await humanInLoop.performStepsAndAwait();

    await humanInLoop.sendMessage(
      `Does the plan include ${itemText}? Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`,
    );

    // The step was unchecked before performing, so the approved plan excludes it
    // and the truthful answer is "No". Asserting the reply (not just that the
    // question was sent) is what makes this an end-to-end HITL round-trip.
    await humanInLoop.assertAgentReplyVisible(/\bNo\b/i);
    await expect(humanInLoop.agentMessage.last()).not.toContainText(/\bYes\b/i);
  });
});
