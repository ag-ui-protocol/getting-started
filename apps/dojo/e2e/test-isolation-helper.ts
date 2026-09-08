import { test as base, Page } from "@playwright/test";
import { awaitLLMResponseDone } from "./utils/copilot-actions";

/**
 * Dump the current state of assistant messages on the page.
 * Called automatically on test failure so CI logs show what the LLM
 * actually produced (or didn't produce) instead of just "Element not found".
 */
async function dumpPageAIState(page: Page) {
  try {
    const state = await page.evaluate(() => {
      // Use data-testid selectors (work with both V1 and V2 CopilotChat)
      const assistantMsgs = Array.from(
        document.querySelectorAll('[data-testid="copilot-assistant-message"]'),
      );
      const userMsgs = Array.from(
        document.querySelectorAll('[data-testid="copilot-user-message"]'),
      );
      const chatContainer = document.querySelector(
        '[data-testid="copilot-chat"]',
      );
      const isRunning = chatContainer?.getAttribute("data-copilot-running");
      // Check for HITL confirm modals
      const confirmModals = Array.from(
        document.querySelectorAll("div.bg-white.rounded.shadow-lg"),
      );
      const confirmButtons = Array.from(
        document.querySelectorAll("button"),
      ).filter((b) => /confirm|reject|accept/i.test(b.textContent || ""));
      // Check for tiptap editor content
      const tiptapEditor = document.querySelector("div.tiptap.ProseMirror");
      return {
        assistantMessages: assistantMsgs.map((el, i) => ({
          index: i,
          text: el.textContent?.trim().slice(0, 200) || "(empty)",
        })),
        userMessages: userMsgs.map((el, i) => ({
          index: i,
          text: el.textContent?.trim().slice(0, 200) || "(empty)",
        })),
        url: window.location.href,
        copilotRunning: isRunning,
        chatContainerFound: chatContainer !== null,
        confirmModals: confirmModals.length,
        confirmModalTexts: confirmModals.map(
          (m) => m.textContent?.trim().slice(0, 100) || "(empty)",
        ),
        confirmButtons: confirmButtons.map((b) => ({
          text: b.textContent?.trim(),
          disabled: b.disabled,
        })),
        tiptapContent:
          tiptapEditor?.textContent?.trim().slice(0, 100) || "(none)",
      };
    });

    // Use console.log so clean-reporter surfaces diagnostic prefixes in CI output
    console.log("\n[AI State Dump] URL:", state.url);
    console.log(
      `[AI State Dump] Chat container: ${state.chatContainerFound ? "found" : "NOT FOUND"}, copilot-running: ${state.copilotRunning ?? "N/A"}`,
    );
    console.log(
      `[AI State Dump] ${state.userMessages.length} user message(s), ${state.assistantMessages.length} assistant message(s)`,
    );
    for (const msg of state.userMessages) {
      console.log(`[AI State Dump] User[${msg.index}]: ${msg.text}`);
    }
    for (const msg of state.assistantMessages) {
      console.log(`[AI State Dump] Assistant[${msg.index}]: ${msg.text}`);
    }
    if (state.assistantMessages.length === 0) {
      console.log("  [Assistant] (no messages — LLM may not have responded)");
    }
    console.log(
      `[AI State Dump] Confirm modals: ${state.confirmModals}, buttons: ${JSON.stringify(state.confirmButtons)}`,
    );
    console.log(`[AI State Dump] Tiptap editor: ${state.tiptapContent}`);
    if (state.confirmModals > 0) {
      for (const t of state.confirmModalTexts) {
        console.log(`  [Modal] ${t}`);
      }
    }
  } catch {
    console.log(
      "[AI State Dump] Could not read page state (page may have navigated away)",
    );
  }
}

/**
 * Dump LLMock journal entries on test failure so CI logs show what the mock
 * server received and returned.
 */
async function dumpLLMockJournal() {
  try {
    const res = await fetch("http://localhost:5555/v1/_requests?limit=20");
    if (!res.ok) {
      console.log(
        `[LLMock Journal] Non-OK response: ${res.status} ${res.statusText}`,
      );
      return;
    }
    const entries = (await res.json()) as Array<{
      method: string;
      path: string;
      body: {
        model?: string;
        messages?: Array<{ role: string; content?: unknown }>;
      };
      response: {
        status: number;
        fixture?: {
          match?: { userMessage?: string };
          response?: unknown;
        } | null;
      };
    }>;
    console.log(`\n[LLMock Journal] ${entries.length} request(s) recorded:`);
    for (const [i, entry] of entries.entries()) {
      const msgs = entry.body?.messages ?? [];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      const lastUserText =
        typeof lastUser?.content === "string"
          ? lastUser.content.slice(0, 80)
          : "(non-string)";
      const fixtureName =
        entry.response?.fixture?.match?.userMessage ?? "(predicate)";
      console.log(
        `  [${i}] ${entry.method} ${entry.path} → ${entry.response?.status} | model=${entry.body?.model ?? "?"} msgs=${msgs.length} lastUser="${lastUserText}" fixture="${fixtureName}"`,
      );
    }
  } catch {
    console.log(
      "[LLMock Journal] Could not fetch journal (server may be down)",
    );
  }
}

