import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import {
  sendChatMessage,
  awaitResponseAfterAction,
} from "../../utils/copilot-actions";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";
import {
  captureRuntimeSSE,
  escapeForRegExp,
  sseFrameAt,
} from "../../utils/runtime-sse";

/**
 * Page object for the AWS Strands `predictive_state_updates` demos, which drive
 * the feature through the FRONTEND `write_document` tool.
 *
 * Separate from the other integrations' copies rather than shared with them: on
 * the legacy `confirm_changes` path their specs exercise, the dialog stays
 * mounted after a decision and shows an accepted/rejected chip, so
 * `awaitConfirmDismissed` would never settle there.
 */
export class PredictiveStateUpdatesPage {
  readonly page: Page;
  readonly agentGreeting: Locator;
  readonly confirmModal: Locator;
  readonly assistantMessages: Locator;

  constructor(page: Page) {
    this.page = page;
    this.agentGreeting = page.getByText(DEFAULT_WELCOME_MESSAGE);
    this.confirmModal = page
      .locator('[data-testid="confirm-changes-modal"]')
      .last();
    this.assistantMessages = CopilotSelectors.assistantMessages(page);
  }

  /**
   * Wait for the chat to be ready.
   *
   * The sidebar is already open via the page's `chatDefaultOpen` default, so
   * there is nothing to click; the welcome message is the readiness signal.
   */
  async awaitChatReady() {
    await expect(this.agentGreeting).toBeVisible();
  }

  async sendMessage(message: string) {
    await sendChatMessage(this.page, message);
  }

  async approveChanges() {
    const confirm = this.confirmModal.locator('[data-testid="confirm-button"]');
    await expect(confirm).toBeEnabled();
    await awaitResponseAfterAction(this.page, () => confirm.click());
  }

  async rejectChanges() {
    const reject = this.confirmModal.locator('[data-testid="reject-button"]');
    await expect(reject).toBeEnabled();
    await awaitResponseAfterAction(this.page, () => reject.click());
  }

  /**
   * Wait for the confirm dialog to go away.
   *
   * On the `write_document` path the dialog is only rendered while the tool is
   * executing, so answering it unmounts the card. Its disappearance is the
   * signal that the decision reached the agent.
   */
  async awaitConfirmDismissed() {
    await expect(
      this.page.locator('[data-testid="confirm-changes-modal"]'),
    ).toHaveCount(0, { timeout: 30_000 });
  }

  /** Capture the runtime's SSE body for the run carrying `marker`. */
  captureRuntimeSSE(integrationId: string, marker: string): Promise<string> {
    return captureRuntimeSSE(this.page, integrationId, marker);
  }

  /**
   * Assert the wire carried a predict-state mapping for `tool`, ahead of that
   * tool's argument deltas, and that the arguments then streamed incrementally.
   *
   * This is what makes the demo predictive rather than merely eventually
   * correct. Without the mapping the browser has nothing to project partial
   * arguments onto, and the editor only fills when the authoritative
   * `StateSnapshot` lands, which happens anyway. So a DOM-only assertion passes
   * with the mapping deleted, and only the wire distinguishes the two.
   */
  assertPredictStatePrecedesArgs(
    sse: string,
    tool: string,
    stateKey: string,
    argument: string,
  ) {
    // The frame for THIS tool, not merely the first PredictState on the wire: a
    // demo mapping several tools would otherwise be asserted against whichever
    // frame happened to come first.
    const predictIdx = sse.search(
      new RegExp(
        `"type":"CUSTOM"[^\\n]*"name":"PredictState"[^\\n]*"tool":"${escapeForRegExp(tool)}"`,
      ),
    );
    expect(
      predictIdx,
      `a PredictState custom event naming ${tool} must reach the wire`,
    ).toBeGreaterThanOrEqual(0);

    // The whole mapping entry as one object, scoped to the single frame. Three
    // separate `toContain` checks would each pass against a DIFFERENT entry in
    // the array, and a bare `toContain(stateKey)` would pass on the tool name
    // alone whenever the key is a substring of it ("document" sits inside
    // "write_document"). Asserting the object also covers `tool_argument`,
    // without which the mapping cannot drive anything. Key order is the order
    // both bridges build the payload in.
    const predictFrame = sseFrameAt(sse, predictIdx);
    expect(
      predictFrame,
      `PredictState must map ${tool}'s ${argument} argument onto ${stateKey}`,
    ).toContain(
      `{"state_key":"${stateKey}","tool":"${tool}","tool_argument":"${argument}"}`,
    );

    const startRe = new RegExp(
      `"type":"TOOL_CALL_START"[^\\n]*"toolCallName":"${escapeForRegExp(tool)}"[^\\n]*`,
    );
    const startMatch = sse.match(startRe);
    expect(
      startMatch,
      `${tool} TOOL_CALL_START must reach the wire`,
    ).not.toBeNull();

    // The mapping is useless to the browser once the arguments have gone by, so
    // ordering is part of the contract, not an incidental detail.
    expect(
      predictIdx,
      "PredictState must precede the tool call it describes",
    ).toBeLessThan(startMatch!.index!);

    const callId = startMatch![0].match(/"toolCallId":"([^"]+)"/)?.[1];
    expect(callId, "TOOL_CALL_START must carry a toolCallId").toBeTruthy();
    const argFrames = sse.match(
      new RegExp(
        `"type":"TOOL_CALL_ARGS"[^\\n]*"toolCallId":"${escapeForRegExp(callId!)}"`,
        "g",
      ),
    );
    // One frame means the provider buffered the arguments, which leaves nothing
    // to predict from even with the mapping present.
    expect(
      argFrames?.length ?? 0,
      `${tool} arguments must stream as multiple incremental deltas`,
    ).toBeGreaterThanOrEqual(3);
  }
}
