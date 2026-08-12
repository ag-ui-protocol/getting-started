import { expect, test } from "../../test-isolation-helper";
import { sendAndAwaitResponse } from "../../utils/copilot-actions";

test("[OpenAI Agents Python] Dynamic System Prompt changes the reply language", async ({
  page,
}) => {
  test.slow();
  await page.goto("/openai-agents-python/feature/dynamic_system_prompt");

  await page.getByRole("button", { name: /Arabic/ }).click();
  await sendAndAwaitResponse(page, "Which language are you using?");
  const latestReply = () =>
    page
      .locator('[data-testid="copilot-assistant-message"]')
      .last()
      .locator("p")
      .last();
  await expect(latestReply()).toContainText(/[\u0600-\u06ff]/);

  await page.getByRole("button", { name: /German/ }).click();
  await sendAndAwaitResponse(page, "Which language are you using now?");
  await expect(latestReply()).toContainText(/deutsch/i);
});
