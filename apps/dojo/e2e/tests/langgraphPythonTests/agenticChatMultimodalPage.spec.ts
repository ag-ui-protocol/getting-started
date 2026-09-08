import { test, expect } from "../../event-trace-test";
import * as path from "path";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { agenticChatMultimodalPageEventTrace } from "./agenticChatMultimodalPage.event-trace";

const TEST_IMAGE = path.join(
  import.meta.dirname,
  "../../fixtures/test-image.png",
);

test.describe("[Integration] LangGraph Python - Agentic Chat Multimodal", () => {
  test("should upload an image and receive a description", async ({
    page,
    eventTrace,
  }) => {
    await page.goto("/langgraph/feature/agentic_chat_multimodal");
    await openChat(page);

    // Upload a test image — v2 CopilotChat attaches files silently
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_IMAGE);

    // Send a message asking about the image
    await sendChatMessage(page, "Tell me what do you see in this image");
    await awaitLLMResponseDone(page);

    // Verify the agent responded about the image
    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText(/image|visual|content/i, {
      timeout: 10000,
    });
    await eventTrace.expectJourney(
      agenticChatMultimodalPageEventTrace.uploadAnImageAndReceiveADescription,
    );
  });
});
