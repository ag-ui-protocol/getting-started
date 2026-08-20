import type { Page } from "@playwright/test";
import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { sendChatMessage } from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

// A protocol RUN_ERROR being terminal for the client is a property of
// @copilotkit/react-core, not of this repo. It was NOT terminal in the versions
// this spec was originally skipped against; it is terminal on the version the
// dojo pins today. These assertions detect a regression in that behavior,
// including one introduced by a dependency bump.
const CHAT_SELECTOR = '[data-testid="copilot-chat"]';
const RUNNING_ATTRIBUTE = "data-copilot-running";
const SETTLE_TIMEOUT = 30_000;

/** Install a recorder for the running attribute's value history, plus the
 * single reducer the reader and the waiter both call, so the two can never
 * disagree about what counts as a transition. The reducer throws if the node it
 * observes is replaced, because a silently frozen history reads like a run that
 * never happened. */
async function trackRunningTransitions(page: Page): Promise<void> {
  const installed = await page.evaluate(
    ([selector, attribute]) => {
      const target = document.querySelector(selector);
      if (!target) return false;
      const w = window as unknown as {
        __runningOldValues?: (string | null)[];
        __runningObserver?: MutationObserver;
        __runningHistory?: () => string[];
      };
      // Re-installing without disconnecting would double-count every mutation.
      w.__runningObserver?.disconnect();
      w.__runningOldValues = [];
      w.__runningObserver = new MutationObserver((records) => {
        // One record per mutation. Recording oldValue and appending the live
        // value at read time reconstructs the history losslessly, whereas
        // reading the current value once per callback collapses batched changes.
        for (const record of records) w.__runningOldValues?.push(record.oldValue);
      });
      w.__runningObserver.observe(target, {
        attributes: true,
        attributeFilter: [attribute],
        attributeOldValue: true,
      });
      // Consecutive duplicates are collapsed, so a repeated write of the same
      // value is not mistaken for a state change.
      w.__runningHistory = () => {
        if (!target.isConnected) {
          throw new Error("observed chat node was replaced; history is stale");
        }
        const current =
          document.querySelector(selector)?.getAttribute(attribute) ?? null;
        const all = [...(w.__runningOldValues ?? []), current].map(
          (value) => value ?? "",
        );
        return all.filter((value, index) => value !== all[index - 1]);
      };
      return true;
    },
    [CHAT_SELECTOR, RUNNING_ATTRIBUTE] as const,
  );

  // Failing loudly here beats an opaque wait timeout later.
  expect(installed, `no element matched ${CHAT_SELECTOR}`).toBe(true);
}

async function readRunningHistory(page: Page): Promise<string[]> {
  const history = await page.evaluate(() => {
    const read = (window as unknown as { __runningHistory?: () => string[] })
      .__runningHistory;
    // A lost recorder must not read as "no transitions happened".
    return read ? read() : null;
  });
  expect(history, "running-history recorder is gone").not.toBeNull();
  return history as string[];
}

/** Wait for a run to start and settle, anchored to the history length captured
 * before the send, so a prior turn's transitions cannot satisfy this turn's
 * wait. A run that never starts at all times out here; the caller's
 * `toContain("true")` is what distinguishes "moved but never ran". */
async function awaitRunSettledSince(page: Page, mark: number): Promise<void> {
  await page.waitForFunction(
    (since) => {
      const history =
        (window as unknown as { __runningHistory?: () => string[] })
          .__runningHistory?.() ?? [];
      // Terminal: something moved past the mark and settled back to idle.
      return history.length > since && history[history.length - 1] === "false";
    },
    mark,
    { timeout: SETTLE_TIMEOUT },
  );
}

