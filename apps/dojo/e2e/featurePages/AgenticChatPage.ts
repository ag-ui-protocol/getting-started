import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import { sendAndAwaitResponse } from "../utils/copilot-actions";
import { DEFAULT_WELCOME_MESSAGE } from "../lib/constants";

export class AgenticChatPage {
  readonly page: Page;
  readonly openChatButton: Locator;
  readonly agentGreeting: Locator;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.openChatButton = CopilotSelectors.chatToggle(page);
    this.agentGreeting = page.getByText(DEFAULT_WELCOME_MESSAGE);
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.agentMessage = CopilotSelectors.assistantMessages(page);
    this.userMessage = CopilotSelectors.userMessages(page);
  }

  async openChat() {
    try {
      await this.openChatButton.click({ timeout: 3000 });
    } catch (error) {
      // Chat might already be open
    }
  }

  async sendMessage(
    message: string,
    options: { assistantMessagesAdded?: number } = {},
  ) {
    const assistantMessageCountBefore = await this.agentMessage.count();

    // Use the multi-turn-safe send. The previous `awaitLLMResponseDone`
    // returned as soon as it saw `data-copilot-running="false"`, but on a
    // multi-turn conversation that attribute still holds the PREVIOUS turn's
    // finished state — so the wait could return before the new run started.
    // The next send would then fire while the prior run was still active, the
    // agent dropped it, and the user message never rendered (flaky timeout).
    // `sendAndAwaitResponse` snapshots the assistant-message count and waits
    // for a NEW response before treating the run as done, so each turn fully
    // completes before the next send.
    await sendAndAwaitResponse(this.page, message);

    const assistantMessagesAdded = options.assistantMessagesAdded ?? 1;
    if (assistantMessagesAdded > 1) {
      await expect(this.agentMessage).toHaveCount(
        assistantMessageCountBefore + assistantMessagesAdded,
      );
    }
  }

  async getGradientButtonByName(name: string | RegExp) {
    return this.page.getByRole("button", { name });
  }

  async assertUserMessageVisible(text: string | RegExp) {
    await expect(this.userMessage.getByText(text)).toBeVisible();
  }

  async assertAgentReplyVisible(expectedText: RegExp | RegExp[]) {
    const expectedTexts = Array.isArray(expectedText)
      ? expectedText
      : [expectedText];
    let lastError: unknown = null;
    for (const pattern of expectedTexts) {
      try {
        const agentMessage = CopilotSelectors.assistantMessages(
          this.page,
        ).filter({
          hasText: pattern,
        });
        await expect(agentMessage.last()).toBeVisible();
        return; // At least one pattern matched, succeed
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError; // No pattern matched
  }

  async assertAgentReplyContains(expectedText: string) {
    const agentMessage = CopilotSelectors.assistantMessages(this.page).last();
    await expect(agentMessage).toContainText(expectedText);
  }

  async getAssistantMessageText(index: number): Promise<string> {
    const message = this.agentMessage.nth(index);
    await expect(message).toBeVisible();
    return (await message.textContent()) ?? "";
  }

  async regenerateResponse(index: number) {
    const message = this.agentMessage.nth(index);
    await expect(message).toBeVisible();

    // Hover over the message to reveal the regenerate button
    await message.hover();

    const regenerateButton = message.getByTestId("copilot-regenerate-button");

    try {
      await regenerateButton.click({ timeout: 3000 });
    } catch {
      // If hover didn't reveal the button, force click
      await regenerateButton.click({ force: true });
    }
  }

  async assertWeatherResponseStructure() {
    // The get_weather tool renders a deterministic component with data-testid="weather-info"
    const weatherInfo = this.page.getByTestId("weather-info");
    await expect(weatherInfo.last()).toBeVisible();

    await expect(weatherInfo.last()).toContainText("Temperature:");
    await expect(weatherInfo.last()).toContainText("Humidity:");
    await expect(weatherInfo.last()).toContainText("Wind Speed:");
    await expect(weatherInfo.last()).toContainText("Conditions:");
  }
}
