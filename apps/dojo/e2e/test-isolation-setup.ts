import { chromium, FullConfig } from "@playwright/test";
import { setupLLMock } from "./aimock-setup";

async function globalSetup(config: FullConfig) {
  // Start the LLMock server before any tests run
  await setupLLMock();

  console.log("🧹 Setting up test isolation...");

  // Launch browser to clear any persistent state.
  // Playwright pins an exact browser build per release, so a cache populated by a
  // different Playwright version resolves to a missing executable here. Bare, that
  // surfaces as an opaque globalSetup stall rather than a failure, so translate it
  // into the command that actually fixes it.
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Executable doesn't exist")) {
      throw new Error(
        `Playwright browsers are not installed for this @playwright/test version.\n` +
          `Run this from apps/dojo/e2e, then re-run the suite:\n\n` +
          `  pnpm exec playwright install chromium chromium-headless-shell\n\n` +
          `Original error: ${message}`,
      );
    }
    throw error;
  }

  const context = await browser.newContext();

  // Clear all storage
  await context.clearCookies();
  await context.clearPermissions();

  // Try to clear cached data — requires navigating to a real page first
  // (about:blank doesn't allow localStorage access)
  const baseUrl = process.env.BASE_URL;
  if (baseUrl) {
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { timeout: 10_000 });
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        if (window.indexedDB) {
          indexedDB.deleteDatabase("test-db");
        }
      });
    } catch {
      // Page may not be ready yet — individual tests handle their own cleanup
    }
  }

  await browser.close();

  console.log("✅ Test isolation setup complete");
}

export default globalSetup;
