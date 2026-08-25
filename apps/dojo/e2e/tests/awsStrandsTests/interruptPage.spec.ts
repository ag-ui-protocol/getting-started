import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import {
  sendChatMessage,
  awaitResponseAfterAction,
} from "../../utils/copilot-actions";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";
import { captureRuntimeSSE } from "../../utils/runtime-sse";

// Native interrupt for AWS Strands (Python). The demo's `schedule_meeting` is a
// backend tool that pauses ITSELF: it calls the tool context's `interrupt()`,
// which halts the Strands agent loop before the tool returns. The run finishes
// with `RUN_FINISHED.outcome = { type: "interrupt" }`, the dojo's shared
// interrupt page renders its time picker, and resuming hands the user's choice
// back to that same `interrupt()` call so the tool body carries on.
//
// The chosen time is asserted rather than just the picker disappearing: the card
// hides itself on click, so its absence is true whether or not anything resumed.
// The time the user clicked only exists in the tool's own result, so finding it
// there and in the agent's reply is what proves the round trip.
const INTEGRATION_ID = "aws-strands";
const PAGE_URL = `/${INTEGRATION_ID}/feature/interrupt`;
const BOOK_REQUEST =
  "Book an intro call with the sales team to discuss pricing.";

test.describe("Interrupt Feature", () => {
  test("[Strands] pauses the tool and offers the user a time", async ({
    page,
  }) => {
    await page.goto(PAGE_URL);
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    // Captured before sending: the run starts on the click.
    const ssePromise = captureRuntimeSSE(
      page,
      INTEGRATION_ID,
      "intro call with the sales team",
    );

    await sendChatMessage(page, BOOK_REQUEST);

    // The picker only mounts on a real pause, so its presence is the interrupt
    // signal, and the slots are what the user has to answer with.
    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker.getByRole("button").first()).toBeEnabled();

    // The tool has NOT returned: the paused run carries no tool result at all,
    // and it ends on the interrupt outcome rather than a plain finish. Asserted
    // on the wire because the chat cannot show this: no assistant text is
    // expected at a pause either way, so a DOM check would pass unconditionally.
    const sse = await ssePromise;
    expect(
      sse.match(/"type":"TOOL_CALL_RESULT"/g),
      "a run paused inside the tool must carry no tool result",
    ).toBeNull();
    expect(
      sse,
      "the paused run must finish on the interrupt outcome",
    ).toContain('"type":"interrupt"');

    // Answered rather than abandoned: a suspended tool left open holds the
    // agent's thread waiting on a resume that never arrives.
    await awaitResponseAfterAction(page, () =>
      picker.getByTestId("interrupt-cancel").click(),
    );
  });

  test("[Strands] resuming carries the chosen time into the tool", async ({
    page,
  }) => {
    await page.goto(PAGE_URL);
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await sendChatMessage(page, BOOK_REQUEST);

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    // The label the user is about to click. Read off the button rather than
    // recomputed, since the page generates its slots relative to now.
    const slot = picker.getByRole("button").first();
    const chosen = ((await slot.textContent()) ?? "").trim();
    expect(chosen, "the picker must offer a labelled slot").not.toBe("");

    const ssePromise = captureRuntimeSSE(
      page,
      INTEGRATION_ID,
      "intro call with the sales team",
    );
    await slot.click();

    // The resumed run reaches the tool BODY, which composes its result out of
    // the label that came back. Finding that label in the tool result is what
    // distinguishes a real resume from a run that merely restarted.
    const sse = await ssePromise;
    expect(
      sse,
      "the resumed tool must report the time the user picked",
    ).toContain(`Meeting scheduled for ${chosen}`);

    // And the user sees it: the agent's confirmation names the same slot.
    await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
      chosen,
      { timeout: 30_000 },
    );
  });

  test("[Strands] cancelling leaves nothing scheduled", async ({ page }) => {
    await page.goto(PAGE_URL);
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await sendChatMessage(page, BOOK_REQUEST);

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    await awaitResponseAfterAction(page, () =>
      picker.getByTestId("interrupt-cancel").click(),
    );

    // The tool takes the cancel path and reports it, so the agent says nothing
    // was scheduled. The negative matters as much as the positive: a cancel that
    // silently resolved would still produce a confirmation.
    const reply = CopilotSelectors.assistantMessages(page).last();
    await expect(reply).toContainText(/did not schedule|left your calendar/i, {
      timeout: 30_000,
    });
    await expect(reply).not.toContainText(/scheduled for/i);
  });
});
