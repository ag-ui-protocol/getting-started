#!/usr/bin/env -S pnpm tsx
/**
 * Generate per-package changelog entries for ag-ui release PRs.
 *
 * Reads the accumulated version bumps (collect-accumulated-bumps.py output),
 * gathers each package's git history since its last release tag
 * (`<name>@<oldVersion>`), asks the Anthropic API for one entry per package,
 * and prepends each entry to `<package path>/CHANGELOG.md`. A concatenated
 * summary is written to --summary-output for the release PR body.
 *
 * The committed CHANGELOG.md files are the source of truth downstream:
 * humans edit them with ordinary commits on release/next, and the publish
 * workflow reads them (via extract-changelog-entry.py) to build the GitHub
 * Release body. A package whose CHANGELOG.md already contains a heading for
 * the new version is skipped, so stacking another scope onto the release PR
 * never overwrites a human edit.
 *
 * Every entry this script GENERATES carries a "Breaking changes" section;
 * when the model reports none, the section says "None." explicitly so the
 * human approving the PR confirms that claim. A hand-written entry filling in
 * for a failed run is not checked for one — the skip test is the presence of
 * a version heading.
 *
 * FAIL-SOFT, BUT LOUD: any failure (missing key, API error, unparseable or
 * structurally unsafe model output, write error) writes the reason to
 * --failure-output, leaves no changelog file modified — writes are planned in
 * full first and rolled back if one fails partway — and exits 0, so the
 * release stays mergeable with hand-written entries. The workflow turns a
 * non-empty failure file into a CI annotation and a Slack alert, so a broken
 * generator is never invisible again.
 *
 * Stdout, on a successful run only: JSON
 * {"written": [paths], "skipped": [{name, version, reason}]}. A failed run
 * writes nothing to stdout, so callers must not assume the file they redirect
 * it to contains JSON.
 *
 * KNOWN LIMITATION: history is collected against the release branch's HEAD.
 * A commit that lands on main after the branch was cut is published by the
 * eventual merge but is not described here, and re-running does not add it
 * because the existing version heading is deliberately skipped.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import { join } from "node:path";

export type Bump = {
  scope: string;
  name: string;
  path: string;
  file: string;
  ecosystem: string;
  oldVersion: string;
  newVersion: string;
};

export type PackageHistory = {
  bump: Bump;
  commits: string[];
  rangeNote: string;
};

export type ModelEntry = {
  name: string;
  notes: string;
  breaking: string;
};

const MODEL = "claude-opus-4-8";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;
const DEFAULT_BASE = "https://api.anthropic.com/";
const MAX_COMMITS_PER_PACKAGE = 100;
const MAX_COMMIT_BODY_CHARS = 400;
const FALLBACK_COMMIT_COUNT = 30;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 300_000;
// GitHub rejects a pull-request body over 65,536 characters with HTTP 422,
// which would strand pushed version bumps without a PR. The summary is
// informational — the committed CHANGELOG.md files are authoritative — so it
// is safe to bound well under that, leaving room for the workflow's table
// and boilerplate.
export const MAX_SUMMARY_CHARS = 40_000;

// Only used when a package has no CHANGELOG.md yet. Deliberately just the
// title: an explanatory comment here would appear in new files but never in
// ones that already exist (so it could not be relied on), would be hidden by
// Markdown rendering anyway, and would duplicate — across 46 packages — the
// text the release PR body already states where reviewers can see it.
const CHANGELOG_HEADER = ["# Changelog", ""].join("\n");

function warn(msg: string): void {
  console.error(`[changelog-entries] ${msg}`);
}

function parseArgs(argv: string[]):
  | {
      accumulated: string;
      summaryOutput: string;
      failureOutput: string;
      repoRoot: string;
      date: string;
    }
  | { error: string } {
  const out = {
    accumulated: "",
    summaryOutput: "",
    failureOutput: "",
    repoRoot: process.cwd(),
    date: new Date().toISOString().slice(0, 10),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--accumulated") out.accumulated = argv[++i] ?? "";
    else if (a === "--summary-output") out.summaryOutput = argv[++i] ?? "";
    else if (a === "--failure-output") out.failureOutput = argv[++i] ?? "";
    else if (a === "--repo-root") out.repoRoot = argv[++i] ?? out.repoRoot;
    else if (a === "--date") out.date = argv[++i] ?? out.date;
  }
  if (!out.accumulated)
    return { error: "missing required --accumulated <path>" };
  if (!out.summaryOutput)
    return { error: "missing required --summary-output <path>" };
  if (!out.failureOutput)
    return { error: "missing required --failure-output <path>" };
  return out;
}

// Validates EVERY field Bump declares, not just the ones this script reads:
// a predicate that asserts `x is Bump` while leaving fields unchecked hands
// downstream code a value whose type lies about it.
export function isValidBump(x: unknown): x is Bump {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  const required = [
    "scope",
    "name",
    "path",
    "file",
    "ecosystem",
    "oldVersion",
    "newVersion",
  ] as const;
  for (const k of required) {
    if (typeof o[k] !== "string" || (o[k] as string).length === 0) return false;
  }
  return true;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

// `rev-parse --verify --quiet` exits 1 with no output for a ref that simply
// does not exist. Any other failure (not a repository, corrupt object store,
// git missing) must NOT be silently reported as "no previous release" — that
// would quietly downgrade the package to the approximate-range fallback and
// describe the wrong commits. Those propagate to the caller's fail() path.
function tagExists(repoRoot: string, tag: string): boolean {
  try {
    git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
    return true;
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string };
    const stderr = (err.stderr ?? "").toString().trim();
    if (err.status === 1 && stderr === "") return false;
    throw new Error(
      `git rev-parse for tag ${tag} failed (status ${String(err.status)}): ${stderr || "no stderr"}`,
    );
  }
}

// Some configured package paths nest inside another's (ag-ui-a2ui-toolkit
// lives under the ag-ui-protocol path), so a parent's history must exclude
// every configured child path or it would describe the child's changes and
// burn its commit budget on them.
export function nestedPathExcludes(
  allPackagePaths: string[],
  packagePath: string,
): string[] {
  return allPackagePaths
    .filter((p) => p !== packagePath && p.startsWith(`${packagePath}/`))
    .map((p) => `:(exclude)${p}`);
}

// An unreadable or malformed config must NOT degrade to "no exclusions":
// that silently folds a nested package's commits into its parent's history
// and reports success. Absent config is the one benign case (a fixture tree
// that declares no packages), and it cannot mis-attribute anything.
function configuredPackagePaths(repoRoot: string): string[] {
  const configPath = join(repoRoot, "scripts/release/release.config.json");
  if (!existsSync(configPath)) return [];
  let config: {
    scopes?: Record<string, { packages?: Array<{ path?: string }> }>;
  };
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(
      `failed to read ${configPath} for nested-path excludes: ${(e as Error).message}`,
    );
  }
  return Object.values(config.scopes ?? {})
    .flatMap((s) => s.packages ?? [])
    .map((p) => p.path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

// One record per commit: subject, then an optional truncated body indented
// under it. Release bookkeeping commits are excluded — they are the mechanism,
// not the change.
// Truncate by code points, not UTF-16 code units: slicing mid-surrogate
// yields a lone half that JSON.stringify sends to the API as a malformed
// scalar. `[...text]` iterates code points.
function truncateCodePoints(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join("");
}

// Returns the formatted commit records plus whether the cap dropped older
// commits — the caller discloses that in the prompt, because a silently
// truncated history can make the model report "no consumer-facing changes"
// when the only meaningful commit sat behind a wall of mechanical ones.
export function formatCommits(raw: string): {
  commits: string[];
  truncated: boolean;
} {
  const records = raw
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean);
  const out: string[] = [];
  let considered = 0;
  for (const record of records) {
    const [subject, ...bodyLines] = record.split("\n");
    if (!subject || /^chore\(release\):/.test(subject)) continue;
    considered++;
    if (out.length >= MAX_COMMITS_PER_PACKAGE) continue;
    const body = truncateCodePoints(
      bodyLines.join("\n").trim(),
      MAX_COMMIT_BODY_CHARS,
    );
    out.push(
      body ? `- ${subject}\n  ${body.replace(/\n/g, "\n  ")}` : `- ${subject}`,
    );
  }
  return { commits: out, truncated: considered > out.length };
}

export function collectHistory(repoRoot: string, bump: Bump): PackageHistory {
  const lastTag = `${bump.name}@${bump.oldVersion}`;
  const logFormat = "--format=%s%n%b%x1e";
  const pathspec = [
    bump.path,
    ...nestedPathExcludes(configuredPackagePaths(repoRoot), bump.path),
  ];
  let raw: string;
  let rangeNote: string;
  if (bump.oldVersion !== "(new)" && tagExists(repoRoot, lastTag)) {
    raw = git(repoRoot, [
      "log",
      "--no-merges",
      logFormat,
      `${lastTag}..HEAD`,
      "--",
      ...pathspec,
    ]);
    rangeNote = `changes since ${lastTag}`;
  } else {
    raw = git(repoRoot, [
      "log",
      "--no-merges",
      logFormat,
      `-${FALLBACK_COMMIT_COUNT}`,
      "--",
      ...pathspec,
    ]);
    rangeNote = `last release tag ${lastTag} not found; showing the most recent commits touching this package (range approximate)`;
  }
  const { commits, truncated } = formatCommits(raw);
  if (truncated) {
    rangeNote += `; only the newest ${MAX_COMMITS_PER_PACKAGE} commits are shown, so older changes in this range are not listed`;
  }
  return { bump, commits, rangeNote };
}

export function buildPrompt(histories: PackageHistory[]): string {
  const sections = histories.map((h) => {
    const { bump, commits, rangeNote } = h;
    const list =
      commits.length > 0 ? commits.join("\n") : "- (no commits found in range)";
    return [
      `Package: ${bump.name}`,
      `Ecosystem: ${bump.ecosystem}`,
      `Version: ${bump.oldVersion} -> ${bump.newVersion}`,
      `Path: ${bump.path}`,
      `History: ${rangeNote}`,
      list,
    ].join("\n");
  });

  return [
    `You are writing changelog entries for a release of ag-ui, the agent-user`,
    `interaction protocol used to connect front-end UIs to back-end AI agents.`,
    ``,
    `Audience: developers who depend on these packages and are deciding`,
    `whether the upgrade is safe.`,
    ``,
    `For EVERY package listed below, write one changelog entry from its commit`,
    `history. Rules:`,
    `- Describe user-visible changes: behavior, API surface, fixes. Skip pure`,
    `  bookkeeping (version bumps, CI, lockfiles) unless it affects consumers.`,
    `- "breaking" lists anything a consumer must change or re-verify when`,
    `  upgrading: removed/renamed APIs, changed defaults, changed wire or`,
    `  serialization behavior, tightened validation. Empty string if none.`,
    `- Plain, factual language. No marketing, no emoji, no "we".`,
    `- Notes are Markdown bullet lists. Keep each bullet under 30 words.`,
    `- If the history is empty or only bookkeeping, say`,
    `  "- Maintenance release; no consumer-facing changes identified." and`,
    `  leave "breaking" empty.`,
    ``,
    `Respond with ONLY a JSON object, no code fences, of this exact shape:`,
    `{"entries": [{"name": "<package name>", "notes": "<markdown>", "breaking": "<markdown or empty string>"}]}`,
    `Include every package exactly once. "name" must be the exact string from`,
    `that package's "Package:" line — nothing appended, nothing rephrased.`,
    ``,
    `Packages:`,
    ``,
    sections.join("\n\n"),
  ].join("\n");
}

// The model is told to answer with bare JSON, but strip code fences anyway —
// a fenced answer is recoverable and better than a failed release-notes run.
export function parseModelOutput(
  text: string,
  expectedNames: string[],
): ModelEntry[] {
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) body = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`model output is not valid JSON: ${(e as Error).message}`);
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error('model output has no "entries" array');
  }
  const byName = new Map<string, ModelEntry>();
  for (const e of entries) {
    if (
      typeof e !== "object" ||
      e === null ||
      typeof (e as ModelEntry).name !== "string" ||
      typeof (e as ModelEntry).notes !== "string" ||
      typeof (e as ModelEntry).breaking !== "string"
    ) {
      throw new Error("model output entry is malformed");
    }
    const entry = e as ModelEntry;
    // A repeated name must not silently overwrite: the prompt asks for each
    // package exactly once, and last-write-wins could drop the entry that
    // reported a breaking change in favour of a duplicate that did not.
    if (byName.has(entry.name)) {
      throw new Error(
        `model output contains more than one entry named "${entry.name}"`,
      );
    }
    byName.set(entry.name, entry);
  }
  // Exact match first; tolerate a model that decorated the name with a
  // trailing parenthesized suffix (e.g. "ag_ui_strands (python)"). No real
  // package name contains " (", so this cannot mis-assign entries.
  // Exact and suffixed candidates are collected TOGETHER, not exact-first:
  // returning early on an exact match would silently ignore a second,
  // suffixed entry for the same package — and if that one carried the
  // breaking change, the warning would be dropped.
  const matchesFor = (n: string): ModelEntry[] => {
    const out: ModelEntry[] = [];
    const exact = byName.get(n);
    if (exact) out.push(exact);
    for (const [k, v] of byName) {
      if (k.startsWith(`${n} (`)) out.push(v);
    }
    return out;
  };
  const resolved: ModelEntry[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const name of expectedNames) {
    const matches = matchesFor(name);
    if (matches.length === 0) missing.push(name);
    else if (matches.length > 1) ambiguous.push(name);
    else resolved.push(matches[0]);
  }
  if (missing.length > 0) {
    throw new Error(
      `model output is missing entries for: ${missing.join(", ")}`,
    );
  }
  if (ambiguous.length > 0) {
    throw new Error(
      `model output has multiple candidate entries for: ${ambiguous.join(", ")}`,
    );
  }
  // Structural validation of the prose itself. Empty notes would publish a
  // version heading with nothing under it; an unclosed fence would swallow
  // the rest of the CHANGELOG once embedded.
  for (const entry of resolved) {
    if (entry.notes.trim().length === 0) {
      throw new Error(`model output has empty notes for "${entry.name}"`);
    }
    for (const [field, value] of [
      ["notes", entry.notes],
      ["breaking", entry.breaking],
    ] as const) {
      if (hasUnclosedFence(value)) {
        throw new Error(
          `model output for "${entry.name}" has an unclosed code fence in ${field}`,
        );
      }
    }
  }
  return resolved;
}

// Headings inside the fragments are demoted here as well as validated at the
// parse boundary: this is the one place an entry becomes part of a structured
// document, so nothing that reaches a CHANGELOG can carry a boundary-forming
// heading regardless of how the entry was constructed.
export function renderEntry(
  version: string,
  date: string,
  entry: ModelEntry,
): string {
  const notes = demoteFragmentHeadings(entry.notes.trim());
  const breakingText = entry.breaking.trim();
  const breaking = breakingText
    ? demoteFragmentHeadings(breakingText)
    : "None.";
  return [
    `## ${version} — ${date}`,
    ``,
    notes,
    ``,
    `### Breaking changes`,
    ``,
    breaking,
    ``,
  ].join("\n");
}

// Fence-aware structural scan shared by every operation that interprets a
// CHANGELOG's "## " headings. A "## " line inside a fenced code block is
// content, not a heading — treating it as one would cause false skips,
// truncated summaries, or entries inserted mid-example.
//
// Fences follow CommonMark (https://spec.commonmark.org/0.31.2/#fenced-code-blocks):
// an opener is three or more backticks or tildes indented at most three spaces,
// and it closes only on a line of the SAME character, at least as long as the
// opener, followed by nothing but whitespace. An opener may carry an info
// string, but a backtick fence's info string may not contain a backtick.
//
// Every clause of that rule is load-bearing here, because getting any of them
// wrong moves where an entry ends:
//   - A ``` line inside a ```` block is content. Tracking only the delimiter
//     character would leave the block "closed", so a literal "## " line inside
//     it reads as structural and the entry TRUNCATES there.
//   - An info string is legal on an opener but never on a closer. Accepting a
//     suffix as a closer ends the block early, with the same result.
//   - A backtick-containing info string means the line is ordinary text, not an
//     opener. Treating it as one opens a block that never closes, which
//     swallows the next version's heading — so the entry OVER-RUNS instead,
//     publishing older releases' notes as part of this one.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type OpenFence = { char: string; length: number } | null;

// Advances fence state by one line. `isFence` marks the opener and closer lines
// themselves, which belong to the block rather than to the surrounding prose.
function stepFence(
  line: string,
  open: OpenFence,
): { open: OpenFence; isFence: boolean } {
  const match = FENCE_RE.exec(line);
  if (!match) return { open, isFence: false };
  const [, marker, suffix] = match;
  if (open === null) {
    // A backtick in a backtick fence's info string makes the line text, not an
    // opener; tildes carry no such restriction.
    if (marker[0] === "`" && suffix.includes("`"))
      return { open, isFence: false };
    return { open: { char: marker[0], length: marker.length }, isFence: true };
  }
  const closes =
    marker[0] === open.char &&
    marker.length >= open.length &&
    suffix.trim() === "";
  return closes ? { open: null, isFence: true } : { open, isFence: false };
}

type ChangelogLine = {
  text: string;
  offset: number;
  isHeading: boolean;
  inFence: boolean;
};

export function scanChangelogLines(content: string): ChangelogLine[] {
  const out: ChangelogLine[] = [];
  let openFence: OpenFence = null;
  let offset = 0;
  for (const text of content.split("\n")) {
    const step = stepFence(text, openFence);
    openFence = step.open;
    out.push({
      text,
      offset,
      isHeading: openFence === null && !step.isFence && text.startsWith("## "),
      inFence: openFence !== null || step.isFence,
    });
    offset += text.length + 1;
  }
  return out;
}

// True when a fragment opens a fence it never closes. Such a fragment must
// never be embedded: inside the assembled CHANGELOG the unclosed fence would
// swallow everything after it, including the NEXT version's heading, so the
// file would silently lose entries in both directions.
export function hasUnclosedFence(text: string): boolean {
  let open: OpenFence = null;
  for (const line of text.split("\n")) {
    open = stepFence(line, open).open;
  }
  return open !== null;
}

// Model-written prose becomes part of a structured document whose entry
// boundary is a top-level "## " line. A heading the model emits at level 1 or
// 2 would therefore read as the start of the next entry, silently truncating
// everything after it — including the Breaking changes section — when the
// entry is later extracted for publication. Demote such headings to level 4,
// below any boundary, which preserves the content and its intent. Fenced
// headings are code samples and are left exactly as written. Idempotent.
export function demoteFragmentHeadings(text: string): string {
  return scanChangelogLines(text)
    .map((line) =>
      !line.inFence && /^#{1,2} /.test(line.text)
        ? `#### ${line.text.replace(/^#{1,2} +/, "")}`
        : line.text,
    )
    .join("\n");
}

// Accepts both this pipeline's headings ("## 0.7.0 — date") and the
// Keep-a-Changelog style some hand-maintained files use ("## [0.7.0] - date"),
// so a hand-written entry in either format is recognized and preserved.
// Returns the entry body (heading line excluded), or null when absent.
export function findVersionEntry(
  content: string,
  version: string,
): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[?${escaped}\\]?( |$)`);
  const lines = scanChangelogLines(content);
  const start = lines.findIndex((l) => l.isHeading && heading.test(l.text));
  if (start === -1) return null;
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.isHeading) break;
    body.push(l.text);
  }
  return body.join("\n").trim();
}

export function hasVersionEntry(content: string, version: string): boolean {
  return findVersionEntry(content, version) !== null;
}

// Insert the entry above the newest released entry, preserving everything
// else byte for byte. A Keep-a-Changelog "## [Unreleased]" section (the
// enrolled ADK changelog leads with one) stays on top — its pending content
// must not end up below a released version.
const UNRELEASED_HEADING_RE = /^## \[?unreleased\]?(\s|$)/i;

export function upsertEntry(
  existing: string | undefined,
  version: string,
  entryText: string,
): { content: string; action: "written" | "skipped" } {
  if (existing !== undefined && hasVersionEntry(existing, version)) {
    return { content: existing, action: "skipped" };
  }
  const base = existing ?? CHANGELOG_HEADER;
  const insertAt = scanChangelogLines(base).find(
    (l) => l.isHeading && !UNRELEASED_HEADING_RE.test(l.text),
  )?.offset;
  if (insertAt === undefined) {
    // No released entry yet (empty file, header only, or only an Unreleased
    // section): the new entry goes at the end.
    const sep = base.endsWith("\n") ? "\n" : "\n\n";
    return { content: `${base}${sep}${entryText}`, action: "written" };
  }
  return {
    content: base.slice(0, insertAt) + entryText + "\n" + base.slice(insertAt),
    action: "written",
  };
}

function callAnthropic(prompt: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const baseRaw = process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE;
    let base: URL;
    try {
      base = new URL(baseRaw);
    } catch {
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
        timeout: 120_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        // A connection reset AFTER the response headers surfaces on the
        // response stream, not the request. Without this handler the 'error'
        // event escapes the promise, crashes the process, and breaks the
        // exit-0 fail-soft contract (a non-zero exit fails the release step).
        res.on("error", (e: Error) =>
          reject(new Error(`Anthropic response stream failed: ${e.message}`)),
        );
        res.on("aborted", () =>
          reject(new Error("Anthropic response aborted before completing")),
        );
        res.on("data", (c: Buffer) => {
          // Bound the buffer: an unexpectedly huge response would otherwise
          // grow until the process is OOM-killed, which exits non-zero and
          // takes the whole release step down with it.
          received += c.length;
          if (received > MAX_RESPONSE_BYTES) {
            req.destroy();
            return reject(
              new Error(
                `Anthropic response exceeded ${MAX_RESPONSE_BYTES} bytes`,
              ),
            );
          }
          chunks.push(c);
        });
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
    // `timeout` is an INACTIVITY timer: a peer trickling one byte every 119
    // seconds would keep it alive indefinitely. The absolute deadline below
    // bounds total wall-clock time so the release step cannot hang.
    req.on("timeout", () => {
      req.destroy(new Error("Anthropic API request stalled for 120s"));
    });
    const deadline = setTimeout(() => {
      req.destroy(
        new Error(
          `Anthropic API request exceeded its ${REQUEST_DEADLINE_MS / 1000}s deadline`,
        ),
      );
    }, REQUEST_DEADLINE_MS);
    // unref so a pending deadline never keeps the process alive on its own.
    deadline.unref?.();
    const clear = (): void => clearTimeout(deadline);
    req.on("close", clear);
    req.write(payload);
    req.end();
  });
}

function fail(failureOutput: string, reason: string): void {
  warn(reason);
  try {
    writeFileSync(failureOutput, reason + "\n", "utf8");
  } catch (e) {
    warn(`additionally failed to write failure file: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    // A --failure-output may still have been given even when another arg is
    // missing; write there so the workflow can surface the reason.
    const idx = process.argv.indexOf("--failure-output");
    const givenFailure = idx !== -1 ? process.argv[idx + 1] : undefined;
    if (givenFailure) fail(givenFailure, args.error);
    else warn(args.error);
    return;
  }

  // The API key is checked later, only when a model call is actually needed:
  // checking it up front would return before the skipped-entry summaries are
  // built, and a stacked run with a missing secret would drop the already
  // committed entries from the PR body.
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";

  if (!existsSync(args.accumulated)) {
    fail(
      args.failureOutput,
      `accumulated file not found at ${args.accumulated}`,
    );
    return;
  }

  let bumps: Bump[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(args.accumulated, "utf8"));
    if (!Array.isArray(parsed)) {
      fail(args.failureOutput, "accumulated file is not a JSON array");
      return;
    }
    bumps = [];
    const malformed: number[] = [];
    for (let i = 0; i < parsed.length; i++) {
      if (isValidBump(parsed[i])) bumps.push(parsed[i]);
      else malformed.push(i);
    }
    // Skipping a malformed entry would leave a package that IS being
    // published with no notes and no warning — the invisible gap this
    // pipeline exists to close. One bad entry fails the run loudly instead.
    if (malformed.length > 0) {
      fail(
        args.failureOutput,
        `accumulated entries at index ${malformed.join(", ")} are malformed; every bumped package needs scope, name, path, file, ecosystem, oldVersion and newVersion`,
      );
      return;
    }
  } catch (e) {
    fail(
      args.failureOutput,
      `failed to read/parse accumulated file: ${(e as Error).message}`,
    );
    return;
  }

  if (bumps.length === 0) {
    fail(args.failureOutput, "accumulated bumps is empty");
    return;
  }

  // Skip packages whose CHANGELOG.md already carries this version — those
  // entries were generated (and possibly human-edited) by an earlier stacking
  // run and must survive untouched.
  const pending: Bump[] = [];
  const skipped: Array<{ name: string; version: string; reason: string }> = [];
  const existingContent = new Map<string, string>();
  const unreadable: string[] = [];
  for (const bump of bumps) {
    const changelogPath = join(args.repoRoot, bump.path, "CHANGELOG.md");
    let content: string | undefined;
    if (existsSync(changelogPath)) {
      try {
        content = readFileSync(changelogPath, "utf8");
      } catch (e) {
        // A changelog that exists but cannot be read leaves this package
        // unclassifiable — we cannot tell whether it already has the version,
        // so generating would risk duplicating a human's entry. Record it and
        // abort below, after the summary for the readable packages is written.
        unreadable.push(`${changelogPath}: ${(e as Error).message}`);
        continue;
      }
    }
    if (content !== undefined) existingContent.set(bump.name, content);
    if (content !== undefined && hasVersionEntry(content, bump.newVersion)) {
      skipped.push({
        name: bump.name,
        version: bump.newVersion,
        reason:
          "entry already present (preserving earlier or human-edited text)",
      });
    } else {
      pending.push(bump);
    }
  }

  const written: string[] = [];

  // Entries skipped in this run (committed by an earlier stacking run,
  // possibly human-edited) belong in the PR-body summary regardless of what
  // happens to this run's generation: when a later scope's generation fails,
  // the PR body must still show the valid entries that already exist.
  const skippedSummaryParts: string[] = [];
  for (const s of skipped) {
    const bump = bumps.find((b) => b.name === s.name)!;
    const body = findVersionEntry(existingContent.get(s.name)!, s.version);
    if (body !== null) {
      skippedSummaryParts.push(
        `### ${bump.name} ${bump.oldVersion} → ${bump.newVersion}\n\n${body}\n`,
      );
    }
  }
  const writeSummary = (parts: string[]): boolean => {
    // Bounded because the workflow copies this verbatim into the PR body,
    // which GitHub rejects past 65,536 characters — after version bumps have
    // already been pushed. Entries are dropped whole rather than mid-sentence,
    // and the omission is stated so nobody mistakes it for "nothing else
    // changed"; the committed CHANGELOG.md files remain authoritative.
    const kept: string[] = [];
    let total = 0;
    let dropped = 0;
    for (const part of parts) {
      if (total + part.length > MAX_SUMMARY_CHARS) {
        dropped++;
        continue;
      }
      kept.push(part);
      total += part.length;
    }
    if (dropped > 0) {
      kept.push(
        `_${dropped} further package ${dropped === 1 ? "entry was" : "entries were"} omitted from this summary to stay within GitHub's pull-request body limit. Read them in the committed \`CHANGELOG.md\` files on this branch — they publish normally._\n`,
      );
    }
    try {
      // Nothing to show must produce a ZERO-byte file, not a lone newline:
      // the workflow gates the "rendered from the committed CHANGELOG.md
      // entries" preamble on `[ -s ... ]`, which a 1-byte file satisfies. That
      // printed the preamble above an empty section on every first-scope
      // failure, asserting entries came from committed files when none exist.
      const body = kept.length > 0 ? kept.join("\n") + "\n" : "";
      writeFileSync(args.summaryOutput, body, "utf8");
      return true;
    } catch (e) {
      warn(`failed to write summary: ${(e as Error).message}`);
      return false;
    }
  };

  // Abort here rather than earlier so the entries that ARE committed still
  // reach the PR body — the same reason the API-key check sits below.
  if (unreadable.length > 0) {
    writeSummary(skippedSummaryParts);
    fail(
      args.failureOutput,
      `cannot read existing changelog(s): ${unreadable.join("; ")}`,
    );
    return;
  }

  const summaryParts: string[] = [];

  if (pending.length > 0) {
    if (!apiKey) {
      writeSummary(skippedSummaryParts);
      fail(args.failureOutput, "ANTHROPIC_API_KEY not set");
      return;
    }

    let histories: PackageHistory[];
    try {
      histories = pending.map((b) => collectHistory(args.repoRoot, b));
    } catch (e) {
      writeSummary(skippedSummaryParts);
      fail(
        args.failureOutput,
        `git history collection failed: ${(e as Error).message}`,
      );
      return;
    }

    let entries: ModelEntry[];
    let text = "";
    try {
      text = await callAnthropic(buildPrompt(histories), apiKey);
      entries = parseModelOutput(
        text,
        pending.map((b) => b.name),
      );
    } catch (e) {
      // A parse/validation failure is only diagnosable from what the model
      // actually said, so the failure reason carries a slice of it.
      const rawHint = text
        ? ` | raw model output (first 400 chars): ${text.slice(0, 400).replace(/\n/g, " ")}`
        : "";
      writeSummary(skippedSummaryParts);
      fail(
        args.failureOutput,
        `changelog generation failed: ${(e as Error).message}${rawHint}`,
      );
      return;
    }

    // All entries are validated and every new file content is computed BEFORE
    // anything is written, and a write that fails midway rolls the earlier
    // files back. Without the rollback a failure on the second package would
    // leave the first one modified while reporting failure — the working tree
    // would disagree with both the summary and the failure file.
    const planned = pending.map((bump, i) => ({
      bump,
      changelogPath: join(args.repoRoot, bump.path, "CHANGELOG.md"),
      entryText: renderEntry(bump.newVersion, args.date, entries[i]),
    }));
    const plannedWrites = planned.map((p) => ({
      ...p,
      content: upsertEntry(
        existingContent.get(p.bump.name),
        p.bump.newVersion,
        p.entryText,
      ).content,
      previous: existingContent.get(p.bump.name),
    }));

    for (const w of plannedWrites) {
      summaryParts.push(
        `### ${w.bump.name} ${w.bump.oldVersion} → ${w.bump.newVersion}\n\n${w.entryText.split("\n").slice(2).join("\n").trim()}\n`,
      );
    }

    // The summary is written BEFORE any changelog, so a failure writing it
    // cannot leave changelogs modified while the run reports failure. Its
    // content depends only on the validated entries, not on the writes.
    if (!writeSummary([...summaryParts, ...skippedSummaryParts])) {
      fail(args.failureOutput, "failed to write summary file");
      return;
    }

    // `attempted` includes the write that throws: a filesystem can truncate a
    // file and then fail, so the failing target needs restoring too, not just
    // the ones that completed. NOT covered by a test — the failures reachable
    // from here (EACCES, EISDIR) are refused at open, before truncation, so
    // this branch is defence for a case no portable fixture can produce.
    const attempted: typeof plannedWrites = [];
    try {
      for (const w of plannedWrites) {
        attempted.push(w);
        writeFileSync(w.changelogPath, w.content, "utf8");
      }
    } catch (e) {
      for (const done of [...attempted].reverse()) {
        try {
          if (done.previous === undefined) {
            rmSync(done.changelogPath, { force: true });
          } else {
            writeFileSync(done.changelogPath, done.previous, "utf8");
          }
        } catch (restoreError) {
          // Report rather than hide: a file we could not restore is the one
          // thing an operator must look at by hand.
          warn(
            `failed to roll back ${done.changelogPath}: ${(restoreError as Error).message}`,
          );
        }
      }
      // The summary written above described entries that no longer exist on
      // disk, so reduce it to the entries that genuinely remain committed.
      writeSummary(skippedSummaryParts);
      fail(
        args.failureOutput,
        `failed to write changelog entries: ${(e as Error).message}`,
      );
      return;
    }

    for (const w of plannedWrites) {
      written.push(join(w.bump.path, "CHANGELOG.md"));
    }
  } else if (!writeSummary(skippedSummaryParts)) {
    fail(args.failureOutput, "failed to write summary file");
    return;
  }

  console.log(JSON.stringify({ written, skipped }, null, 2));
}

// Guarded so tests can import the pure functions without running main().
if (
  process.argv[1] &&
  process.argv[1].endsWith("generate-changelog-entries.ts")
) {
  main().catch((e) => {
    warn(`unexpected error: ${(e as Error).message}`);
    const idx = process.argv.indexOf("--failure-output");
    const givenFailure = idx !== -1 ? process.argv[idx + 1] : undefined;
    if (givenFailure) {
      try {
        writeFileSync(
          givenFailure,
          `unexpected error: ${(e as Error).message}\n`,
          "utf8",
        );
      } catch {
        /* nothing left to do */
      }
    }
    // Never propagate non-zero — the release must stay mergeable.
    process.exit(0);
  });
}
