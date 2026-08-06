import { test, expect } from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/serverStarterAllFeaturesPages/PredictiveStateUpdatesPage";
import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { blockExternalNetwork } from "./network";

test.beforeEach(async ({ page }) => blockExternalNetwork(page));

test("[tRPC-Agent-Go] Predictive state streams a document", async ({
  page,
}) => {
  const predictiveState = new PredictiveStateUpdatesPage(page);
  await page.goto("/trpc-agent-go/feature/predictive_state_updates");
  await predictiveState.openChat();

  await predictiveState.sendMessage(
    "Give me a story for a dragon called Atlantis in document",
  );
  await awaitLLMResponseDone(page);

  await expect(predictiveState.agentResponsePrompt).toContainText("Atlantis");
});
