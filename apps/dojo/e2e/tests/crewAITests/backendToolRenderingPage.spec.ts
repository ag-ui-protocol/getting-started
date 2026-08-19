import { test, expect } from "../../test-isolation-helper";
import { awaitLLMResponseDone } from "../../utils/copilot-actions";

// The weather agent runs a real crew: the model calls the backend get_weather
// tool, the crew executes it server-side, and the bridge surfaces the call +
// result so the client renders a weather card. The crew's own agent loop makes
// two LLM calls (tool-call turn, then final-answer turn); both are mocked by the
// Weather-Assistant fixtures in aimock-setup.ts.
test("[CrewAI] Backend Tool Rendering displays weather cards", async ({
  page,
}) => {
  await page.goto("/crewai/feature/backend_tool_rendering");

  // Verify suggestion buttons are visible
  await expect(
    page.getByRole("button", { name: "Weather in San Francisco" }),
  ).toBeVisible({
    timeout: 5000,
  });

  // Click first suggestion and verify weather card appears
  await page.getByRole("button", { name: "Weather in San Francisco" }).click();

  // Wait for either test ID or fallback to "Current Weather" text
  const weatherCard = page.getByTestId("weather-card");
  const currentWeatherText = page.getByText("Current Weather");

  // Try test ID first, fallback to text
  try {
    await expect(weatherCard.first()).toBeVisible();
  } catch (e) {
    // Fallback to checking for "Current Weather" text
    await expect(currentWeatherText.first()).toBeVisible();
  }

  // Verify weather content is present (use flexible selectors)
  const hasHumidity = await page
    .getByText("Humidity")
    .first()
    .isVisible()
    .catch(() => false);
  const hasWind = await page
    .getByText("Wind")
    .first()
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
  await awaitLLMResponseDone(page);

  // Verify at least one weather-related element is still visible
  const weatherElements = await page
    .getByText(/Weather|Humidity|Wind|Temperature/i)
    .count();
  expect(weatherElements).toBeGreaterThan(0);
});
