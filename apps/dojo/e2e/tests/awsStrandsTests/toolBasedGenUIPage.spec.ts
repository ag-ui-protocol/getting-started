import { test, expect } from "../../test-isolation-helper";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

// Port of the TypeScript spec. `generate_haiku` is a frontend tool, so the
// adapter proxies it, halts the loop once the proxy returns, and the browser
// renders the card from the streamed TOOL_CALL_* events.
const pageURL = "/aws-strands/feature/tool_based_generative_ui";

test("[Strands] Haiku generation and display verification", async ({
  page,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});

test("[Strands] Haiku generation and UI consistency for two different prompts", async ({
  page,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();

  const prompt1 = 'Generate Haiku for "I will always win"';
  await genAIAgent.generateHaiku(prompt1);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  const cardsAfterFirst = await page
    .locator('[data-testid="haiku-card"]')
    .count();

  const prompt2 = 'Generate Haiku for "The moon shines bright"';
  await genAIAgent.generateHaiku(prompt2);

  // A second card must actually ARRIVE. Without this the rest of the test is
  // satisfied by the first turn's DOM: the helpers read `cards.last()` and poll
  // the whole carousel, so a second turn that rendered nothing would still pass.
  // Asserting an INCREASE rather than inequality, because a count that dropped
  // would satisfy "different" while meaning the opposite. No exact target: one
  // haiku paints both an in-chat card and a carousel entry.
  await expect
    .poll(() => page.locator('[data-testid="haiku-card"]').count(), {
      timeout: 30_000,
    })
    .toBeGreaterThan(cardsAfterFirst);

  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});