// Extend base test with isolation setup and error monitoring
export const test = base.extend({
  // Named `provide` rather than Playwright's conventional `use`: `use(...)` is
  // React 19's hook, so eslint-plugin-react-hooks flags the bare call.
  page: async ({ page }, provide, testInfo) => {
    // Before each test - ensure clean state
    await page.context().clearCookies();
    await page.context().clearPermissions();

    // Monitor for app errors so failed backends surface immediately
    // instead of manifesting as opaque timeouts.
    const pageErrors: Error[] = [];
    const networkErrors: string[] = [];
    const agentPosts: string[] = [];

    page.on("pageerror", (error) => {
      console.error(`[PageError] ${error.message}`);
      pageErrors.push(error);
    });

    // Log browser console errors (e.g. CopilotKit runtime logging API failures)
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[BrowserConsole] ${msg.text()}`);
      }
    });

    // Log ALL POST requests to agent backends (helps debug hung SSE streams)
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /copilotkit|agui|agent/i.test(request.url())
      ) {
        const ts = new Date().toISOString().slice(11, 23);
        const msg = `[AgentPOST] ${ts} → ${request.url()}`;
        console.log(msg);
        agentPosts.push(msg);
      }
    });

    // Log ALL responses from agent backends (including SSE stream starts)
    page.on("response", (response) => {
      if (/copilotkit|agui|agent/i.test(response.url())) {
        const ts = new Date().toISOString().slice(11, 23);
        if (response.status() >= 400) {
          const msg = `${response.status()} ${response.url()}`;
          console.error(`[NetworkError] ${msg}`);
          networkErrors.push(msg);
        }
        if (response.request().method() === "POST") {
          console.log(
            `[AgentResp] ${ts} ← ${response.status()} ${response.url()}`,
          );
        }
      }
    });

    await provide(page);

    // On failure: dump what the LLM actually did so CI logs are actionable
    if (testInfo.status !== testInfo.expectedStatus) {
      await dumpPageAIState(page);
      await dumpLLMockJournal();
    }

    // After each test - report collected errors
    if (pageErrors.length > 0) {
      console.warn(
        `[Test Cleanup] ${pageErrors.length} page error(s) during test:`,
        pageErrors.map((e) => e.message),
      );
    }
    if (networkErrors.length > 0) {
      console.warn(
        `[Test Cleanup] ${networkErrors.length} network error(s) during test:`,
        networkErrors,
      );
    }
    if (
      testInfo.status !== testInfo.expectedStatus &&
      agentPosts.length > 0
    ) {
      console.log(
        `[Test Cleanup] ${agentPosts.length} agent POST(s) during test:`,
      );
      for (const msg of agentPosts) console.log(`  ${msg}`);
    }
    await page.context().clearCookies();
  },
});

/**
 * Wait for the AI response to finish (SSE stream complete).
 * Delegates to awaitLLMResponseDone which uses the data-copilot-running attribute.
 */
export async function waitForAIResponse(page: Page, timeout: number = 15000) {
  await awaitLLMResponseDone(page, timeout);
}

/**
 * Wait for a specific number of assistant messages to exist with content.
 * More precise than waitForAIResponse when you know the expected message count.
 */
export async function waitForAssistantMessage(
  page: Page,
  options: {
    minMessages?: number;
    timeout?: number;
    stabilizationMs?: number;
  } = {},
) {
  const { minMessages = 1, timeout = 30_000, stabilizationMs = 500 } = options;

  await page.waitForFunction(
    (min: number) => {
      const messages = document.querySelectorAll(
        '[data-testid="copilot-assistant-message"]',
      );
      if (messages.length < min) return false;
      const lastMessage = messages[messages.length - 1];
      return (lastMessage?.textContent?.trim().length ?? 0) > 0;
    },
    minMessages,
    { timeout },
  );

  await page.waitForTimeout(stabilizationMs);
}

export { expect } from "@playwright/test";
