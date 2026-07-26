import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";

// The Dojo building block where the frontend renders from the agent's *evolving
// state* rather than per tool call. Every other integration fills it with a plan
// an LLM invented — the shared page's own suggestions are "a plan to go to mars
// in 5 steps". CAO doesn't invent one: each step is a real fleet record kind
// (launch / handoff / file_mod / handoff / completion), so these assertions are
// on the fleet's actual lifecycle, not on generated prose.
const PROMPT = "Show me what the fleet is working on.";

async function startRun(page: import("@playwright/test").Page) {
  await page.goto("/cli-agent-orchestrator/feature/agentic_generative_ui");
  await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();
  await CopilotSelectors.chatTextarea(page).fill(PROMPT);
  await CopilotSelectors.sendButton(page).click();

  const progress = page.getByTestId("task-progress");
  await expect(progress).toBeVisible({ timeout: 30_000 });
  return progress;
}

test.describe("Agentic Generative UI Feature", () => {
  test("[CLI Agent Orchestrator] renders the fleet lifecycle as a step list", async ({
    page,
  }) => {
    const progress = await startRun(page);

    const steps = progress.getByTestId("task-step-text");
    await expect(steps.first()).toBeVisible();
    expect(await steps.count()).toBeGreaterThan(0);

    // Real CAO record primitives, not an invented plan. If someone later swaps
    // in generated prose the differentiator is silently lost, so assert it.
    await expect(progress).toContainText(/Launching code_supervisor/i);
    await expect(progress).toContainText(/developer editing/i);
    await expect(progress).toContainText(/Retiring the developer terminal/i);
  });

  test("[CLI Agent Orchestrator] advances every step to completed", async ({
    page,
  }) => {
    const progress = await startRun(page);

    const total = await progress.getByTestId("task-step-text").count();
    expect(total).toBeGreaterThan(0);

    // The header renders "<completed>/<total> Complete" — theme-independent, so
    // it is the stable signal that the run drove the state all the way through.
    await expect(progress).toContainText(
      new RegExp(`${total}\\s*/\\s*${total}\\s*Complete`),
      { timeout: 30_000 },
    );
  });
});
