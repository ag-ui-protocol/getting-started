import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import {
  sendAndAwaitResponse,
  awaitResponseAfterAction,
} from "../utils/copilot-actions";

/**
 * Page object for A2UI feature tests (fixed schema, dynamic schema, advanced).
 * Provides helpers for interacting with the chat and asserting A2UI surface rendering.
 */
export class A2UIPage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly assistantMessages: Locator;
  readonly userMessages: Locator;

  constructor(page: Page) {
    this.page = page;
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.assistantMessages = CopilotSelectors.assistantMessages(page);
    this.userMessages = CopilotSelectors.userMessages(page);
  }

  async openChat() {
    try {
      await CopilotSelectors.chatToggle(this.page).click({ timeout: 3000 });
    } catch {
      // Chat may already be open
    }
  }

  /**
   * Send a message and wait for the run it starts to finish.
   *
   * `awaitLLMResponseDone` alone is not enough: its run-start window is short,
   * so the previous turn's `data-copilot-running="false"` can end the wait
   * before the new run has started, and the caller's first assertion then races
   * the response. `sendAndAwaitResponse` anchors on a NEW assistant message
   * first, the same way `clickSurfaceAction` does for the action path.
   */
  async sendMessage(message: string) {
    await sendAndAwaitResponse(this.page, message);
  }

  async assertUserMessageVisible(text: string | RegExp) {
    await expect(this.userMessages.getByText(text)).toBeVisible();
  }

  async assertAgentReplyVisible(expectedText: RegExp | RegExp[]) {
    const patterns = Array.isArray(expectedText)
      ? expectedText
      : [expectedText];
    let lastError: unknown = null;
    for (const pattern of patterns) {
      try {
        const msg = this.assistantMessages.filter({ hasText: pattern });
        await expect(msg.last()).toBeVisible();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /** Locate an A2UI surface container by its surface ID */
  surface(surfaceId: string): Locator {
    return this.page.locator(`[data-surface-id="${surfaceId}"]`);
  }

  /** Locate any A2UI surface container (when surface ID is unknown) */
  anySurface(): Locator {
    return this.page.locator("[data-surface-id]");
  }

  /**
   * A single surface node to assert on, count inside, or click inside.
   *
   * `surface()` and `anySurface()` stay multi-element on purpose so callers can
   * count SURFACES with them, but an `expect()` or a click against a
   * multi-element locator throws a strict mode violation as soon as the same
   * surface id is painted twice, which the action flow can do, and a count taken
   * through them doubles for the same reason. Preferring a visible node also
   * keeps a stale hidden duplicate earlier in the DOM from failing the
   * assertion.
   *
   * Use this (not `surface()`) whenever the assertion is about what is INSIDE
   * one surface.
   */
  visibleSurface(surfaceId?: string): Locator {
    const surfaces = surfaceId ? this.surface(surfaceId) : this.anySurface();
    return surfaces.filter({ visible: true }).first();
  }

  /**
   * The action buttons labelled `label` inside a single visible surface.
   *
   * The counting-safe way to assert how many cards are in a given state ("one
   * Booked"): scoped to one surface node, so a duplicate paint of the same
   * surface id cannot double the count. A string label matches exactly, keeping
   * "Book" off an already-clicked "Booked".
   */
  surfaceActions(label: string | RegExp, surfaceId?: string): Locator {
    return this.visibleSurface(surfaceId).getByRole("button", {
      name: label,
      // `exact` applies to string names only; Playwright ignores it for a
      // RegExp, which matches on its own terms.
      ...(typeof label === "string" ? { exact: true } : {}),
    });
  }

  /** Assert that at least one A2UI surface is rendered on the page */
  async assertSurfaceVisible(timeout = 30_000) {
    await expect(this.anySurface().first()).toBeVisible({ timeout });
  }

  /** Assert a surface with a specific ID is rendered */
  async assertSurfaceWithIdVisible(surfaceId: string, timeout = 30_000) {
    await expect(this.visibleSurface(surfaceId)).toBeVisible({ timeout });
  }

  /** Assert the rendered surface contains the given text */
  async assertSurfaceContainsText(text: string | RegExp, timeout = 30_000) {
    const surface = this.anySurface().first();
    await expect(surface).toBeVisible({ timeout });
    if (typeof text === "string") {
      await expect(surface).toContainText(text, { timeout });
    } else {
      await expect(surface.getByText(text)).toBeVisible({ timeout });
    }
  }

  /** Assert multiple texts are present within any rendered surfaces */
  async assertSurfaceContainsAll(texts: (string | RegExp)[], timeout = 10_000) {
    for (const text of texts) {
      await this.assertSurfaceContainsText(text, timeout);
    }
  }

  /** Count the number of rendered A2UI surfaces */
  async getSurfaceCount(): Promise<number> {
    return this.anySurface().count();
  }

  /**
   * Click an action button on a rendered surface and wait for the run it starts.
   *
   * The A2UI middleware forwards the click, appends a synthetic log_a2ui_event
   * assistant call plus its result to the history, and re-runs the agent, so the
   * agent's reply about the choice arrives as a new turn.
   *
   * `nth` is a 0-based index into the buttons that CURRENTLY match `label`
   * inside the surface, in DOM order. It is not a card index: a clicked button
   * relabels (Book -> Booked), so it leaves the match set and the remaining
   * buttons re-index. On a three-card surface, clicking `nth: 1` hits the second
   * card, and a following `nth: 0` hits the first.
   *
   * A string label matches exactly, keeping "Book" off an already-clicked
   * "Booked"; a RegExp matches on its own terms (Playwright applies no
   * exactness to it), so anchor it if it must not also match "Booked".
   *
   * The wait is anchored on the new assistant turn appearing, so callers can
   * assert on the reply straight after this resolves.
   */
  async clickSurfaceAction(
    label: string | RegExp,
    surfaceId?: string,
    options: { nth?: number } = {},
  ) {
    const scope = this.visibleSurface(surfaceId);
    await expect(scope).toBeVisible({ timeout: 30_000 });
    const action = this.surfaceActions(label, surfaceId).nth(options.nth ?? 0);
    await awaitResponseAfterAction(this.page, () => action.click());
  }
}
