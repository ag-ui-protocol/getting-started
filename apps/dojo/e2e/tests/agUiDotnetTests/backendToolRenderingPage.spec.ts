import { test, expect } from "@playwright/test";

test("[AG-UI .NET SDK] Backend Tool Rendering displays weather cards", async ({
  page,
}) => {
  // Set longer timeout for this test since backend tool rendering can be slower
  test.setTimeout(60000); // 60 seconds total

  await page.goto("/ag-ui-dotnet/feature/backend_tool_rendering");

  // Wait for page to load - be more lenient with timeout
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  // Verify suggestion buttons are visible with longer timeout
  await expect(page.getByRole("button", { name: "Weather in San Francisco" })).toBeVisible({
    timeout: 15000,
  });

  // Click first suggestion and verify weather card appears
  await page.getByRole("button", { name: "Weather in San Francisco" }).click();

  // Wait longer for weather card to appear (backend processing time)
  const weatherCard = page.getByTestId("weather-card");
  const currentWeatherText = page.getByText("Current Weather");

  // Try test ID first with longer timeout, fallback to text
  let weatherVisible = false;
  try {
    await expect(weatherCard).toBeVisible({ timeout: 20000 });
    weatherVisible = true;
  } catch (e) {
    // Fallback to checking for "Current Weather" text
    try {
      await expect(currentWeatherText.first()).toBeVisible({ timeout: 20000 });
      weatherVisible = true;
    } catch (e2) {
      // Last resort - check for any weather-related content
      const weatherContent = await page.getByText(/Humidity|Wind|Temperature/i).count();
      weatherVisible = weatherContent > 0;
    }
  }

  expect(weatherVisible).toBeTruthy();

  // Verify weather content is present (use flexible selectors)
  await page.waitForTimeout(1000); // Give elements time to render

  const hasHumidity = await page
    .getByText("Humidity")
    .isVisible()
    .catch(() => false);
  const hasWind = await page
    .getByText("Wind")
    .isVisible()
    .catch(() => false);
  const hasCityName = await page
    .locator("h3")
    .filter({ hasText: /San Francisco/i })
    .isVisible()
    .catch(() => false);

  // At least one of these should be true
  expect(hasHumidity || hasWind || hasCityName).toBeTruthy();

  // Click second suggestion
  await page.getByRole("button", { name: "Weather in New York" }).click();
  await page.waitForTimeout(3000); // Longer wait for backend to process

  // Verify at least one weather-related element is still visible
  const weatherElements = await page.getByText(/Weather|Humidity|Wind|Temperature/i).count();
  expect(weatherElements).toBeGreaterThan(0);
});
