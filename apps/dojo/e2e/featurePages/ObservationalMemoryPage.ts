import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import {
  sendChatMessage,
  awaitLLMResponseDone,
} from "../utils/copilot-actions";

/**
 * Page object for the Observational Memory demo. The agent has Mastra
 * Observational Memory enabled; as the conversation grows, Mastra's Observer
 * runs out of band and streams `data-om-*` chunks, which the AG-UI bridge maps
 * to ACTIVITY events. A `renderActivityMessages` renderer draws each OM cycle as
 * a distinct "Observational Memory" card. OM is async, so within a turn the
 * card's terminal state may be "Working", "Completed", or "Activated" — we
 * assert the card surfaces with one of those, not a specific one.
 */
export class ObservationalMemoryPage {
  readonly page: Page;
  readonly messageBox: Locator;
  readonly card: Locator;
  readonly status: Locator;

  constructor(page: Page) {
    this.page = page;
    this.messageBox = CopilotSelectors.chatTextarea(page);
    this.card = page.locator('[data-testid="om-activity-card"]');
    this.status = page.locator('[data-testid="om-activity-status"]');
  }

  async chat(message: string) {
    await expect(this.messageBox).toBeVisible();
    await sendChatMessage(this.page, message);
    await awaitLLMResponseDone(this.page);
  }

  // A deliberately LARGE first message. The Observer triggers on UNOBSERVED
  // message tokens (user + assistant), so a big user turn reliably crosses the
  // agent's low `messageTokens` threshold regardless of how terse the model's
  // replies are — which keeps this deterministic in CI (short replies alone
  // would accumulate too slowly).
  private static readonly LONG_CONTEXT =
    "I'm planning a detailed two-week trip through Japan in spring and want your help. " +
    "Here is a lot of context so you can tailor everything to me: I love regional food, " +
    "quiet temples, scenic local train lines, hot springs, gardens, craft markets, and " +
    "small mountain towns. I strongly dislike big crowds, long queues, loud nightlife, and " +
    "touristy chain restaurants. I am vegetarian and I do not drink alcohol, so keep that in " +
    "mind for every food suggestion. I prefer traditional inns, I wake up early, and I want a " +
    "relaxed pace with at most one destination change every two or three days. My budget is " +
    "moderate. Please remember all of these preferences for the rest of our conversation, and " +
    "start by suggesting a few regions that fit, with a short reason for each.";

  /**
   * Drive the conversation until the OM Observer fires. Each turn is sizable so
   * UNOBSERVED message tokens climb past the agent's threshold within a couple
   * of turns regardless of how terse the model's replies are. OM observation is
   * async, so we poll for the activity card after each turn and stop as soon as
   * it appears.
   */
  async driveUntilObservation() {
    const turns = [
      ObservationalMemoryPage.LONG_CONTEXT,
      "Given all of that, walk me through the regional food scene in detail, " +
        "region by region, with specific vegetarian dishes to seek out and " +
        "which towns are best for each. Remember: no alcohol, small crowds.",
      "Now lay out a detailed rough day-by-day itinerary for the whole first " +
        "week, naming cities, the scenic train legs between them, and a temple " +
        "or garden for each day, keeping my slow pace and inn preference in mind.",
    ];
    for (const turn of turns) {
      await this.chat(turn);
      const appeared = await this.card
        .first()
        .waitFor({ state: "visible", timeout: 12_000 })
        .then(() => true)
        .catch(() => false);
      if (appeared) return;
    }
  }

  async expectObservationActivityCard() {
    const card = this.card.last();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("Observational Memory");
    await expect(this.status.last()).toHaveText(/Working|Completed|Activated/);
  }
}
