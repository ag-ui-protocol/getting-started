import { test, expect } from "../../test-isolation-helper";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

// The reasoning cell lets the user pick a provider (state.model). OpenAI's
// reasoning models expose their reasoning summaries only over the Responses API,
// so the bridge streams the OpenAI option there and maps the summaries onto
// REASONING_*; the default (OpenAI) therefore surfaces a real thinking trace.
// Anthropic / Gemini reason on the chat-completions delta and are covered by the
// bridge suite (integrations/crew-ai/python/tests/test_reasoning.py).
test.describe("[Integration] CrewAI - Agentic Chat Reasoning", () => {
  test("should display the model selection dropdown", async ({ page }) => {
    await page.goto("/crewai/feature/agentic_chat_reasoning");

    const dropdown = page.getByRole("button", {
      name: /OpenAI|Anthropic|Gemini/i,
    });
    await expect(dropdown).toBeVisible({ timeout: 10000 });
  });

  test("should show reasoning indicator and then the response", async ({
    page,
  }) => {
    await page.goto("/crewai/feature/agentic_chat_reasoning");
    await openChat(page);

    await sendChatMessage(page, "What is the best car to buy?");
    await awaitLLMResponseDone(page);

    // The reasoning UI renders "Thought for Xs" after reasoning completes.
    //
    // Asserted hard rather than conditionally. The flow surfaces a trace only
    // over the Responses channel and deliberately degrades to chat-completions
    // (no trace) when the bridge probes that channel as unavailable, but that
    // degrade is unreachable here: the probe is a capability check on the
    // resolved litellm entrypoint, and the crew-ai server this suite runs
    // against installs the locked litellm, which exposes it. Treating a missing
    // trace as an acceptable outcome would instead leave the demo's whole point
    // untested, since "answers with no thinking trace" is exactly the regression
    // this test exists to catch and the browser cannot tell it apart from the
    // degrade. The message names the degrade path so an out-of-floor litellm is
    // diagnosed as such instead of being chased through the UI.
    const reasoningIndicator = page.getByText(/Thought for/i);
    await expect(
      reasoningIndicator,
      "no reasoning trace: either REASONING events stopped reaching the UI, or " +
        "the crew-ai server degraded to chat-completions because its litellm " +
        "exposes no Responses entrypoint (it logs that warning when it does)",
    ).toBeVisible({ timeout: 10000 });

    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText(
      /Toyota|Honda|Mazda|recommendations/i,
      { timeout: 15000 },
    );
  });
});
