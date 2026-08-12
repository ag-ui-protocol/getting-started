import { expect, test } from "../../test-isolation-helper";
import {
  awaitLLMResponseDone,
  sendChatMessage,
} from "../../utils/copilot-actions";

test("[OpenAI Agents Python] Approval resumes a paused refund tool", async ({
  page,
}) => {
  test.slow();
  await page.goto("/openai-agents-python/feature/human_in_the_loop_approval");

  await sendChatMessage(page, "Please refund ORD-1001.");
  await awaitLLMResponseDone(page);
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("ORD-1001");

  await page.getByTestId("approve-button").click();
  await awaitLLMResponseDone(page);
  await expect(card).toBeHidden();
});
