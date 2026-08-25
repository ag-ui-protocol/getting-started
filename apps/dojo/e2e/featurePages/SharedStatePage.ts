import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import {
  sendChatMessage,
  awaitLLMResponseDone,
} from "../utils/copilot-actions";
import { DEFAULT_WELCOME_MESSAGE } from "../lib/constants";

export class SharedStatePage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly agentGreeting: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;
  readonly promptResponseLoader: Locator;
  readonly ingredientCards: Locator;
  readonly instructionsContainer: Locator;
  readonly addIngredient: Locator;

  constructor(page: Page) {
    this.page = page;
    this.agentGreeting = page.getByText(DEFAULT_WELCOME_MESSAGE);
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.promptResponseLoader = page.getByRole("button", {
      name: "Please Wait...",
      disabled: true,
    });
    this.instructionsContainer = page.locator(".instructions-container");
    this.addIngredient = page.getByRole("button", { name: "+ Add Ingredient" });
    this.agentMessage = CopilotSelectors.assistantMessages(page);
    this.userMessage = CopilotSelectors.userMessages(page);
    this.ingredientCards = page.locator(".ingredient-card");
  }

  async openChat() {
    await expect(this.agentGreeting).toBeVisible();
  }

  async sendMessage(message: string) {
    await sendChatMessage(this.page, message);
    await awaitLLMResponseDone(this.page);
  }

  async loader() {
    // Wait for the LLM stream to finish using data-copilot-running
    await awaitLLMResponseDone(this.page);
  }

  async awaitIngredientCard(name: string) {
    // Use page.waitForFunction for case-insensitive matching on input values,
    // since CSS attribute selectors are case-sensitive
    await this.page.waitForFunction(
      (ingredientName) => {
        const inputs = document.querySelectorAll(
          ".ingredient-card input.ingredient-name-input",
        );
        return Array.from(inputs).some((input: HTMLInputElement) =>
          input.value.toLowerCase().includes(ingredientName.toLowerCase()),
        );
      },
      name,
      { timeout: 15000 },
    );
  }

  async addNewIngredient(placeholderText: string) {
    await this.addIngredient.click();
    await expect(
      this.page.locator(`input[placeholder="${placeholderText}"]`),
    ).toBeVisible();
  }

  async getInstructionItems(containerLocator: Locator) {
    const count = await containerLocator.locator(".instruction-item").count();
    if (count <= 0) {
      throw new Error("No instruction items found in the container.");
    }
    console.log(`✅ Found ${count} instruction items.`);
    return count;
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    await expect(this.agentMessage.getByText(expectedText)).toBeVisible();
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }

  // --- Dietary preferences (client -> agent shared-state write-back) ---

  dietaryCheckbox(label: string): Locator {
    return this.page
      .locator(".dietary-option", { hasText: label })
      .locator('input[type="checkbox"]');
  }

  async isDietaryChecked(label: string): Promise<boolean> {
    return this.dietaryCheckbox(label).isChecked();
  }

  async setDietary(label: string, checked: boolean) {
    const box = this.dietaryCheckbox(label);
    if (checked) await box.check();
    else await box.uncheck();
  }

  /** Click "Improve with AI" and wait for the agent run to finish. */
  async improve() {
    await this.page.getByTestId("improve-button").click();
    await awaitLLMResponseDone(this.page);
    // Let the streamed state settle onto the UI before asserting.
    await this.page.waitForTimeout(1500);
  }

  /**
   * Resolve with the completed runtime SSE body for the run whose request body
   * contains `marker` (a quote-free fragment of the prompt — the prompt's own
   * quotes get JSON-escaped in the body, so match a bare fragment). Scopes to
   * the run POST (agent-info / suggestion POSTs to the same endpoint lack the
   * marker). Call BEFORE sending the message.
   */
  captureRuntimeSSE(integrationId: string, marker: string): Promise<string> {
    const idRe = integrationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pathRe = new RegExp(`/api/copilotkit/${idRe}(/|$)`);
    let settled = false;
    return new Promise<string>((resolve) => {
      this.page.on("response", async (response) => {
        if (settled) return;
        try {
          if (
            !pathRe.test(new URL(response.url()).pathname) ||
            response.request().method() !== "POST" ||
            !(response.request().postData() ?? "").includes(marker)
          ) {
            return;
          }
          // Read the body defensively: a matching response whose body can't be
          // buffered (redirect, aborted retry, teardown race) must not reject
          // the capture — keep waiting for the real run response.
          const body = await response.text();
          if (!settled) {
            settled = true;
            resolve(body);
          }
        } catch {
          // ignore this response; a readable match may still arrive
        }
      });
    });
  }

  /**
   * OSS-414: assert the agent's working-memory update streamed as MULTIPLE
   * incremental STATE_DELTAs DURING the run (before RUN_FINISHED), so shared
   * state renders progressively as the model writes it — not as one blob at the
   * end (and not only via the run-end STATE_SNAPSHOT the bridge always emitted).
   * The bridge consumes Mastra's `updateWorkingMemory` arg-deltas and re-parses
   * the growing JSON, so a healthy run shows many small state patches.
   */
  assertStreamedStateDelta(sse: string): void {
    const deltaCount = (sse.match(/"type":"STATE_DELTA"/g) ?? []).length;
    expect(
      deltaCount,
      "working memory must stream as MULTIPLE incremental STATE_DELTAs (progressive render), not one blob",
    ).toBeGreaterThan(1);
    const firstSnapshotIdx = sse.indexOf('"type":"STATE_SNAPSHOT"');
    const firstDeltaIdx = sse.indexOf('"type":"STATE_DELTA"');
    const finishedIdx = sse.indexOf('"type":"RUN_FINISHED"');
    // A leading STATE_SNAPSHOT must establish the base BEFORE the first delta:
    // the runtime applies deltas from an empty document, so without it the first
    // delta's paths are unresolvable, the run never finishes, and the Mastra
    // thread lock leaks (OSS-414 regression — the "stuck on stop" bug).
    expect(
      firstSnapshotIdx,
      "a STATE_SNAPSHOT must establish the base before any STATE_DELTA",
    ).toBeGreaterThan(-1);
    expect(
      firstSnapshotIdx,
      "the establishing STATE_SNAPSHOT must precede the first STATE_DELTA",
    ).toBeLessThan(firstDeltaIdx);
    // The run must actually finish (this is what reverts the stop button to
    // send) and it must not error out mid-stream.
    expect(finishedIdx, "RUN_FINISHED must reach the wire").toBeGreaterThan(-1);
    expect(sse.includes('"type":"RUN_ERROR"'), "run must not error").toBe(
      false,
    );
    expect(
      firstDeltaIdx,
      "STATE_DELTA must stream BEFORE RUN_FINISHED (live, not just the run-end snapshot)",
    ).toBeLessThan(finishedIdx);
  }
}
