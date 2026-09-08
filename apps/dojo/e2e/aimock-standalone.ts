// Standalone aimock runner (OSS-162) — boots the SAME LLMock + fixtures the e2e uses
// (apps/dojo/e2e/aimock-setup.ts), so you can INTERACTIVELY demo / record the A2UI
// recovery + hard-failure flow in the browser instead of only via Playwright.
//
// Usage (from apps/dojo/e2e):
//   npx tsx aimock-standalone.ts                 # default 5ms/attempt (fast)
//   AIMOCK_LATENCY=1500 npx tsx aimock-standalone.ts   # slow, watchable for recording
//
// Then, in two more terminals:
//   (agent)  cd integrations/langgraph/typescript/examples
//            OPENAI_BASE_URL=http://localhost:5555/v1 pnpm dev
//   (dojo)   cd apps/dojo && PORT=3002 npm run dev
//
// Open the dojo → A2UI Error Recovery feature. The suggestion pills map to fixtures:
//   "Compare 3 luxury hotels…"  -> invalid first attempt, recovers to a valid surface
//   "Compare 3 broken hotels…"  -> every attempt invalid -> exhaustion -> hard-failure panel
import { setupLLMock, teardownLLMock } from "./aimock-setup";

async function main() {
  await setupLLMock();
  const url = process.env.LLMOCK_URL ?? "http://localhost:5555/v1";
  const latency = Number(process.env.AIMOCK_LATENCY) || 5;
  console.log(
    `\n✅ aimock is running (interactive mode).\n` +
      `   Point the agent at:  OPENAI_BASE_URL=${url}\n` +
      `   Latency/attempt:     ${latency}ms  (set AIMOCK_LATENCY=1500 to slow it for recording)\n` +
      `   Stop with Ctrl-C.\n`,
  );
}

const shutdown = async () => {
  try {
    await teardownLLMock();
  } catch {
    // ignore
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Failed to start aimock:", err);
  process.exit(1);
});

// Keep the process alive until Ctrl-C.
setInterval(() => {}, 1 << 30);
