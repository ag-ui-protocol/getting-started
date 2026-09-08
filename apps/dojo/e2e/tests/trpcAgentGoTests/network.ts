import type { Page } from "@playwright/test";

export async function blockExternalNetwork(page: Page) {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    const isLocalhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (isLocalhost && !url.pathname.startsWith("/ingest")) {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
}
