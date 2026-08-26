import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import { sendAndAwaitResponse } from "../utils/copilot-actions";

/**
 * Multi-agent (Strands Graph) demo. The pipeline cards are driven by
 * STEP_STARTED / STEP_FINISHED and the handoff rows by the
 * `MultiAgentHandoff` CUSTOM event, so asserting on them asserts the
 * adapter's orchestrator translation rather than just the chat text.
 */
export class MultiAgentPage {
  readonly page: Page;
  readonly pipeline: Locator;
  readonly handoffs: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.pipeline = page.getByTestId("multi-agent-pipeline");
    this.handoffs = page.getByTestId("multi-agent-handoff");
    this.agentMessage = CopilotSelectors.assistantMessages(page);
    this.userMessage = CopilotSelectors.userMessages(page);
  }

  node(nodeId: string): Locator {
    return this.page.getByTestId(`multi-agent-node-${nodeId}`);
  }

  /** The chat is rendered inline on this page, so it needs no toggle. */
  async waitForChatReady() {
    await expect(this.pipeline).toBeVisible();
  }

  async sendMessage(message: string) {
    await sendAndAwaitResponse(this.page, message);
  }

  async assertUserMessageVisible(text: string | RegExp) {
    await expect(this.userMessage.getByText(text).first()).toBeVisible();
  }

  /** Every node starts out waiting, before any run. */
  async assertAllNodesPending(nodeIds: string[]) {
    for (const nodeId of nodeIds) {
      await expect(this.node(nodeId)).toHaveAttribute("data-status", "pending");
    }
  }

  /**
   * Handoff rows in emission order, each as "from>to". Read from data
   * attributes rather than row text: a node id containing "to", or a Swarm
   * handoff message rendered in the same row, would corrupt a text split.
   * Asserting the ordered list pins the route control actually took.
   */
  async handoffRoute(): Promise<string[]> {
    return this.handoffs.evaluateAll((rows) =>
      rows.map(
        (row) =>
          `${row.getAttribute("data-handoff-from") ?? ""}>${
            row.getAttribute("data-handoff-to") ?? ""
          }`,
      ),
    );
  }

  /** Ordered node statuses, so a failed node cannot pass as a finished one. */
  async nodeStatuses(nodeIds: string[]): Promise<string[]> {
    const statuses: string[] = [];
    for (const nodeId of nodeIds) {
      statuses.push(
        (await this.node(nodeId).getAttribute("data-status")) ?? "",
      );
    }
    return statuses;
  }

  /**
   * Index of the first assistant message matching each pattern. A strictly
   * increasing result means each node's text landed in its own message and the
   * messages arrived in pipeline order; a merged envelope repeats an index.
   */
  async assistantMessageOrder(patterns: RegExp[]): Promise<number[]> {
    const texts = await this.agentMessage.allInnerTexts();
    return patterns.map((pattern) => {
      // A missing message returns -1, which would still read as "increasing"
      // against a later index, so it is reported as a distinct sentinel.
      const index = texts.findIndex((t) => new RegExp(pattern.source).test(t));
      return index === -1 ? Number.NaN : index;
    });
  }

  async assertAgentReplyVisible(pattern: RegExp) {
    await expect(
      this.agentMessage.filter({ hasText: pattern }).first(),
    ).toBeVisible();
  }
}
