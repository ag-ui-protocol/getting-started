import { test, expect } from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/serverStarterAllFeaturesPages/PredictiveStateUpdatesPage";

// The dojo predictive flow can run multiple write -> confirm rounds. The .NET sample
// drives the human-in-the-loop modal by injecting a confirm_changes tool call after
// write_document_local (mirroring crewai). A single write -> approve / write -> reject
// round is asserted here; the multi-round continuation has a CopilotKit modal-lifecycle
// quirk (the second-round modal renders but stays non-interactive) that is unrelated to
// the AG-UI wire protocol.
test.describe("Predictive Status Updates Feature", () => {
  test("[AG-UI .NET SDK] should interact with agent and approve asked changes", async ({
    page,
  }) => {
    const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

    await page.goto("/ag-ui-dotnet/feature/predictive_state_updates");

    await predictiveStateUpdates.openChat();
    await predictiveStateUpdates.sendMessage(
      "Give me a story for a dragon called Atlantis in document",
    );

    await predictiveStateUpdates.getPredictiveResponse();
    await predictiveStateUpdates.getUserApproval();
    await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();
    const dragonName =
      await predictiveStateUpdates.verifyAgentResponse("Atlantis");
    expect(dragonName).not.toBeNull();
  });

  test("[AG-UI .NET SDK] should interact with agent and reject asked changes", async ({
    page,
  }) => {
    const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

    await page.goto("/ag-ui-dotnet/feature/predictive_state_updates");

    await predictiveStateUpdates.openChat();
    await predictiveStateUpdates.sendMessage(
      "Give me a story for a dragon called Atlantis in document",
    );

    await predictiveStateUpdates.getPredictiveResponse();
    await predictiveStateUpdates.getUserRejection();
    await expect(predictiveStateUpdates.rejectedChangesResponse).toBeVisible();
  });
});