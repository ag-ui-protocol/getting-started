import { expect, test } from "../../test-isolation-helper";

test("[OpenAI Agents Python] Backend Tool Rendering displays a weather card", async ({
  page,
}) => {
  await page.goto("/openai-agents-python/feature/backend_tool_rendering");

  await page.getByRole("button", { name: "Weather in San Francisco" }).click();

  await expect(page.getByTestId("weather-card").last()).toBeVisible();
  await expect(page.getByText("Humidity").last()).toBeVisible();
});
