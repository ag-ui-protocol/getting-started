import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";

// Native interrupt (suspend/resume) for CrewAI. The flow's `@human_feedback`
// method pauses via the bridge's feedback provider, the bridge ends the run with
// an AG-UI interrupt (`RUN_FINISHED.outcome` + the legacy `on_interrupt` CUSTOM
// event), CopilotKit v2 `useInterrupt` renders the picker, and resolving it
// resumes through `Flow.from_pending` + `resume_async`.
//
// The backend pause/resume contract (interrupt mapping, resume decode, event
// balance, capability gating) is covered by the bridge unit suite
// (integrations/crew-ai/python/tests/test_interrupts.py) and a live real-LLM
// run; here we exercise the real end-to-end UI: the pause surfaces the picker,
// and resolving it dismisses the picker (advancing the run).
test.describe("Interrupt (Suspend/Resume) Feature", () => {
  test("[CrewAI] pauses the flow and surfaces the interrupt picker", async ({
    page,
  }) => {
    await page.goto("/crewai/feature/interrupt");
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    // The flow pauses before answering, so there is no assistant text yet: wait
    // on the picker rather than an assistant message.
    await CopilotSelectors.chatTextarea(page).fill(
      "Book an intro call with the sales team to discuss pricing.",
    );
    await CopilotSelectors.sendButton(page).click();

    // The picker renders from the paused method's output and only mounts on a
    // real pause (driven by the interrupt), so its presence plus selectable
    // slots is the deterministic interrupt signal.
    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker.getByRole("button").first()).toBeVisible();
  });

  test("[CrewAI] resolving the picker advances the run", async ({ page }) => {
    await page.goto("/crewai/feature/interrupt");
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await CopilotSelectors.chatTextarea(page).fill(
      "Book an intro call with the sales team to discuss pricing.",
    );
    await CopilotSelectors.sendButton(page).click();

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    // Pick the first slot -> resolve() sends RunAgentInput.resume[], the bridge
    // resumes the pending flow, and the picker render unmounts (it renders null
    // once a slot is chosen). The picker being dismissed is the deterministic
    // signal that the interrupt was addressed; the picker UI is ephemeral by
    // design and the agent's confirmation text follows in chat.
    await picker.getByRole("button").first().click();
    await expect(picker).toBeHidden({ timeout: 30_000 });
  });
});
