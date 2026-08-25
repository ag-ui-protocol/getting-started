import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import {
  sendChatMessage,
  awaitLLMResponseDone,
} from "../utils/copilot-actions";

/**
 * Page object for the Background Agents demo. The agent dispatches a Mastra
 * background task; the AG-UI bridge maps its lifecycle to ACTIVITY events,
 * which a `renderActivityMessages` renderer draws as a distinct Background Task
 * card. Completion is delivered out of band, so within a single run the card's
 * terminal state is "Running" — that's what we assert.
 */
export class BackgroundAgentsPage {
  readonly page: Page;
  readonly messageBox: Locator;
  readonly card: Locator;
  readonly status: Locator;

  constructor(page: Page) {
    this.page = page;
    this.messageBox = CopilotSelectors.chatTextarea(page);
    this.card = page.locator('[data-testid="background-task-card"]');
    this.status = page.locator('[data-testid="background-task-status"]');
  }

  async dispatchResearch(message: string) {
    await expect(this.messageBox).toBeVisible();
    await sendChatMessage(this.page, message);
    await awaitLLMResponseDone(this.page);
  }

  async expectActivityCard(topic: string) {
    const card = this.card.last();
    await expect(card).toBeVisible();
    // The backgrounded tool surfaces as an activity, NOT a normal tool render.
    await expect(card).toContainText("Background Task");
    await expect(card).toContainText("run_deep_research");
    await expect(card.getByTestId("background-task-status")).toHaveText(
      "Running",
    );
    // The tool args (topic) are lifted onto the activity snapshot.
    await expect(card).toContainText(topic);
  }

  /**
   * The normal tool-call render must be suppressed for a backgrounded call —
   * there should be no generic/unknown "tool running" pill duplicating the
   * activity card.
   */
  async expectNoOrphanToolRender() {
    const orphan = this.page
      .getByRole("button")
      .filter({ hasText: /unknown/i });
    await expect(orphan).toHaveCount(0);
  }
}