test("[CrewAI] Error flow surfaces a terminal RunErrorEvent", async ({
  page,
}) => {
  // Two full runs plus their waits sit close to the default per-test budget.
  test.slow();

  await page.goto("/crewai/feature/error_flow");

  // No openChat(): this page renders a bare CopilotChat with no toggle button,
  // so the helper would only burn its fallback timeout.
  const chat = new AgenticChatPage(page);
  await expect(chat.agentGreeting).toBeVisible();
  await expect(CopilotSelectors.chat(page)).toHaveAttribute(
    RUNNING_ATTRIBUTE,
    "false",
  );
  await trackRunningTransitions(page);

  const beforeFirstRun = (await readRunningHistory(page)).length;
  await sendChatMessage(page, "trigger error");
  await chat.assertUserMessageVisible("trigger error");
  await awaitRunSettledSince(page, beforeFirstRun);

  // The run must have actually started before it terminated: a permanently
  // idle client would also read "false" without ever entering a run.
  const firstHistory = await readRunningHistory(page);
  expect(firstHistory.slice(beforeFirstRun)).toContain("true");
  expect(firstHistory.at(-1)).toBe("false");

  // The backend message and code reach the client's error path intact.
  const banner = page.getByTestId("run-error");
  await expect(banner).toBeVisible({ timeout: SETTLE_TIMEOUT });
  await expect(banner).toHaveAttribute("data-run-error-seq", "1");
  // The banner cleared on this run's RUN_STARTED before the error repainted it.
  // Without this, dropping the clear handler would leave the spec green.
  await expect(banner).toHaveAttribute("data-run-error-clears", "1");
  await expect(page.getByTestId("run-error-code")).toHaveText(
    "AGUI_CREWAI_FLOW_ERROR_RUNTIMEERROR",
  );
  await expect(page.getByTestId("run-error-message")).toContainText(
    "CrewAI flow failed",
  );
  // The backend deliberately redacts the raised exception text; only the
  // category and correlation ids cross the wire.
  await expect(banner).not.toContainText("Intentional error");

  // The greeting is welcome-screen text, not an assistant message, so a failed
  // run must leave no assistant message at all.
  await expect(chat.agentMessage).toHaveCount(0);

  // Active-run bookkeeping is cleared: the next run starts, terminates, and
  // surfaces its OWN error. The banner clears on RUN_STARTED, so a bumped
  // sequence proves this is run 2's error rather than run 1's leftover.
  const beforeSecondRun = (await readRunningHistory(page)).length;
  await sendChatMessage(page, "trigger error again");
  await chat.assertUserMessageVisible("trigger error again");
  await awaitRunSettledSince(page, beforeSecondRun);

  const secondHistory = await readRunningHistory(page);
  expect(secondHistory.slice(beforeSecondRun)).toContain("true");
  expect(secondHistory.at(-1)).toBe("false");

  await expect(banner).toBeVisible({ timeout: SETTLE_TIMEOUT });
  await expect(banner).toHaveAttribute("data-run-error-seq", "2");
  // Cleared again on run 2's RUN_STARTED, so this banner is run 2's own error.
  await expect(banner).toHaveAttribute("data-run-error-clears", "2");
  await expect(page.getByTestId("run-error-code")).toHaveText(
    "AGUI_CREWAI_FLOW_ERROR_RUNTIMEERROR",
  );

  // Re-checked after both runs have terminated, so a late assistant message
  // from either run still fails.
  await expect(chat.agentMessage).toHaveCount(0);
});

test("[CrewAI] Error flow surfaces the error even when the runtime is slow to connect", async ({
  page,
}) => {
  test.slow();

  // Hold the runtime-info response so the page spends real time in the
  // pre-registration window. Before the demo gated on agent registration, the
  // banner and CopilotChat each held their own provisional agent here, and the
  // first run's error reached the chat's agent only.
  // The dojo runtime uses the SINGLE-endpoint transport: there is no `/info`
  // URL, the handshake is a POST to the runtime url with `{"method":"info"}`.
  // Delay only that one so the run requests are untouched.
  await page.route("**/api/copilotkit/**", async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      (request.postData() ?? "").includes('"method":"info"')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    await route.continue();
  });

  await page.goto("/crewai/feature/error_flow");

  const chat = new AgenticChatPage(page);
  await expect(chat.agentGreeting).toBeVisible({ timeout: SETTLE_TIMEOUT });
  await trackRunningTransitions(page);

  const beforeRun = (await readRunningHistory(page)).length;
  await sendChatMessage(page, "trigger error");
  await chat.assertUserMessageVisible("trigger error");
  await awaitRunSettledSince(page, beforeRun);

  const history = await readRunningHistory(page);
  expect(history.slice(beforeRun)).toContain("true");
  expect(history.at(-1)).toBe("false");

  // The first run's error must reach the banner, not just the chat's agent.
  const banner = page.getByTestId("run-error");
  await expect(banner).toBeVisible({ timeout: SETTLE_TIMEOUT });
  await expect(banner).toHaveAttribute("data-run-error-seq", "1");
  await expect(page.getByTestId("run-error-code")).toHaveText(
    "AGUI_CREWAI_FLOW_ERROR_RUNTIMEERROR",
  );
  await expect(chat.agentMessage).toHaveCount(0);
});
