import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(
  process.cwd(),
  "scripts/release/generate-ai-release-notes.ts",
);

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "ai-notes-"));
}

// Fixture inputs match what collect-accumulated-bumps.py actually writes
// (raw ecosystem strings from release.config.json scope definitions:
// "typescript" / "python"). The script normalizes these to "npm" / "pypi"
// before grouping, and tests assert the normalized form ends up in the prompt.
const SAMPLE_BUMPS = [
  {
    scope: "@ag-ui/core",
    name: "@ag-ui/core",
    path: "typescript-sdk/packages/core",
    file: "typescript-sdk/packages/core/package.json",
    ecosystem: "typescript",
    oldVersion: "0.0.40",
    newVersion: "0.0.41",
  },
  {
    scope: "ag-ui-langgraph",
    name: "ag-ui-langgraph",
    path: "python-sdk/ag-ui-langgraph",
    file: "python-sdk/ag-ui-langgraph/pyproject.toml",
    ecosystem: "python",
    oldVersion: "0.0.10",
    newVersion: "0.0.11",
  },
];

async function runScript(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", SCRIPT, ...args], {
      env: {
        ...process.env,
        ...env,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ status: code ?? 0, stdout, stderr });
    });
  });
}

test(
  "exits 0 with no output file when ANTHROPIC_API_KEY is unset",
  { timeout: 30_000 },
  async () => {
    const dir = mkTmp();
    try {
      const accumulated = join(dir, "accumulated.json");
      const output = join(dir, "ai-notes.md");
      writeFileSync(accumulated, JSON.stringify(SAMPLE_BUMPS));

      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--output",
          output,
          "--version",
          "0.0.41",
        ],
        { ANTHROPIC_API_KEY: "" },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(
        existsSync(output),
        false,
        "output file must NOT exist on missing key",
      );
      assert.match(result.stderr, /ANTHROPIC_API_KEY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "exits 0 with no output file when accumulated.json is missing",
  { timeout: 30_000 },
  async () => {
    const dir = mkTmp();
    try {
      const accumulated = join(dir, "does-not-exist.json");
      const output = join(dir, "ai-notes.md");

      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--output",
          output,
          "--version",
          "0.0.41",
        ],
        { ANTHROPIC_API_KEY: "test-key-not-used" },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(existsSync(output), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "exits 0 with no output file when accumulated.json is empty array",
  { timeout: 30_000 },
  async () => {
    const dir = mkTmp();
    try {
      const accumulated = join(dir, "accumulated.json");
      const output = join(dir, "ai-notes.md");
      writeFileSync(accumulated, "[]");

      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--output",
          output,
          "--version",
          "0.0.41",
        ],
        { ANTHROPIC_API_KEY: "test-key-not-used" },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(existsSync(output), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "exits 0 with no output file when all accumulated entries are malformed",
  { timeout: 30_000 },
  async () => {
    const dir = mkTmp();
    try {
      const accumulated = join(dir, "accumulated.json");
      const output = join(dir, "ai-notes.md");
      // Deliberately invalid types: name should be string, ecosystem should be string.
      writeFileSync(
        accumulated,
        JSON.stringify([{ name: 123 }, { ecosystem: null }]),
      );

      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--output",
          output,
          "--version",
          "0.0.41",
        ],
        { ANTHROPIC_API_KEY: "test-key-not-used" },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(
        existsSync(output),
        false,
        "output file must NOT exist when all entries are malformed",
      );
      assert.match(result.stderr, /invalid|malformed|skipping/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "exits 0 with no output file when Anthropic API is unreachable",
  { timeout: 30_000 },
  async () => {
    const dir = mkTmp();
    try {
      const accumulated = join(dir, "accumulated.json");
      const output = join(dir, "ai-notes.md");
      writeFileSync(accumulated, JSON.stringify(SAMPLE_BUMPS));

      // Override Anthropic endpoint to a known-unreachable URL via env var.
      // This exercises the transport-error branch (ECONNREFUSED), NOT the
      // non-2xx HTTP response branch — see the next test for that.
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--output",
          output,
          "--version",
          "0.0.41",
        ],
        {
          ANTHROPIC_API_KEY: "sk-invalid-test-key-xxxxxxxxxxxxxxxxxxxxxx",
          ANTHROPIC_BASE_URL: "https://127.0.0.1:1/", // unreachable
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(existsSync(output), false);
      assert.match(
        result.stderr,
        /AI release notes generation failed|ECONNREFUSED|ENOTFOUND|fetch|request/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "exits 0 with no output file when Anthropic API returns non-2xx",
  { timeout: 30_000 },
  async () => {
    const http = await import("node:http");
    const dir = mkTmp();
    let server: import("node:http").Server | undefined;
    try {
      const accumulated = join(dir, "accumulated.json");
      const output = join(dir, "ai-notes.md");
      writeFileSync(accumulated, JSON.stringify(SAMPLE_BUMPS));

      server = http.createServer((_req, res) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("error body");
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--output",
          output,
          "--version",
          "0.0.41",
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/`,
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(
        existsSync(output),
        false,
        "output file must NOT exist on non-2xx",
      );
      assert.match(result.stderr, /500|status|HTTP/i);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "writes valid markdown when Anthropic API returns success (mocked via base URL)",
  { timeout: 30_000 },
  async () => {
    // Spin up an in-process HTTPS-ish mock by overriding ANTHROPIC_BASE_URL to a local HTTP server.
    const http = await import("node:http");
    const dir = mkTmp();
    let server: import("node:http").Server | undefined;
    // Hoist captured request data out of the handler so assertions run AFTER
    // runScript resolves — assertions inside req.on(...) handlers silently
    // swallow errors and never fail the test.
    let receivedMethod = "";
    let receivedUrl = "";
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody: {
      model?: string;
      max_tokens?: number;
      messages?: Array<{ content: string }>;
    } = {};
    try {
      const accumulated = join(dir, "accumulated.json");
      const output = join(dir, "ai-notes.md");
      writeFileSync(accumulated, JSON.stringify(SAMPLE_BUMPS));

      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          receivedMethod = req.method ?? "";
          receivedUrl = req.url ?? "";
          receivedHeaders = req.headers;
          receivedBody = JSON.parse(body);

          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              content: [
                {
                  type: "text",
                  text: "## npm\n- @ag-ui/core 0.0.40 -> 0.0.41\n\n## pypi\n- ag-ui-langgraph 0.0.10 -> 0.0.11",
                },
              ],
            }),
          );
        });
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--output",
          output,
          "--version",
          "0.0.41",
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/`,
        },
      );

      assert.equal(receivedMethod, "POST");
      assert.equal(receivedUrl, "/v1/messages");
      assert.equal(receivedHeaders["x-api-key"], "sk-test-mock");
      assert.equal(receivedHeaders["anthropic-version"], "2023-06-01");
      assert.equal(receivedBody.model, "claude-opus-4-8");
      assert.equal(receivedBody.max_tokens, 2048);
      assert.ok(Array.isArray(receivedBody.messages));
      assert.match(receivedBody.messages![0].content, /ag-ui/i);
      assert.match(receivedBody.messages![0].content, /0\.0\.41/);

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(
        existsSync(output),
        true,
        "output file must exist on success",
      );
      const md = readFileSync(output, "utf8");
      assert.match(md, /@ag-ui\/core/);
      assert.match(md, /ag-ui-langgraph/);
      assert.match(md, /0\.0\.41/);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "groups prompt input by ecosystem and includes both npm and pypi sections",
  { timeout: 30_000 },
  async () => {
    const http = await import("node:http");
    const dir = mkTmp();
    let server: import("node:http").Server | undefined;
    let receivedPrompt = "";
    try {
      const accumulated = join(dir, "accumulated.json");
      const output = join(dir, "ai-notes.md");
      writeFileSync(accumulated, JSON.stringify(SAMPLE_BUMPS));

      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          receivedPrompt = JSON.parse(body).messages[0].content;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
        });
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      await runScript(
        [
          "--accumulated",
          accumulated,
          "--output",
          output,
          "--version",
          "0.0.41",
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/`,
        },
      );

      // Assert the inventory section headers (### npm / ### pypi) are present
      // and immediately followed by their expected package lines. Loose /npm/i
      // would also match the constraint-text mention of "(npm, pypi)" and
      // would NOT catch a broken normalizeEcosystem (which would emit
      // ### typescript / ### python instead).
      assert.ok(
        receivedPrompt.includes("### npm\n- @ag-ui/core"),
        `prompt missing literal "### npm" inventory heading with @ag-ui/core line; got:\n${receivedPrompt}`,
      );
      assert.ok(
        receivedPrompt.includes("### pypi\n- ag-ui-langgraph"),
        `prompt missing literal "### pypi" inventory heading with ag-ui-langgraph line; got:\n${receivedPrompt}`,
      );
      // Raw input ecosystem labels must NOT appear as inventory headings —
      // normalization should have mapped them to npm/pypi.
      assert.ok(
        !receivedPrompt.includes("### typescript"),
        `prompt unexpectedly contains raw "### typescript" heading — normalization failed`,
      );
      assert.ok(
        !receivedPrompt.includes("### python"),
        `prompt unexpectedly contains raw "### python" heading — normalization failed`,
      );
      assert.match(receivedPrompt, /@ag-ui\/core/);
      assert.match(receivedPrompt, /ag-ui-langgraph/);
      assert.match(receivedPrompt, /agent-user interaction protocol/i);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "normalizes dotnet ecosystem bumps to a nuget prompt section",
  { timeout: 30_000 },
  async () => {
    const http = await import("node:http");
    const dir = mkTmp();
    let server: import("node:http").Server | undefined;
    let receivedPrompt = "";
    try {
      const accumulated = join(dir, "accumulated.json");
      const output = join(dir, "ai-notes.md");
      writeFileSync(
        accumulated,
        JSON.stringify([
          {
            scope: "sdk-dotnet",
            name: "AGUI.Client",
            path: "sdks/dotnet/src/AGUI.Client",
            file: "sdks/dotnet/Directory.Build.props",
            ecosystem: "dotnet",
            oldVersion: "0.0.1",
            newVersion: "0.1.0",
          },
        ]),
      );

      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          receivedPrompt = JSON.parse(body).messages[0].content;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
        });
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      await runScript(
        [
          "--accumulated",
          accumulated,
          "--output",
          output,
          "--version",
          "0.1.0",
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/`,
        },
      );

      assert.ok(
        receivedPrompt.includes("### nuget\n- AGUI.Client"),
        `prompt missing literal "### nuget" inventory heading with AGUI.Client line; got:\n${receivedPrompt}`,
      );
      assert.ok(
        !receivedPrompt.includes("### dotnet"),
        `prompt unexpectedly contains raw "### dotnet" heading — normalization failed`,
      );
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
