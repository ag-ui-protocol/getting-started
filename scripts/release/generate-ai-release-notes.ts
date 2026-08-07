#!/usr/bin/env -S pnpm tsx
/**
 * Generate AI release notes for ag-ui release PRs.
 *
 * Reads /tmp/accumulated.json (or any path via --accumulated), calls the
 * Anthropic API directly (no SDK) to produce a short Markdown summary
 * grouped by ecosystem, and writes it to --output.
 *
 * FAIL-SOFT BY DESIGN: any failure (missing key, missing input, empty input,
 * non-2xx response, network error) results in exit 0 with NO output file
 * written and a warning to stderr. The release workflow's `[ -s ai-notes.md ]`
 * guard then falls back to the deterministic table-only PR body.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

type Bump = {
  scope: string;
  name: string;
  path: string;
  file: string;
  ecosystem: string;
  oldVersion: string;
  newVersion: string;
};

const MODEL = "claude-sonnet-4-20250514";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 2048;
const DEFAULT_BASE = "https://api.anthropic.com/";

function parseArgs(argv: string[]):
  | {
      accumulated: string;
      output: string;
      version: string;
    }
  | undefined {
  const out = { accumulated: "", output: "", version: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--accumulated") out.accumulated = argv[++i] ?? "";
    else if (a === "--output") out.output = argv[++i] ?? "";
    else if (a === "--version") out.version = argv[++i] ?? "";
  }
  if (!out.accumulated) {
    warn(
      "missing required --accumulated <path>; skipping AI release notes generation",
    );
    return undefined;
  }
  if (!out.output) {
    warn(
      "missing required --output <path>; skipping AI release notes generation",
    );
    return undefined;
  }
  return out;
}

function warn(msg: string): void {
  console.error(`[ai-release-notes] ${msg}`);
}

// Type guard validating a single accumulated entry has the non-empty string
// fields buildPrompt depends on. Entries failing this guard are dropped with
// a warning; if no valid entries remain the script fail-softs (exit 0, no
// output file) the same as the empty-array branch.
function isValidBump(x: unknown): x is Bump {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  const required = ["name", "ecosystem", "oldVersion", "newVersion"] as const;
  for (const k of required) {
    if (typeof o[k] !== "string" || (o[k] as string).length === 0) return false;
  }
  return true;
}

// Normalize ecosystem labels from collect-accumulated-bumps.py output
// ("typescript" / "python" / "dotnet") to the npm / pypi / nuget labels the
// prompt and PR-body table use. Anything else passes through unchanged —
// notably "maven", which is already the registry's name.
function normalizeEcosystem(eco: string): string {
  if (eco === "typescript") return "npm";
  if (eco === "python") return "pypi";
  if (eco === "dotnet") return "nuget";
  return eco;
}

function buildPrompt(bumps: Bump[], version: string): string {
  const byEco = new Map<string, Bump[]>();
  for (const b of bumps) {
    const eco = normalizeEcosystem(b.ecosystem);
    const list = byEco.get(eco) ?? [];
    list.push(b);
    byEco.set(eco, list);
  }
  const sections: string[] = [];
  for (const eco of [...byEco.keys()].sort()) {
    const lines = byEco
      .get(eco)!
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => `- ${b.name}: ${b.oldVersion} -> ${b.newVersion}`);
    sections.push(`### ${eco}\n${lines.join("\n")}`);
  }
  const inventory = sections.join("\n\n");
  const versionLine = version
    ? `for ag-ui v${version}`
    : "for the upcoming ag-ui release";

  return [
    `Write concise release notes ${versionLine}, the agent-user interaction protocol`,
    `(ag-ui) used to connect front-end UIs to back-end AI agents.`,
    ``,
    `Audience: developers integrating ag-ui SDKs.`,
    ``,
    `Constraints:`,
    `- Group output by ecosystem (npm, pypi, nuget) using "### <ecosystem>" headings.`,
    `- Under each ecosystem, list each package with its old -> new version.`,
    `- Add a brief (<=15 words) plain-English summary of what the bump likely`,
    `  contains given the package name. If you cannot infer, omit the summary.`,
    `- No marketing language. No emoji. No "we are excited to announce".`,
    `- Output Markdown only. No preamble, no closing remarks.`,
    ``,
    `Packages bumped in this release:`,
    ``,
    inventory,
  ].join("\n");
}

function callAnthropic(prompt: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const baseRaw = process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE;
    let base: URL;
    try {
      base = new URL(baseRaw);
    } catch (e) {
      return reject(new Error(`invalid ANTHROPIC_BASE_URL: ${baseRaw}`));
    }
    const endpoint = new URL("v1/messages", base);
    const payload = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });
    const isHttps = endpoint.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(
      {
        method: "POST",
        hostname: endpoint.hostname,
        port: endpoint.port || (isHttps ? 443 : 80),
        path: endpoint.pathname + endpoint.search,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload).toString(),
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            return reject(
              new Error(
                `Anthropic API ${res.statusCode}: ${body.slice(0, 500)}`,
              ),
            );
          }
          try {
            const parsed = JSON.parse(body) as {
              content?: Array<{ type: string; text?: string }>;
            };
            const text = (parsed.content ?? [])
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text!)
              .join("\n")
              .trim();
            if (!text)
              return reject(
                new Error("Anthropic response had no text content"),
              );
            resolve(text);
          } catch (e) {
            reject(
              new Error(
                `failed to parse Anthropic response: ${(e as Error).message}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Anthropic API request timed out after 30s"));
    });
    req.write(payload);
    req.end();
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    // parseArgs already warned and the fail-soft contract requires no
    // output file and exit 0 on any failure, including missing args.
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    warn("ANTHROPIC_API_KEY not set; skipping AI release notes generation");
    return; // exit 0, no output file
  }

  if (!existsSync(args.accumulated)) {
    warn(`accumulated file not found at ${args.accumulated}; skipping`);
    return;
  }

  let bumps: Bump[];
  try {
    const raw = readFileSync(args.accumulated, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      warn(`accumulated file is not a JSON array; skipping`);
      return;
    }
    const valid: Bump[] = [];
    for (let i = 0; i < parsed.length; i++) {
      if (isValidBump(parsed[i])) {
        valid.push(parsed[i]);
      } else {
        warn(
          `accumulated entry at index ${i} is invalid or malformed; skipping it`,
        );
      }
    }
    bumps = valid;
  } catch (e) {
    warn(`failed to read/parse accumulated file: ${(e as Error).message}`);
    return;
  }

  if (bumps.length === 0) {
    warn("accumulated bumps is empty; skipping");
    return;
  }

  const prompt = buildPrompt(bumps, args.version);

  let markdown: string;
  try {
    markdown = await callAnthropic(prompt, apiKey);
  } catch (e) {
    warn(`AI release notes generation failed: ${(e as Error).message}`);
    return;
  }

  try {
    writeFileSync(args.output, markdown + "\n", "utf8");
  } catch (e) {
    warn(`failed to write output: ${(e as Error).message}`);
    return;
  }
}

main().catch((e) => {
  warn(`unexpected error: ${(e as Error).message}`);
  // Never propagate non-zero — workflow must remain green.
  process.exit(0);
});
