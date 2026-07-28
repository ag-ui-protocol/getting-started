import { expect, test } from "../../test-isolation-helper";
import { sendAndAwaitResponse } from "../../utils/copilot-actions";

test("[OpenAI Agents Python] Subagents records all specialist delegations", async ({
  page,
}) => {
  test.slow();
  await page.goto("/openai-agents-python/feature/subagents");

  await sendAndAwaitResponse(
    page,
    "Write a short article about the history of AI",
  );

  // Scope to the delegation-log entries container (the div immediately after
  // the "Delegation log" heading), NOT the whole sidebar — the sidebar also
  // statically renders the "Supervisor's team" chips labelled Researcher/Writer/
  // Critic, which would make these assertions pass even if no delegation ran.
  const log = page
    .getByText("Delegation log")
    .locator("xpath=following-sibling::div[1]");
  await expect(log.getByText("Researcher").last()).toBeVisible();
  await expect(log.getByText("Writer").last()).toBeVisible();
  await expect(log.getByText("Critic").last()).toBeVisible();
  await expect(log.getByText("complete")).toHaveCount(3);
});
