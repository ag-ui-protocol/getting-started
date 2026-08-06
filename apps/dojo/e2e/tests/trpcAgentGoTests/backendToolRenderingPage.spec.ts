import { test, expect } from "../../test-isolation-helper";
import { blockExternalNetwork } from "./network";

test.beforeEach(async ({ page }) => blockExternalNetwork(page));

test("[tRPC-Agent-Go] Backend tool renders a weather card", async ({
  page,
}) => {
  await page.goto("/trpc-agent-go/feature/backend_tool_rendering");

  await page.getByRole("button", { name: "Weather in San Francisco" }).click();

  const weatherCard = page.getByTestId("weather-card");
  await expect(weatherCard).toBeVisible();
  await expect(weatherCard).toContainText("San Francisco");
  await expect(page.getByTestId("weather-humidity")).toContainText("65%");
  await expect(page.getByTestId("weather-wind")).toContainText("12 mph");
});
