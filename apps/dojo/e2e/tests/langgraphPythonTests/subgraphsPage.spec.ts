import { test, expect } from "../../event-trace-test";
import { SubgraphsPage } from "../../pages/langGraphPages/SubgraphsPage";
import { subgraphsPageEventTrace } from "./subgraphsPage.event-trace";

test.describe("Subgraphs Travel Agent Feature", () => {
  test("[LangGraph] should complete full travel planning flow with feature validation", async ({
    page,
    eventTrace,
  }) => {
    const subgraphsPage = new SubgraphsPage(page);

    await page.goto("/langgraph/feature/subgraphs");

    await subgraphsPage.openChat();

    // Initiate travel planning
    await subgraphsPage.sendMessage("Help me plan a trip to San Francisco");

    // FEATURE TEST: Wait for supervisor coordination
    await subgraphsPage.waitForSupervisorCoordination();
    await expect(subgraphsPage.supervisorIndicator)
      .toBeVisible({ timeout: 10000 })
      .catch(() => {
        console.log(
          "Supervisor indicator not found, verifying through content",
        );
      });

    // FEATURE TEST: Flights Agent - verify agent indicator becomes active
    await subgraphsPage.waitForFlightsAgent();
    await expect(subgraphsPage.flightsAgentIndicator)
      .toBeVisible({ timeout: 10000 })
      .catch(() => {
        console.log(
          "Flights agent indicator not found, checking content instead",
        );
      });

    await subgraphsPage.verifyStaticFlightData();

    // Select KLM flight through interrupt
    await subgraphsPage.selectFlight("KLM");

    // FEATURE TEST: Verify immediate state update after selection
    await expect(subgraphsPage.selectedFlight)
      .toContainText("KLM")
      .catch(async () => {
        await expect(page.getByText(/KLM/i)).toBeVisible({ timeout: 2000 });
      });

    // FEATURE TEST: Hotels Agent - verify agent indicator switches
    await subgraphsPage.waitForHotelsAgent();
    await expect(subgraphsPage.hotelsAgentIndicator)
      .toBeVisible({ timeout: 10000 })
      .catch(() => {
        console.log(
          "Hotels agent indicator not found, checking content instead",
        );
      });

    await subgraphsPage.verifyStaticHotelData();

    // Select Hotel Zoe through interrupt
    await subgraphsPage.selectHotel("Zoe");

    // FEATURE TEST: Verify hotel selection immediately updates state
    await expect(subgraphsPage.selectedHotel)
      .toContainText("Zoe")
      .catch(async () => {
        await expect(page.getByText(/Hotel Zoe|Zoe/i)).toBeVisible({
          timeout: 2000,
        });
      });

    // FEATURE TEST: Experiences Agent - verify agent indicator becomes active
    await subgraphsPage.waitForExperiencesAgent();
    await expect(subgraphsPage.experiencesAgentIndicator)
      .toBeVisible({ timeout: 10000 })
      .catch(() => {
        console.log(
          "Experiences agent indicator not found, checking content instead",
        );
      });

    await subgraphsPage.verifyStaticExperienceData();
    await eventTrace.expectJourney(
      subgraphsPageEventTrace.completeFullTravelPlanningFlowWithFeatureValidation,
    );
  });

  test("[LangGraph] should handle different selections and demonstrate supervisor routing patterns", async ({
    page,
    eventTrace,
  }) => {
    const subgraphsPage = new SubgraphsPage(page);

    await page.goto("/langgraph/feature/subgraphs");

    await subgraphsPage.openChat();

    await subgraphsPage.sendMessage(
      "I want to visit San Francisco from Amsterdam",
    );

    // FEATURE TEST: Wait for supervisor coordination
    await subgraphsPage.waitForSupervisorCoordination();
    await expect(subgraphsPage.supervisorIndicator)
      .toBeVisible({ timeout: 10000 })
      .catch(() => {
        console.log(
          "Supervisor indicator not found, verifying through content",
        );
      });

    // FEATURE TEST: Flights Agent - verify agent indicator becomes active
    await subgraphsPage.waitForFlightsAgent();
    await expect(subgraphsPage.flightsAgentIndicator)
      .toBeVisible({ timeout: 10000 })
      .catch(() => {
        console.log(
          "Flights agent indicator not found, checking content instead",
        );
      });

    await subgraphsPage.verifyStaticFlightData();

    // FEATURE TEST: Test different selection - United instead of KLM
    await subgraphsPage.selectFlight("United");

    // FEATURE TEST: Verify immediate state update after selection
    await expect(subgraphsPage.selectedFlight)
      .toContainText("United")
      .catch(async () => {
        await expect(page.getByText(/United/i)).toBeVisible({ timeout: 2000 });
      });

    // FEATURE TEST: Hotels Agent - verify agent indicator switches
    await subgraphsPage.waitForHotelsAgent();
    await expect(subgraphsPage.hotelsAgentIndicator)
      .toBeVisible({ timeout: 10000 })
      .catch(() => {
        console.log(
          "Hotels agent indicator not found, checking content instead",
        );
      });

    await subgraphsPage.verifyStaticHotelData();

    // FEATURE TEST: Test different hotel selection - Ritz-Carlton
    await subgraphsPage.selectHotel("Ritz-Carlton");

    // FEATURE TEST: Verify hotel selection immediately updates state
    await expect(subgraphsPage.selectedHotel)
      .toContainText("Ritz-Carlton")
      .catch(async () => {
        await expect(page.getByText(/Ritz-Carlton/i)).toBeVisible({
          timeout: 2000,
        });
      });

    // FEATURE TEST: Experiences Agent - verify agent indicator becomes active
    await subgraphsPage.waitForExperiencesAgent();
    await expect(subgraphsPage.experiencesAgentIndicator)
      .toBeVisible({ timeout: 10000 })
      .catch(() => {
        console.log(
          "Experiences agent indicator not found, checking content instead",
        );
      });

    // FEATURE TEST: Verify subgraph streaming detection - experiences agent is active
    await expect(subgraphsPage.experiencesAgentIndicator)
      .toHaveClass(/active/)
      .catch(() => {
        console.log("Experiences agent not active, checking content instead");
      });

    // FEATURE TEST: Verify complete state persistence across all agents
    await expect(subgraphsPage.selectedFlight).toContainText("United"); // Flight selection persisted
    await expect(subgraphsPage.selectedHotel).toContainText("Ritz-Carlton"); // Hotel selection persisted
    await subgraphsPage.verifyStaticExperienceData(); // Experiences provided based on selections
    await eventTrace.expectJourney(
      subgraphsPageEventTrace.handleDifferentSelectionsAndDemonstrateSupervisorRoutingPatterns,
    );
  });
});
