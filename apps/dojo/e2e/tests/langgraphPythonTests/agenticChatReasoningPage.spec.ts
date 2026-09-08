import { test, expect } from "../../event-trace-test";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { agenticChatReasoningPageEventTrace } from "./agenticChatReasoningPage.event-trace";

test.describe("[Integration] LangGraph Python - Agentic Chat Reasoning", () => {
  test("should display model selection dropdown", async ({ page }) => {
    await page.goto("/langgraph/feature/agentic_chat_reasoning");

    const dropdown = page.getByRole("button", {
      name: /OpenAI|Anthropic|Gemini/i,
    });
    await expect(dropdown).toBeVisible({ timeout: 10000 });
  });

  test("should show reasoning indicator and then the response", async ({
    page,
    eventTrace,
  }) => {
    await page.goto("/langgraph/feature/agentic_chat_reasoning");
    await openChat(page);

    await sendChatMessage(page, "What is the best car to buy?");
    await awaitLLMResponseDone(page);

    // The reasoning UI renders "Thought for Xs" after reasoning completes
    const reasoningIndicator = page.getByText(/Thought for/i);
    await expect(reasoningIndicator).toBeVisible({ timeout: 10000 });

    // The assistant response should also be visible
    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText(
      /Toyota|Honda|Mazda|recommendations/i,
      { timeout: 10000 },
    );
    await eventTrace.expectJourney(
      agenticChatReasoningPageEventTrace.showReasoningIndicatorAndThenTheResponse,
    );
  });
});
