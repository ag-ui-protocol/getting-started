import { expect, test } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";

test("[ADK JavaScript] Backend Tool Rendering displays a weather card", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, "/adk-js/feature/backend_tool_rendering");

  const suggestion = page.getByRole("button", {
    name: "Weather in San Francisco",
  });
  await expect(suggestion).toBeVisible();
  await suggestion.click();

  await expect(page.getByTestId("weather-card")).toBeVisible();
  await expect(page.getByText(/San Francisco/i).first()).toBeVisible();
});
