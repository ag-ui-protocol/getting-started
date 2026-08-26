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

test.describe("[Integration] LlamaIndex - Agentic Chat Multimodal", () => {
  test("should upload an image and receive a description", async ({
    page,
  }) => {
    await page.goto("/llama-index/feature/agentic_chat_multimodal");
    await openChat(page);

    // Upload a test image — v2 CopilotChat attaches files silently
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_IMAGE);

    // Send a message asking about the image. The "llamaindex-mm-check"
    // token scopes the aimock predicate fixture to this suite so it never
    // intercepts other integrations' multimodal requests; the generic
    // "what do you see in this image" phrase keeps the fallback JSON
    // fixture matching when the image is stripped (no marker -> failure).
    await sendChatMessage(
      page,
      "llamaindex-mm-check: tell me what do you see in this image",
    );
    await awaitLLMResponseDone(page);

    // Verify the image actually reached the LLM request: the aimock predicate
    // fixture returns this marker ONLY when an image_url content part is
    // present. A canned prompt-text match (image silently stripped) responds
    // without the marker and this assertion fails.
    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText("multimodal-image-verified", {
      timeout: 10000,
    });
  });
});
