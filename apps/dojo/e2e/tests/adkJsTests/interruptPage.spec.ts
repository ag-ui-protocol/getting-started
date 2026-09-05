import { expect, test } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";

test("[ADK JavaScript] resolves a native request-input interrupt", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, "/adk-js/feature/interrupt");
  await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

  await CopilotSelectors.chatTextarea(page).fill(
    "Book an intro call with the sales team to discuss pricing.",
  );
  await CopilotSelectors.sendButton(page).click();

  const picker = page.getByTestId("interrupt-picker");
  await expect(picker).toBeVisible();
  await picker.getByRole("button").first().click();
  await expect(picker).toBeHidden();
  await expect(
    CopilotSelectors.assistantMessages(page).getByText(/scheduled/i),
  ).toBeVisible();
});
