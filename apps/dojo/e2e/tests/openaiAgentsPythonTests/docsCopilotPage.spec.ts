import { expect, test } from "../../test-isolation-helper";
import { sendAndAwaitResponse } from "../../utils/copilot-actions";

test("[OpenAI Agents Python] Docs Copilot reads the integration documentation", async ({
  page,
}) => {
  await page.goto("/openai-agents-python/feature/ag_ui_docs_copilot");

  await sendAndAwaitResponse(
    page,
    "How do I test the OpenAI Agents integration?",
  );

  await expect(page.getByText("AG-UI OpenAI Agents docs").last()).toBeVisible();
  await expect(page.getByText('Read "Testing"').last()).toBeVisible();
});
