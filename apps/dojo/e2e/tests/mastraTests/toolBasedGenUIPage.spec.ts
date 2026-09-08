import { test, expect } from "@playwright/test";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

const pageURL = "/mastra/feature/tool_based_generative_ui";

test("[Mastra] Haiku generation and display verification", async ({ page }) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});

// OSS-393: the @ag-ui/mastra bridge must consume Mastra's tool-call-delta
// chunks and forward them as incremental TOOL_CALL_ARGS, so tool-call args
// render progressively. Asserting on the completed SSE body keeps this
// flake-free (no live timing).
test("[Mastra] generate_haiku args stream incrementally on the wire", async ({
  page,
}) => {
  const genAIAgent = new ToolBaseGenUIPage(page);
  const prompt = 'Generate Haiku for "I will always win"';

  await page.goto(pageURL);
  await expect(genAIAgent.haikuAgentIntro).toBeVisible();

  // Match on a quote-free fragment — the prompt's own quotes get JSON-escaped
  // in the request body, so matching the raw prompt string would never hit.
  const ssePromise = genAIAgent.captureRuntimeSSE(
    "mastra",
    "I will always win",
  );
  await genAIAgent.generateHaiku(prompt);
  await genAIAgent.checkGeneratedHaiku();

  genAIAgent.assertIncrementalHaikuArgs(await ssePromise);
});

// test infra issue, not an integration issue
test.fixme(
  "[Mastra] Haiku generation and UI consistency for two different prompts",
  async ({ page }) => {
    await page.goto(pageURL);

    const genAIAgent = new ToolBaseGenUIPage(page);

    await expect(genAIAgent.haikuAgentIntro).toBeVisible();

    const prompt1 = 'Generate Haiku for "I will always win"';
    await genAIAgent.generateHaiku(prompt1);
    await genAIAgent.checkGeneratedHaiku();
    await genAIAgent.checkHaikuDisplay(page);

    const prompt2 = 'Generate Haiku for "The moon shines bright"';
    await genAIAgent.generateHaiku(prompt2);
    await genAIAgent.checkGeneratedHaiku(); // Wait for second haiku to be generated
    await genAIAgent.checkHaikuDisplay(page); // Now compare the second haiku
  },
);
