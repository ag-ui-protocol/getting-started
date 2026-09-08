import { test, expect } from "../../test-isolation-helper";
import * as path from "path";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { blockExternalNetwork } from "./network";

const TEST_IMAGE = path.join(
  import.meta.dirname,
  "../../fixtures/test-image.png",
);

type LLMockRequest = {
  body?: {
    messages?: Array<{
      role?: string;
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
            image_url?: { url?: string };
          }>;
    }>;
  };
};

test.beforeEach(async ({ page }) => blockExternalNetwork(page));

test("[tRPC-Agent-Go] Multimodal chat forwards an image to the model", async ({
  page,
}) => {
  await page.goto("/trpc-agent-go/feature/agentic_chat_multimodal");
  await openChat(page);

  await page.locator('input[type="file"]').setInputFiles(TEST_IMAGE);
  await sendChatMessage(page, "Tell me what do you see in this image");
  await awaitLLMResponseDone(page);

  const journalResponse = await fetch(
    "http://localhost:5555/v1/_requests?limit=100",
  );
  expect(journalResponse.ok).toBe(true);
  const requests = (await journalResponse.json()) as LLMockRequest[];
  const multimodalRequest = [...requests]
    .reverse()
    .find((entry) =>
      entry.body?.messages?.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === "text" &&
              part.text?.includes("what do you see in this image"),
          ),
      ),
    );
  expect(multimodalRequest).toBeDefined();

  const userMessage = multimodalRequest?.body?.messages?.find(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image_url"),
  );
  expect(userMessage?.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "image_url",
        image_url: expect.objectContaining({
          url: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      }),
    ]),
  );

  await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
    /image|visual|content/i,
  );
});
