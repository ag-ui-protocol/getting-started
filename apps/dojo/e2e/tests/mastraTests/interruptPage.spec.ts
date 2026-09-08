import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";

// Native interrupt (suspend/resume) for a REMOTE Mastra agent (OSS-380). Same
// flow as the local case (the agent's suspend-backed `schedule_meeting` tool
// suspends, the @ag-ui/mastra bridge emits `on_interrupt` + the standard
// RUN_FINISHED.outcome, CopilotKit v2 `useInterrupt` renders the picker), but
// resume round-trips over @mastra/client-js' `resumeStream` instead of the
// local agent resume stream.
//
// The backend remote-resume contract (resumeStream, runId round-trip,
// RunAgentInput.resume decode) is covered by the bridge unit suite
// (integrations/mastra/.../interrupt-bridge.test.ts) and a live real-LLM run;
// here we exercise the real end-to-end UI: suspend surfaces the picker, and
// resolving it dismisses the picker (advancing the run).
test.describe("Interrupt (Suspend/Resume) Feature", () => {
  test("[Mastra] suspends a tool and surfaces the interrupt picker", async ({
    page,
  }) => {
    await page.goto("/mastra/feature/interrupt");
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    // Sending this triggers schedule_meeting, which suspends — so there is no
    // assistant text yet; wait on the picker rather than an assistant message.
    await CopilotSelectors.chatTextarea(page).fill(
      "Book an intro call with the sales team to discuss pricing.",
    );
    await CopilotSelectors.sendButton(page).click();

    // The interrupt picker renders from the tool's suspend payload, with the
    // generated time slots. The picker only mounts on a real suspend (driven by
    // the on_interrupt event), so its presence + selectable slots is the
    // deterministic interrupt signal. We don't assert the topic text: it comes
    // from the model's tool-call args (`topic`), which the model doesn't fill
    // deterministically (it often falls back to the generic "a call" label).
    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker.getByRole("button").first()).toBeVisible();
  });

  test("[Mastra] resolving the picker advances the run", async ({ page }) => {
    await page.goto("/mastra/feature/interrupt");
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await CopilotSelectors.chatTextarea(page).fill(
      "Book an intro call with the sales team to discuss pricing.",
    );
    await CopilotSelectors.sendButton(page).click();

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    // Pick the first slot -> resolve() resumes the remote run and the picker
    // render unmounts (it renders null once a slot is chosen). The picker being
    // dismissed is the deterministic signal that the interrupt was addressed;
    // the picker UI is ephemeral by design and the agent's text becomes the
    // confirmation. The backend resume round-trip is asserted by the bridge
    // unit suite and a live real-LLM run — not here — because under aimock the
    // resumed run has a residual streaming race.
    await picker.getByRole("button").first().click();
    await expect(picker).toBeHidden({ timeout: 30_000 });
  });
});
