import { test, expect } from "../../test-isolation-helper";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { blockExternalNetwork } from "./network";

test.beforeEach(async ({ page }) => blockExternalNetwork(page));

test("[tRPC-Agent-Go] Reasoning is streamed with the answer", async ({
  page,
}) => {
  await page.goto("/trpc-agent-go/feature/agentic_chat_reasoning");
  await openChat(page);

  await sendChatMessage(page, "What is the best car to buy?");
  await awaitLLMResponseDone(page);

  await expect(page.getByText(/Thought for/i)).toBeVisible();
  await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
    /Toyota|Honda|Mazda|recommendations/i,
  );
});
