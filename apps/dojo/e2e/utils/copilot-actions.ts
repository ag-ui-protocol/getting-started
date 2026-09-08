import { Page, expect } from "@playwright/test";
import { CopilotSelectors } from "./copilot-selectors";

/** Default timeout for waiting for LLM response to finish (SSE stream done) */
const LLM_RESPONSE_TIMEOUT = 60_000;
/** Default timeout for finding a DOM element after response */
const ELEMENT_TIMEOUT = 10_000;
/** Brief window to observe a just-started run before treating it as already done. */
const RUN_START_TIMEOUT = 2_000;

async function waitForNoActiveCopilotRun(
  page: Page,
  timeout = LLM_RESPONSE_TIMEOUT,
) {
  await page.waitForFunction(
    () => document.querySelector('[data-copilot-running="true"]') === null,
    null,
    { timeout },
  );
}

async function waitForCurrentCopilotRunToFinish(
  page: Page,
  timeout = LLM_RESPONSE_TIMEOUT,
) {
  try {
    await page.waitForFunction(
      () => document.querySelector('[data-copilot-running="true"]') !== null,
      null,
      { timeout: Math.min(RUN_START_TIMEOUT, timeout) },
    );
  } catch {
    // The response may have completed before Playwright observed running=true.
  }

  await waitForNoActiveCopilotRun(page, timeout);
}

/**
 * Wait until the assistant message count grows past `countBefore`, proving the
 * run we just triggered has actually started and we are not observing a stale
 * idle flag from the previous run.
 */
async function waitForNewAssistantMessage(
  page: Page,
  countBefore: number,
  timeout = LLM_RESPONSE_TIMEOUT,
) {
  await page.waitForFunction(
    (before) =>
      document.querySelectorAll('[data-testid="copilot-assistant-message"]')
        .length > before,
    countBefore,
    { timeout },
  );
}

async function expectSubmittedUserMessage(
  page: Page,
  userMessageIndex: number,
  message: string,
) {
  const submittedMessage =
    CopilotSelectors.userMessages(page).nth(userMessageIndex);
  await expect(submittedMessage).toContainText(message, {
    timeout: ELEMENT_TIMEOUT,
  });
}

/**
 * Wait for the LLM SSE stream to finish.
 * Uses the `data-copilot-running` attribute on the chat container.
 */
export async function awaitLLMResponseDone(
  page: Page,
  timeout = LLM_RESPONSE_TIMEOUT,
) {
  await waitForCurrentCopilotRunToFinish(page, timeout);
}

/**
 * Type a message into the chat input and click send.
 * Replaces the duplicated sendMessage pattern across all page objects.
 */
export async function sendChatMessage(page: Page, message: string) {
  const input = CopilotSelectors.chatTextarea(page);
  const sendButton = CopilotSelectors.sendButton(page);
  const userMessageCountBefore =
    await CopilotSelectors.userMessages(page).count();

  await input.click();
  await input.fill(message);
  await expect(input).toHaveValue(message);
  await expect(sendButton).toBeVisible();
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  try {
    await expectSubmittedUserMessage(page, userMessageCountBefore, message);
  } catch {
    // If the previous run is still closing, the click can be ignored while the
    // input keeps the text. Wait for the UI to become idle and submit once.
    await waitForNoActiveCopilotRun(page);
    await expect(input).toHaveValue(message);
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
    await expectSubmittedUserMessage(page, userMessageCountBefore, message);
  }
}

/**
 * Send a message and wait for the LLM to finish responding.
 *
 * Uses assistant message counting to avoid a race condition in multi-turn
 * conversations where `data-copilot-running="false"` from the previous
 * response is still present when we start checking.
 */
export async function sendAndAwaitResponse(
  page: Page,
  message: string,
  timeout = LLM_RESPONSE_TIMEOUT,
) {
  // Snapshot assistant message count before sending so we can detect
  // when the agent starts responding to THIS message.
  const countBefore = await page
    .locator('[data-testid="copilot-assistant-message"]')
    .count();

  await sendChatMessage(page, message);

  // Wait for a NEW assistant message to appear, proving the agent
  // started responding to our message (not a stale previous response).
  await waitForNewAssistantMessage(page, countBefore, timeout);

  // Now wait for the current run to finish. This helper first gives the UI a
  // chance to report running=true, so a stale idle flag cannot end the wait.
  await waitForCurrentCopilotRunToFinish(page, timeout);
}

/**
 * Run an interaction that starts an agent run without going through the chat
 * input (clicking a button rendered by the agent, for example) and wait for
 * that run to finish.
 *
 * Anchors on a NEW assistant message the same way `sendAndAwaitResponse` does:
 * `awaitLLMResponseDone` alone can return before the triggered run has started,
 * because its run-start window is short and a stale idle flag then ends the
 * wait immediately, leaving the caller's assertions racing the response.
 */
export async function awaitResponseAfterAction(
  page: Page,
  action: () => Promise<void>,
  timeout = LLM_RESPONSE_TIMEOUT,
) {
  const countBefore = await CopilotSelectors.assistantMessages(page).count();

  await action();

  await waitForNewAssistantMessage(page, countBefore, timeout);
  await waitForCurrentCopilotRunToFinish(page, timeout);
}

/**
 * Assert that the last assistant message contains the expected text.
 */
export async function assertAssistantReply(
  page: Page,
  expected: RegExp | string,
  timeout = ELEMENT_TIMEOUT,
) {
  const messages = CopilotSelectors.assistantMessages(page);
  const last = messages.last();
  await expect(last).toBeVisible({ timeout });
  if (typeof expected === "string") {
    await expect(last).toContainText(expected, { timeout });
  } else {
    await expect(last.getByText(expected)).toBeVisible({ timeout });
  }
}

/**
 * Assert that a user message is visible in the chat.
 */
export async function assertUserMessage(
  page: Page,
  text: string | RegExp,
  timeout = ELEMENT_TIMEOUT,
) {
  const messages = CopilotSelectors.userMessages(page);
  await expect(messages.getByText(text)).toBeVisible({ timeout });
}

/**
 * Open the chat by clicking the toggle button.
 * Silently succeeds if the chat is already open.
 */
export async function openChat(page: Page) {
  try {
    const toggle = CopilotSelectors.chatToggle(page);
    await toggle.click({ timeout: 3000 });
  } catch {
    // Chat may already be open
  }
}

/**
 * Hover over an assistant message to reveal the toolbar, then click regenerate.
 */
export async function regenerateResponse(page: Page, messageIndex: number) {
  const message = CopilotSelectors.assistantMessages(page).nth(messageIndex);
  await expect(message).toBeVisible({ timeout: ELEMENT_TIMEOUT });
  await message.hover();
  const regenerate = message.getByTestId("copilot-regenerate-button");
  try {
    await regenerate.click({ timeout: 3000 });
  } catch {
    await regenerate.click({ force: true });
  }
}
