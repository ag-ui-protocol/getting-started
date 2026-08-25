import { LLMock } from "@copilotkit/aimock";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Port used for the LLMock OpenAI emulator. Tests assume the C# server is
 * started with OPENAI_BASE_URL pointing here. The dojo e2e suite uses 5555;
 * we use 5556 to avoid colliding with a running dojo on the same machine.
 */
export const LLMOCK_PORT = 5556;

/** Directory holding the committed, deterministic fixtures. */
export const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

/**
 * Sub-directory where the recorder writes raw per-turn fixtures captured from
 * the real LLM. These are intentionally NOT loaded on replay (we only load
 * top-level fixtures/*.json) and are gitignored — they are raw material a
 * developer curates into the committed named fixtures.
 */
export const RECORDED_DIR = path.join(FIXTURES_DIR, "recorded");

export interface RecordOptions {
  /**
   * Upstream base URL for the OpenAI-compatible provider. Because the C# server
   * talks plain OpenAI to AIMock (POST /v1/chat/completions), AIMock joins this
   * base with the request path. Point it at Azure's OpenAI v1 surface, e.g.
   * `https://<resource>.cognitiveservices.azure.com/openai` so the proxied URL
   * becomes `.../openai/v1/chat/completions`.
   */
  upstream: string;
  /** Directory the recorder writes captured fixtures to. Defaults to RECORDED_DIR. */
  fixturePath?: string;
}

export interface StartLLMockOptions {
  /**
   * When set, unmatched requests are proxied to the real upstream LLM, the
   * response is recorded as a fixture on disk, and relayed back. Committed
   * fixtures are still loaded first, so recording only fills gaps — delete a
   * committed fixture to force its scenario to re-record.
   */
  record?: RecordOptions;
}

let server: LLMock | null = null;

/**
 * Start the LLMock OpenAI emulator with deterministic fixtures matching the
 * prompts the cross-language tests will send. When `record` is supplied the
 * server additionally proxies unmatched requests to a real upstream LLM and
 * captures the responses (see RecordOptions). We mirror the dojo's per-chunk
 * latency so streaming behaviour resembles the real CI configuration.
 */
export async function startLLMock(options?: StartLLMockOptions): Promise<void> {
  if (server) {
    return;
  }
  server = new LLMock({
    port: LLMOCK_PORT,
    latency: 5,
    // Surface the recorder's "NO FIXTURE MATCH — proxying to ..." logs so a
    // record run is observable; stay silent during ordinary replay.
    logLevel: options?.record ? "info" : "silent",
  });

  const files = await fs.readdir(FIXTURES_DIR).catch(() => [] as string[]);
  for (const file of files) {
    if (file.endsWith(".json")) {
      server.loadFixtureFile(path.join(FIXTURES_DIR, file));
    }
  }

  if (options?.record) {
    const fixturePath = options.record.fixturePath ?? RECORDED_DIR;
    await fs.mkdir(fixturePath, { recursive: true });
    server.enableRecording({
      providers: { openai: options.record.upstream },
      fixturePath,
    });
  }

  await server.start();
}

export async function stopLLMock(): Promise<void> {
  if (!server) {
    return;
  }
  await server.stop();
  server = null;
}

export function llmockBaseUrl(): string {
  return `http://localhost:${LLMOCK_PORT}/v1`;
}
