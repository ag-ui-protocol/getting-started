import { test, expect } from "../../test-isolation-helper";
import * as path from "path";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

const TEST_IMAGE = path.join(
  import.meta.dirname,
  "../../fixtures/test-image.png",
);

// The attached image is converted to LiteLLM's image_url shape by the bridge
// before the CrewAI flow forwards it to a vision model.
test.describe("[Integration] CrewAI - Agentic Chat Multimodal", () => {
  test("should upload an image and receive a description", async ({ page }) => {
    await page.goto("/crewai/feature/agentic_chat_multimodal");
    await openChat(page);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_IMAGE);

    await sendChatMessage(page, "Tell me what do you see in this image");
    await awaitLLMResponseDone(page);

    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText(
      /image|visual|content|see|picture/i,
      {
        timeout: 10000,
      },
    );
  });
});
