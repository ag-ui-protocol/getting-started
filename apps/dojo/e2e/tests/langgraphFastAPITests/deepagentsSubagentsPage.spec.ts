import { test, expect } from "../../test-isolation-helper";
import {
  sendChatMessage,
  awaitLLMResponseDone,
} from "../../utils/copilot-actions";
import {
  SUBAGENT_FINAL_ANSWER,
  SUBAGENT_REJECTED_REPLY,
  SUPERVISOR_RELAY,
} from "../../deepagents-subagents-fixtures";

// PNI-276: end-to-end coverage for subagent rendering. These tests cover what
// is SPECIFIC to subagents rather than re-testing chat: grouping, the interrupt
// raised INSIDE the subagent, and two invariants only a browser can check —
// that attribution survives the final MESSAGES_SNAPSHOT replacing the thread
// (a snapshot that dropped subagentRunId would collapse every group into the
// parent), and that no group is left spinning after the run finishes.
//
// The demo lives on langgraph-fastapi only: the platform lane goes through the
// TypeScript LangGraphAgent client, which does not emit SUBAGENT_* events (see
// the note in apps/dojo/src/menu.ts) — hence this file's home, despite the
// ticket naming the platform suite.
test.describe("Deepagents Subagents Feature", () => {
  test("[LangGraph FastAPI] groups the subagent's work, approves its answer, and finishes cleanly", async ({
    page,
  }) => {
    await page.goto("/langgraph-fastapi/feature/deepagents_subagents");

    await sendChatMessage(page, "Why is the sky blue?");

    // The delegation surfaces as a subagent group tagged with its identity.
    const group = page.getByTestId("subagent-group").first();
    await expect(group).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("subagent-tag").first()).toBeVisible();

    // The interrupt raised INSIDE the subagent renders the approval prompt.
    const hitl = page.getByTestId("subagent-hitl").first();
    await expect(hitl).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("subagent-hitl-approve").click();

    // Resuming continues the SAME subagent to completion: status reaches
    // finished, and its final answer renders inside the group — not in the
    // parent thread.
    await awaitLLMResponseDone(page);
    await expect(page.getByTestId("subagent-done").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(group).toContainText(SUBAGENT_FINAL_ANSWER);

    // The parent thread carries the supervisor's own relay.
    await expect(page.getByText(SUPERVISOR_RELAY)).toBeVisible();

    // Exactly one clean terminal: nothing errored, nothing left spinning —
    // including on this interrupt path.
    await expect(page.getByTestId("subagent-error")).toHaveCount(0);
    await expect(page.getByTestId("subagent-activity")).toHaveCount(0);

    // Attribution survives the final MESSAGES_SNAPSHOT: the run is over (the
    // snapshot has replaced the thread), yet the subagent's message still
    // renders inside its group with its tag, not collapsed into the parent.
    await expect(group).toContainText(SUBAGENT_FINAL_ANSWER);
    await expect(page.getByTestId("subagent-tag").first()).toBeVisible();
  });

  test("[LangGraph FastAPI] rejecting the approval produces a visibly different, still-clean finish", async ({
    page,
  }) => {
    await page.goto("/langgraph-fastapi/feature/deepagents_subagents");

    await sendChatMessage(page, "Why is the sky blue?");

    const hitl = page.getByTestId("subagent-hitl").first();
    await expect(hitl).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("subagent-hitl-reject").click();

    // The subagent withholds the answer and says so — the demo's reject path
    // is deliberately loud so a human can tell which button they clicked.
    await awaitLLMResponseDone(page);
    const group = page.getByTestId("subagent-group").first();
    await expect(group).toContainText(SUBAGENT_REJECTED_REPLY, {
      timeout: 30_000,
    });
    await expect(group).not.toContainText(SUBAGENT_FINAL_ANSWER);

    // Same clean-terminal invariants on the reject path.
    await expect(page.getByTestId("subagent-done").first()).toBeVisible();
    await expect(page.getByTestId("subagent-error")).toHaveCount(0);
    await expect(page.getByTestId("subagent-activity")).toHaveCount(0);
  });
});
