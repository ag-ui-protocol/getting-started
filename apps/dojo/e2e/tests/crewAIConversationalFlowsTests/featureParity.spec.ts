import { expect, type Locator } from "@playwright/test";
import * as path from "path";
import { test } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { SharedStatePage } from "../../featurePages/SharedStatePage";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";
import { V1AgenticChatPage } from "../../featurePages/V1AgenticChatPage";
import { AgenticGenUIPage } from "../../pages/crewAIPages/AgenticUIGenPage";
import { HumanInLoopPage } from "../../pages/crewAIPages/HumanInLoopPage";
import { PredictiveStateUpdatesPage } from "../../pages/crewAIPages/PredictiveStateUpdatesPage";
import {
  awaitLLMResponseDone,
  openChat,
  sendChatMessage,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

const integrationId = "crewai-conversational-flows";
const testImage = path.join(
  import.meta.dirname,
  "../../fixtures/test-image.png",
);
const parityFeatures = [
  "agentic_chat",
  "agentic_chat_reasoning",
  "agentic_chat_multimodal",
  "v1_agentic_chat",
  "backend_tool_rendering",
  "interrupt",
  "human_in_the_loop",
  "agentic_generative_ui",
  "predictive_state_updates",
  "shared_state",
  "tool_based_generative_ui",
  "a2ui_dynamic_schema",
  "a2ui_recovery",
  "a2ui_fixed_schema",
] as const;

async function expectRenderedAfter(
  earlier: Locator,
  later: Locator,
): Promise<void> {
  await expect(earlier).toBeAttached();
  await expect(later).toBeAttached();

  const laterHandle = await later.elementHandle();
  expect(laterHandle).not.toBeNull();
  const followsInDocument = await earlier.evaluate(
    (earlierElement, laterElement) =>
      Boolean(
        earlierElement.compareDocumentPosition(laterElement as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    laterHandle,
  );
  expect(followsInDocument).toBe(true);

  const [earlierBox, laterBox] = await Promise.all([
    earlier.boundingBox(),
    later.boundingBox(),
  ]);
  if (earlierBox && laterBox) {
    expect(earlierBox.y).toBeLessThan(laterBox.y);
  }
}

test.describe("CrewAI Conversational Flows feature parity", () => {
  test.describe.configure({ mode: "serial" });

  for (const feature of parityFeatures) {
    test(`${feature} has a dedicated dojo cell`, async ({ page }) => {
      const response = await page.goto(`/${integrationId}/feature/${feature}`);

      expect(response?.ok()).toBe(true);
      await expect(page.locator("body")).not.toContainText(
        "Integration not found",
      );
    });
  }

  test("public turns retain conversation history", async ({ page }) => {
    await page.goto(`/${integrationId}/feature/agentic_chat`);
    const chat = new AgenticChatPage(page);
    await chat.openChat();

    await chat.sendMessage("My favorite fruit is Mango");
    await chat.assertAgentReplyVisible(/Mango/i);
    await chat.sendMessage("Can you remind me what my favorite fruit is?");

    await chat.assertAgentReplyVisible(/Mango/i);
    await expectRenderedAfter(
      CopilotSelectors.userMessages(page).last(),
      CopilotSelectors.assistantMessages(page).last(),
    );
  });

  test("reasoning renders between the user prompt and assistant answer", async ({
    page,
  }) => {
    await page.goto(`/${integrationId}/feature/agentic_chat_reasoning`);
    await openChat(page);

    await sendChatMessage(page, "What is the best car to buy?");
    await awaitLLMResponseDone(page);

    const userMessage = CopilotSelectors.userMessages(page).last();
    const reasoningIndicator = page.getByText(/Thought for/i).last();
    const answer = CopilotSelectors.assistantMessages(page)
      .last()
      .getByText(/Based on my analysis/i);
    await expect(reasoningIndicator).toBeVisible({ timeout: 10000 });
    await expect(answer).toBeVisible({ timeout: 10000 });

    const [userBox, reasoningBox, answerBox] = await Promise.all([
      userMessage.boundingBox(),
      reasoningIndicator.boundingBox(),
      answer.boundingBox(),
    ]);
    expect(userBox).not.toBeNull();
    expect(reasoningBox).not.toBeNull();
    expect(answerBox).not.toBeNull();
    expect(userBox!.y).toBeLessThan(reasoningBox!.y);
    expect(reasoningBox!.y).toBeLessThan(answerBox!.y);
  });

  test("multimodal turns preserve the uploaded image", async ({ page }) => {
    await page.goto(`/${integrationId}/feature/agentic_chat_multimodal`);
    await openChat(page);
    await page.locator('input[type="file"]').setInputFiles(testImage);

    await sendChatMessage(page, "Tell me what do you see in this image");
    await awaitLLMResponseDone(page);

    await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
      /image|visual|content|see|picture/i,
    );
    await expectRenderedAfter(
      CopilotSelectors.userMessages(page).last(),
      CopilotSelectors.assistantMessages(page).last(),
    );
  });

  test("v1 chat renders the assistant after its user turn", async ({
    page,
  }) => {
    await page.goto(`/${integrationId}/feature/v1_agentic_chat`);
    const chat = new V1AgenticChatPage(page);

    await chat.sendMessage("Hi");
    await chat.assertAgentReplyVisible(/Hello|Hi|hey|help|assist/i);

    await expectRenderedAfter(
      chat.userMessages.last(),
      chat.assistantMessages.last(),
    );
  });

  test("backend tool cards render after the triggering user turn", async ({
    page,
  }) => {
    await page.goto(`/${integrationId}/feature/backend_tool_rendering`);
    await page
      .getByRole("button", { name: "Weather in San Francisco" })
      .click();

    const weatherCard = page.getByTestId("weather-card").first();
    await expect(weatherCard).toBeVisible({ timeout: 30_000 });
    await expectRenderedAfter(
      CopilotSelectors.userMessages(page).last(),
      weatherCard,
    );
  });

  test("native interrupt UI renders after the triggering user turn", async ({
    page,
  }) => {
    await page.goto(`/${integrationId}/feature/interrupt`);
    await openChat(page);
    await sendChatMessage(
      page,
      "Book an intro call with the sales team to discuss pricing.",
    );

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expectRenderedAfter(
      CopilotSelectors.userMessages(page).last(),
      picker,
    );
  });

  test("frontend HITL confirmation continues the public turn", async ({
    page,
  }) => {
    await page.goto(`/${integrationId}/feature/human_in_the_loop`);
    const hitl = new HumanInLoopPage(page);
    await hitl.openChat();
    await hitl.sendMessage(
      "Give me a plan to make brownies, there should be only one step with eggs and one step with oven, this is a strict requirement so adhere",
    );
    await expectRenderedAfter(hitl.userMessage.last(), hitl.plan);
    await hitl.uncheckItem("eggs");
    await hitl.performStepsAndAwait();

    await hitl.assertAgentReplyVisible(/Done|completed/i);
  });

  test("agentic generative UI renders its task after the user turn", async ({
    page,
  }) => {
    await page.goto(`/${integrationId}/feature/agentic_generative_ui`);
    const generativeUI = new AgenticGenUIPage(page);
    await generativeUI.openChat();

    await generativeUI.sendMessage("Go to Mars");
    await expect(generativeUI.agentPlannerContainer).toBeVisible({
      timeout: 30_000,
    });
    await expectRenderedAfter(
      generativeUI.userMessage.last(),
      generativeUI.agentPlannerContainer,
    );
  });

  test("predictive state accepts a document change", async ({ page }) => {
    test.slow();
    await page.goto(`/${integrationId}/feature/predictive_state_updates`);
    const predictive = new PredictiveStateUpdatesPage(page);
    await predictive.openChat();
    await predictive.sendMessage(
      "Give me a story for a dragon called Atlantis in document",
    );
    await predictive.getPredictiveResponse();
    await predictive.getUserApproval();

    expect(await predictive.verifyAgentResponse("Atlantis")).not.toBeNull();
    await expectRenderedAfter(
      predictive.userMessage.last(),
      predictive.confirmedChangesResponse,
    );
  });

  test("shared-state replies render after the user turn", async ({ page }) => {
    await page.goto(`/${integrationId}/feature/shared_state`);
    const sharedState = new SharedStatePage(page);
    await sharedState.openChat();

    await sharedState.sendMessage("Give me all the ingredients");
    await expect(sharedState.agentMessage.last()).toBeVisible();
    await expectRenderedAfter(
      sharedState.userMessage.last(),
      sharedState.agentMessage.last(),
    );
  });

  test("tool-based generative UI renders its card after the user turn", async ({
    page,
  }) => {
    await page.goto(`/${integrationId}/feature/tool_based_generative_ui`);
    const generativeUI = new ToolBaseGenUIPage(page);

    await generativeUI.generateHaiku('Generate Haiku for "I will always win"');
    await generativeUI.checkGeneratedHaiku();
    await expectRenderedAfter(
      CopilotSelectors.userMessages(page).last(),
      generativeUI.haikuBlock.last(),
    );
  });

  for (const { feature, prompt, surfaceId } of [
    {
      feature: "a2ui_fixed_schema",
      prompt: "Search for hotels in downtown Manhattan for next weekend.",
      surfaceId: "hotel-search-results",
    },
    {
      feature: "a2ui_dynamic_schema",
      prompt:
        "Compare three boutique hotels - The Ritz, Holiday Inn, and Boutique Loft - with location, nightly price, and rating.",
      surfaceId: "hotel-comparison",
    },
    {
      feature: "a2ui_recovery",
      prompt: "Compare 3 luxury hotels with ratings and prices.",
      surfaceId: "hotel-comparison",
    },
  ] as const) {
    test(`${feature} renders its surface after the user turn`, async ({
      page,
    }) => {
      await page.goto(`/${integrationId}/feature/${feature}`);
      const a2ui = new A2UIPage(page);
      await a2ui.openChat();

      await a2ui.sendMessage(prompt);
      await a2ui.assertSurfaceWithIdVisible(surfaceId);
      await expectRenderedAfter(
        a2ui.userMessages.last(),
        a2ui.visibleSurface(surfaceId),
      );
    });
  }
});
