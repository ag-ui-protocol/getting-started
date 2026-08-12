import { expect, test } from "../../test-isolation-helper";
import { sendAndAwaitResponse } from "../../utils/copilot-actions";

test("[OpenAI Agents Python] Custom Lifecycle Events keeps usage with each reply", async ({
  page,
}) => {
  await page.goto("/openai-agents-python/feature/custom_lifecycle_events");

  await sendAndAwaitResponse(page, "Hi");
  await sendAndAwaitResponse(page, "Tell me one interesting fact about AI.");

  const usageLabels = page.getByLabel("Run usage");
  await expect(usageLabels).toHaveCount(2);
  for (const usage of await usageLabels.all()) {
    await expect(usage).toContainText(/\d+ input tokens/);
    await expect(usage).toContainText(/\d+ output tokens/);
  }
});
