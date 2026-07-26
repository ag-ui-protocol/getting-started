import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";

// CAO's flagship: approve OR deny a live CLI permission prompt from the browser
// through AG-UI's run-lifecycle interrupt (RUN_FINISHED outcome=interrupt ->
// resume[]). Unlike the Mastra shared page (which can't assert post-resume text
// under aimock's streaming race), the CAO interrupt is backed by the
// deterministic keyless mock server on :8027, so we assert the actual
// approve-vs-deny semantics: a chosen slot grants, Cancel denies. The Cancel
// button resolves with {cancelled:true} at status "resolved" — the shape that
// used to be misread as an approval (the F1 bug).
const PROMPT = "Book an intro call with the sales team to discuss pricing.";

async function surfacePicker(page: import("@playwright/test").Page) {
  await page.goto("/cli-agent-orchestrator/feature/interrupt");
  await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();
  await CopilotSelectors.chatTextarea(page).fill(PROMPT);
  await CopilotSelectors.sendButton(page).click();
  const picker = page.getByTestId("interrupt-picker");
  await expect(picker).toBeVisible({ timeout: 30_000 });
  return picker;
}

test.describe("Interrupt (Suspend/Resume) Feature", () => {
  test("[CLI Agent Orchestrator] suspends a tool and surfaces the interrupt picker", async ({
    page,
  }) => {
    const picker = await surfacePicker(page);
    await expect(picker.getByRole("button").first()).toBeVisible();
  });

  test("[CLI Agent Orchestrator] approving a slot grants the permission", async ({
    page,
  }) => {
    const picker = await surfacePicker(page);

    // First button is a time slot -> resolve({chosen_time,...}); the run resumes
    // and the picker unmounts. The agent's confirmation is the record.
    await picker.getByRole("button").first().click();
    await expect(picker).toBeHidden({ timeout: 30_000 });

    await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
      /granted/i,
      { timeout: 30_000 },
    );
  });

  test("[CLI Agent Orchestrator] cancelling the picker denies the permission", async ({
    page,
  }) => {
    const picker = await surfacePicker(page);

    // Cancel routes through resolve({cancelled:true}) at status "resolved" — the
    // regression shape. It must resolve to a denial, not an approval.
    await picker.getByTestId("interrupt-cancel").click();
    await expect(picker).toBeHidden({ timeout: 30_000 });

    const reply = CopilotSelectors.assistantMessages(page).last();
    await expect(reply).toContainText(/denied/i, { timeout: 30_000 });
    await expect(reply).not.toContainText(/granted/i);
  });
});
