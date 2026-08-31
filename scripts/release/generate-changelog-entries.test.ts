import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPrompt,
  collectHistory,
  demoteFragmentHeadings,
  findVersionEntry,
  formatCommits,
  hasUnclosedFence,
  hasVersionEntry,
  isValidBump,
  MAX_SUMMARY_CHARS,
  nestedPathExcludes,
  parseModelOutput,
  scanChangelogLines,
  renderEntry,
  upsertEntry,
  type Bump,
  type ModelEntry,
} from "./generate-changelog-entries.ts";

const SCRIPT = join(
  process.cwd(),
  "scripts/release/generate-changelog-entries.ts",
);

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "changelog-entries-"));
}

function gitRunner(dir: string): (...args: string[]) => string {
  return (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

// Every fixture repo must be hermetic. Identity alone is not enough: a
// developer (or CI image) with commit.gpgsign=true globally would make every
// commit here invoke GPG and fail, and an ambient init.defaultBranch changes
// the branch name these tests reason about.
function initFixtureRepo(dir: string): void {
  const git = gitRunner(dir);
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgSign", "false");
}

// Starts a local stand-in for the Anthropic API. Rejects if `listen` fails
// (rather than leaving a promise pending forever) and always resolves its
// close, so a fixture directory can never leak because cleanup hung.
async function startServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const http = await import("node:http");
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as { port: number };
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function bump(overrides: Partial<Bump> = {}): Bump {
  return {
    scope: "integration-mastra",
    name: "@ag-ui/mastra",
    path: "integrations/mastra",
    file: "integrations/mastra/package.json",
    ecosystem: "typescript",
    oldVersion: "0.1.0",
    newVersion: "0.2.0",
    ...overrides,
  };
}

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: "@ag-ui/mastra",
    notes: "- Added streaming tool results.",
    breaking: "",
    ...overrides,
  };
}

// --- renderEntry -----------------------------------------------------------

test("renderEntry always carries a Breaking changes section, 'None.' when empty", () => {
  const text = renderEntry("0.2.0", "2026-08-24", entry());
  assert.match(text, /^## 0\.2\.0 — 2026-08-24$/m);
  assert.match(text, /^### Breaking changes$/m);
  assert.match(text, /None\./);
});

test("renderEntry keeps a non-empty breaking section verbatim", () => {
  const text = renderEntry(
    "0.2.0",
    "2026-08-24",
    entry({ breaking: "- `runAgent` now throws on unknown events." }),
  );
  assert.match(text, /runAgent.*throws on unknown events/);
  assert.doesNotMatch(text, /None\./);
});

// --- upsertEntry / hasVersionEntry -----------------------------------------

test("upsertEntry creates a new file with the standard header", () => {
  const text = renderEntry("0.2.0", "2026-08-24", entry());
  const { content, action } = upsertEntry(undefined, "0.2.0", text);
  assert.equal(action, "written");
  assert.match(content, /^# Changelog/);
  assert.match(content, /## 0\.2\.0 — 2026-08-24/);
});

test("upsertEntry prepends before existing entries and preserves them byte for byte", () => {
  const old = upsertEntry(
    undefined,
    "0.1.0",
    renderEntry("0.1.0", "2026-07-01", entry({ notes: "- Old release." })),
  ).content;
  const { content, action } = upsertEntry(
    old,
    "0.2.0",
    renderEntry("0.2.0", "2026-08-24", entry()),
  );
  assert.equal(action, "written");
  const idxNew = content.indexOf("## 0.2.0");
  const idxOld = content.indexOf("## 0.1.0");
  assert.ok(idxNew !== -1 && idxOld !== -1 && idxNew < idxOld, "newest first");
  assert.ok(content.includes("- Old release."), "prior entry preserved");
});

test("upsertEntry skips when the version already has an entry (human edits survive)", () => {
  const edited = upsertEntry(
    undefined,
    "0.2.0",
    renderEntry(
      "0.2.0",
      "2026-08-24",
      entry({ notes: "- Hand-tuned by a human." }),
    ),
  ).content;
  const { content, action } = upsertEntry(
    edited,
    "0.2.0",
    renderEntry("0.2.0", "2026-08-24", entry({ notes: "- Regenerated." })),
  );
  assert.equal(action, "skipped");
  assert.equal(content, edited);
});

test("upsertEntry keeps an Unreleased section on top (ADK changelog layout)", () => {
  const adkStyle = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- Pending, not yet released.",
    "",
    "## [0.7.0] - 2026-08-01",
    "",
    "- Previous release.",
    "",
  ].join("\n");
  const { content, action } = upsertEntry(
    adkStyle,
    "0.8.0",
    renderEntry("0.8.0", "2026-08-24", entry({ notes: "- New release." })),
  );
  assert.equal(action, "written");
  const unreleasedIdx = content.indexOf("## [Unreleased]");
  const newIdx = content.indexOf("## 0.8.0");
  const prevIdx = content.indexOf("## [0.7.0]");
  assert.ok(
    unreleasedIdx < newIdx && newIdx < prevIdx,
    "order must be Unreleased, then the new entry, then prior releases",
  );
  assert.match(content, /Pending, not yet released/);

  // Only an Unreleased section: the entry lands after it, not above it.
  const onlyUnreleased = "# Changelog\n\n## [Unreleased]\n\n- Pending.\n";
  const res = upsertEntry(
    onlyUnreleased,
    "0.1.0",
    renderEntry("0.1.0", "2026-08-24", entry()),
  );
  assert.ok(
    res.content.indexOf("## [Unreleased]") < res.content.indexOf("## 0.1.0"),
  );
});

test("hasVersionEntry recognizes Keep-a-Changelog bracketed headings", () => {
  const keepAChangelog =
    "# Changelog\n\n## [0.7.0] - 2026-08-01\n\n- Hand-maintained entry.\n";
  assert.equal(hasVersionEntry(keepAChangelog, "0.7.0"), true);
  assert.equal(hasVersionEntry(keepAChangelog, "0.7"), false);
});

test("hasVersionEntry does not match a longer version sharing a prefix", () => {
  const content = upsertEntry(
    undefined,
    "0.2.10",
    renderEntry("0.2.10", "2026-08-24", entry()),
  ).content;
  assert.equal(hasVersionEntry(content, "0.2.1"), false);
  assert.equal(hasVersionEntry(content, "0.2.10"), true);
});

test("fenced '## ' lines are content, not headings, across all operations", () => {
  // A fenced example ABOVE the real entry, using both fence markers, plus a
  // fenced heading INSIDE the entry body.
  const content = [
    "# Changelog",
    "",
    "```md",
    "## 9.9.9 — how a heading looks",
    "```",
    "",
    "## 0.2.0 — 2026-08-24",
    "",
    "- Real entry.",
    "",
    "~~~",
    "## Example inside tilde fence",
    "~~~",
    "",
    "### Breaking changes",
    "",
    "None.",
    "",
    "## 0.1.0 — 2026-07-01",
    "",
    "- Older entry.",
    "",
  ].join("\n");

  // The fenced 9.9.9 heading must not register as an entry.
  assert.equal(hasVersionEntry(content, "9.9.9"), false);
  // The real entry's body survives the tilde-fenced heading intact.
  const body = findVersionEntry(content, "0.2.0");
  assert.ok(body !== null);
  assert.match(body!, /Example inside tilde fence/);
  assert.match(body!, /### Breaking changes/);
  assert.doesNotMatch(body!, /Older entry/);
  // upsertEntry must insert before the first REAL heading (0.2.0), not
  // before the fenced 9.9.9 line.
  const { content: updated } = upsertEntry(
    content,
    "0.3.0",
    renderEntry("0.3.0", "2026-08-25", entry({ notes: "- Newest." })),
  );
  const fencedIdx = updated.indexOf("## 9.9.9");
  const newIdx = updated.indexOf("## 0.3.0");
  const realIdx = updated.indexOf("## 0.2.0");
  assert.ok(
    fencedIdx < newIdx && newIdx < realIdx,
    "inserted between fence and real entry",
  );
});

test("fence tracking follows CommonMark on delimiter length and closers", () => {
  // A four-backtick block is the only way to show a three-backtick example.
  // Collapsing fences to three characters would treat the inner ``` as a real
  // closer, so the literal "## " line below would read as a version boundary
  // and truncate the entry — before Breaking changes.
  const nested = [
    "# Changelog",
    "",
    "## 0.2.0 — 2026-08-24",
    "",
    "````md",
    "```",
    "## Not a heading — inside the four-backtick block",
    "````",
    "",
    "### Breaking changes",
    "",
    "None.",
    "",
  ].join("\n");
  const nestedBody = findVersionEntry(nested, "0.2.0");
  assert.ok(nestedBody !== null);
  assert.match(nestedBody!, /### Breaking changes/);
  assert.equal(
    scanChangelogLines(nested).filter((l) => l.isHeading).length,
    1,
    "only the version heading is structural",
  );

  // Same, with tildes.
  const tildes = [
    "## 0.2.0 — 2026-08-24",
    "",
    "~~~~md",
    "~~~",
    "## Not a heading — inside the four-tilde block",
    "~~~~",
    "",
    "### Breaking changes",
    "",
  ].join("\n");
  assert.match(findVersionEntry(tildes, "0.2.0")!, /### Breaking changes/);

  // An info string is legal on an opener but never on a closer, so "```js"
  // must not close the block early.
  const suffixed = [
    "## 0.2.0 — 2026-08-24",
    "",
    "```md",
    "```js",
    "## Not a heading — the ```js line is content",
    "```",
    "",
    "### Breaking changes",
    "",
  ].join("\n");
  assert.match(findVersionEntry(suffixed, "0.2.0")!, /### Breaking changes/);

  // A closer may carry trailing whitespace, and an opener may be indented up
  // to three spaces — beyond that it is indented code, not a fence.
  assert.equal(hasUnclosedFence("   ```\nx\n```   "), false);
  assert.equal(hasUnclosedFence("    ```\nx"), false);

  // A longer closer is valid; a shorter one is not.
  assert.equal(hasUnclosedFence("```\nx\n`````"), false);
  assert.equal(hasUnclosedFence("````\nx\n```"), true);
  assert.equal(hasUnclosedFence("~~~~\nx\n~~~"), true);

  // Fenced content is still left alone when demoting, whatever the fence width.
  const demoted = demoteFragmentHeadings("````md\n# inside\n````\n# outside");
  assert.equal(demoted, "````md\n# inside\n````\n#### outside");
});

// The mirror of the cases above. A backtick fence's info string may not contain
// a backtick, so such a line is ordinary text. Treating it as an opener starts a
// block that never closes, which swallows the NEXT version's heading — the entry
// then OVER-RUNS to end of file instead of truncating, carrying older releases'
// notes into this one.
test("a backtick in a backtick fence's info string does not open a fence", () => {
  const content = [
    "# Changelog",
    "",
    "## 0.2.0 — 2026-08-24",
    "",
    "current",
    "```lang`bad",
    "literal",
    "## 0.1.0 — 2026-07-01",
    "",
    "- Older entry.",
    "",
  ].join("\n");

  // The 0.1.0 heading is structural, so it ends the 0.2.0 entry.
  const body = findVersionEntry(content, "0.2.0");
  assert.ok(body !== null);
  assert.match(body!, /current/);
  assert.match(body!, /literal/);
  assert.doesNotMatch(body!, /Older entry/);
  assert.doesNotMatch(body!, /## 0\.1\.0/);
  assert.equal(
    scanChangelogLines(content).filter((l) => l.isHeading).length,
    2,
    "both version headings stay structural",
  );

  // Such a line neither opens nor closes anything...
  assert.equal(hasUnclosedFence("```lang`bad\nliteral"), false);
  // ...but the restriction is backtick-only: a tilde fence's info string may
  // contain one, so this DOES open a block, left dangling here.
  assert.equal(hasUnclosedFence("~~~lang`ok\nliteral"), true);
  assert.equal(hasUnclosedFence("~~~lang`ok\nliteral\n~~~"), false);
  // A plain info string still opens a backtick fence.
  assert.equal(hasUnclosedFence("```lang\nliteral"), true);

  // And demotion leaves the text alone rather than shielding it as code.
  assert.equal(
    demoteFragmentHeadings("```lang`bad\n# outside"),
    "```lang`bad\n#### outside",
  );
});

// --- formatCommits / buildPrompt -------------------------------------------

test("formatCommits drops release bookkeeping commits and keeps bodies", () => {
  const raw = [
    "feat: add resume support\nCarries inbound framework context.\x1e",
    "chore(release): bump integration-mastra (@ag-ui/mastra@0.2.0)\n\x1e",
    "fix: stop dropping metadata\n\x1e",
  ].join("\n");
  const { commits, truncated } = formatCommits(raw);
  assert.equal(commits.length, 2);
  assert.equal(truncated, false);
  assert.match(commits[0], /add resume support/);
  assert.match(commits[0], /Carries inbound framework context/);
  assert.match(commits[1], /stop dropping metadata/);
});

test("formatCommits reports truncation, and collectHistory discloses it", () => {
  // 101 real commits: one over the cap, so the oldest is dropped.
  const raw = Array.from(
    { length: 101 },
    (_, i) => `fix: change number ${i}\n\x1e`,
  ).join("\n");
  const { commits, truncated } = formatCommits(raw);
  assert.equal(commits.length, 100);
  assert.equal(truncated, true, "dropping commits must be reported");

  const dir = mkTmp();
  try {
    const git = gitRunner(dir);
    initFixtureRepo(dir);
    mkdirSync(join(dir, "integrations/mastra"), { recursive: true });
    // Tag first, so the 101 commits below all fall inside the tagged range
    // where the 100-commit cap (not the fallback's own limit) applies.
    writeFileSync(join(dir, "integrations/mastra/index.ts"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "feat: base");
    git("tag", "@ag-ui/mastra@0.1.0");
    for (let i = 0; i < 101; i++) {
      writeFileSync(join(dir, "integrations/mastra/index.ts"), `${i}\n`);
      git("add", "-A");
      git("commit", "-qm", `fix: change number ${i}`);
    }
    const history = collectHistory(dir, bump());
    assert.match(
      history.rangeNote,
      /newest 100 commits/,
      "a silently truncated history can make the model report no changes",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatCommits truncates bodies on code-point boundaries", () => {
  // 399 ASCII characters + an astral emoji: a UTF-16 slice at 400 would keep
  // a lone high surrogate and send a malformed scalar to the API.
  const body = "a".repeat(399) + "😀";
  const { commits } = formatCommits(`feat: emoji body\n${body}\n\x1e`);
  const rendered = commits[0];
  assert.equal(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(rendered),
    false,
    "no unpaired high surrogate may survive truncation",
  );
  assert.equal(rendered, JSON.parse(JSON.stringify(rendered)));
});

test("buildPrompt includes per-package history and demands strict JSON", () => {
  const prompt = buildPrompt([
    {
      bump: bump(),
      commits: ["- feat: add resume support"],
      rangeNote: "changes since @ag-ui/mastra@0.1.0",
    },
  ]);
  assert.match(prompt, /^Package: @ag-ui\/mastra$/m);
  assert.match(prompt, /^Version: 0\.1\.0 -> 0\.2\.0$/m);
  assert.match(prompt, /add resume support/);
  assert.match(prompt, /ONLY a JSON object/);
});

// --- parseModelOutput --------------------------------------------------------

test("parseModelOutput accepts bare JSON and code-fenced JSON", () => {
  const payload = JSON.stringify({
    entries: [{ name: "@ag-ui/mastra", notes: "- x", breaking: "" }],
  });
  for (const text of [payload, "```json\n" + payload + "\n```"]) {
    const entries = parseModelOutput(text, ["@ag-ui/mastra"]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "@ag-ui/mastra");
  }
});

test("parseModelOutput tolerates a name decorated with an ecosystem suffix", () => {
  const payload = JSON.stringify({
    entries: [{ name: "ag_ui_strands (python)", notes: "- x", breaking: "" }],
  });
  const entries = parseModelOutput(payload, ["ag_ui_strands"]);
  assert.equal(entries.length, 1);
  assert.match(entries[0].notes, /x/);
});

test("parseModelOutput fails when a package is missing", () => {
  const payload = JSON.stringify({
    entries: [{ name: "@ag-ui/mastra", notes: "- x", breaking: "" }],
  });
  assert.throws(
    () => parseModelOutput(payload, ["@ag-ui/mastra", "@ag-ui/agno"]),
    /missing entries for: @ag-ui\/agno/,
  );
});

test("parseModelOutput rejects duplicate entries for one package", () => {
  // Last-write-wins would keep the entry that reports NO breaking change and
  // discard the one that does — losing the warning this feature exists for.
  const payload = JSON.stringify({
    entries: [
      {
        name: "@ag-ui/mastra",
        notes: "- Renamed runAgent.",
        breaking: "- runAgent is now run().",
      },
      { name: "@ag-ui/mastra", notes: "- Minor tidy.", breaking: "" },
    ],
  });
  assert.throws(
    () => parseModelOutput(payload, ["@ag-ui/mastra"]),
    /more than one entry named/,
  );
});

test("parseModelOutput rejects an ambiguous suffixed name", () => {
  const payload = JSON.stringify({
    entries: [
      { name: "ag_ui_strands (python)", notes: "- a", breaking: "" },
      { name: "ag_ui_strands (py)", notes: "- b", breaking: "" },
    ],
  });
  assert.throws(
    () => parseModelOutput(payload, ["ag_ui_strands"]),
    /multiple candidate entries/,
  );
});

test("parseModelOutput rejects an exact name duplicated by a suffixed one", () => {
  // Returning the exact match early would ignore the suffixed entry — and
  // here that is the one carrying the breaking change.
  const payload = JSON.stringify({
    entries: [
      { name: "@ag-ui/mastra", notes: "- Minor tidy.", breaking: "" },
      {
        name: "@ag-ui/mastra (typescript)",
        notes: "- Renamed runAgent.",
        breaking: "- runAgent is now run().",
      },
    ],
  });
  assert.throws(
    () => parseModelOutput(payload, ["@ag-ui/mastra"]),
    /multiple candidate entries/,
  );
});

test("parseModelOutput rejects empty notes and unclosed fences", () => {
  const empty = JSON.stringify({
    entries: [{ name: "p", notes: "   \n ", breaking: "" }],
  });
  assert.throws(() => parseModelOutput(empty, ["p"]), /empty notes/);

  // An unclosed fence would swallow the rest of the CHANGELOG once embedded,
  // hiding both this entry's tail and the NEXT version's heading.
  const unclosed = JSON.stringify({
    entries: [{ name: "p", notes: "- ok\n\n```md\n## dangling", breaking: "" }],
  });
  assert.throws(() => parseModelOutput(unclosed, ["p"]), /unclosed code fence/);

  const unclosedBreaking = JSON.stringify({
    entries: [{ name: "p", notes: "- ok", breaking: "~~~\nstill open" }],
  });
  assert.throws(
    () => parseModelOutput(unclosedBreaking, ["p"]),
    /unclosed code fence in breaking/,
  );
});

test("renderEntry demotes model headings that would form an entry boundary", () => {
  const text = renderEntry(
    "0.2.0",
    "2026-08-24",
    entry({
      notes: "- One.\n\n## Migration\n\n# Top\n\n```md\n## Sample\n```",
      breaking: "## Removed API",
    }),
  );
  // Exactly one boundary-forming heading may exist: the version heading.
  const boundaries = scanChangelogLines(text).filter((l) => l.isHeading);
  assert.equal(boundaries.length, 1);
  assert.match(boundaries[0].text, /^## 0\.2\.0 —/);
  // Content is preserved, just demoted...
  assert.match(text, /^#### Migration$/m);
  assert.match(text, /^#### Top$/m);
  assert.match(text, /^#### Removed API$/m);
  // ...and fenced samples are left exactly as written.
  assert.match(text, /^## Sample$/m);
});

test("demoteFragmentHeadings is idempotent", () => {
  const once = demoteFragmentHeadings("## A\n\n# B");
  assert.equal(demoteFragmentHeadings(once), once);
});

test("hasUnclosedFence distinguishes balanced from dangling fences", () => {
  assert.equal(hasUnclosedFence("```\nx\n```"), false);
  assert.equal(hasUnclosedFence("~~~\nx\n~~~"), false);
  assert.equal(hasUnclosedFence("```\nx"), true);
  // A tilde line does not close a backtick fence.
  assert.equal(hasUnclosedFence("```\nx\n~~~"), true);
});

test("isValidBump requires every declared field", () => {
  const complete = bump();
  assert.equal(isValidBump(complete), true);
  for (const field of [
    "scope",
    "name",
    "path",
    "file",
    "ecosystem",
    "oldVersion",
    "newVersion",
  ]) {
    const partial: Record<string, unknown> = { ...complete };
    delete partial[field];
    assert.equal(
      isValidBump(partial),
      false,
      `a bump without ${field} must not pass a predicate asserting it is a Bump`,
    );
  }
});

test("parseModelOutput fails on non-JSON and malformed entries", () => {
  assert.throws(
    () => parseModelOutput("here you go!", ["x"]),
    /not valid JSON/,
  );
  assert.throws(
    () => parseModelOutput(JSON.stringify({ entries: [{ name: "x" }] }), ["x"]),
    /malformed/,
  );
});

// --- collectHistory against a real throwaway git repo ------------------------

test("collectHistory uses the last release tag range and excludes bookkeeping", () => {
  const dir = mkTmp();
  try {
    const git = gitRunner(dir);
    initFixtureRepo(dir);
    mkdirSync(join(dir, "integrations/mastra"), { recursive: true });
    writeFileSync(join(dir, "integrations/mastra/index.ts"), "1\n");
    git("add", "-A");
    git("commit", "-qm", "feat: initial mastra integration");
    git("tag", "@ag-ui/mastra@0.1.0");
    writeFileSync(join(dir, "integrations/mastra/index.ts"), "2\n");
    git("add", "-A");
    git("commit", "-qm", "fix: forward tool call results");
    writeFileSync(join(dir, "integrations/mastra/package.json"), "{}\n");
    git("add", "-A");
    git("commit", "-qm", "chore(release): bump integration-mastra");

    const history = collectHistory(dir, bump());
    assert.match(history.rangeNote, /since @ag-ui\/mastra@0\.1\.0/);
    assert.equal(history.commits.length, 1);
    assert.match(history.commits[0], /forward tool call results/);
    assert.doesNotMatch(history.commits.join("\n"), /initial mastra/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectHistory excludes a configured package path nested inside another's", () => {
  const dir = mkTmp();
  try {
    const git = gitRunner(dir);
    initFixtureRepo(dir);
    // Mirrors sdk-py vs sdk-py-a2ui-toolkit: the toolkit path nests inside
    // the protocol package's path but versions independently.
    mkdirSync(join(dir, "scripts/release"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/release/release.config.json"),
      JSON.stringify({
        scopes: {
          "sdk-py": {
            packages: [
              {
                name: "ag-ui-protocol",
                path: "sdks/python",
                ecosystem: "python",
              },
            ],
          },
          "sdk-py-a2ui-toolkit": {
            packages: [
              {
                name: "ag-ui-a2ui-toolkit",
                path: "sdks/python/a2ui_toolkit",
                ecosystem: "python",
              },
            ],
          },
        },
      }),
    );
    mkdirSync(join(dir, "sdks/python/a2ui_toolkit"), { recursive: true });
    writeFileSync(join(dir, "sdks/python/core.py"), "1\n");
    git("add", "-A");
    git("commit", "-qm", "feat: protocol change");
    writeFileSync(join(dir, "sdks/python/a2ui_toolkit/toolkit.py"), "1\n");
    git("add", "-A");
    git("commit", "-qm", "feat: toolkit-only change");

    const history = collectHistory(
      dir,
      bump({
        name: "ag-ui-protocol",
        path: "sdks/python",
        oldVersion: "(new)",
      }),
    );
    assert.match(history.commits.join("\n"), /protocol change/);
    assert.doesNotMatch(history.commits.join("\n"), /toolkit-only change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nestedPathExcludes only excludes strict children of the package path", () => {
  const all = [
    "sdks/python",
    "sdks/python/a2ui_toolkit",
    "sdks/python-other",
    "integrations/mastra",
  ];
  assert.deepEqual(nestedPathExcludes(all, "sdks/python"), [
    ":(exclude)sdks/python/a2ui_toolkit",
  ]);
  assert.deepEqual(nestedPathExcludes(all, "integrations/mastra"), []);
});

test("collectHistory falls back to recent commits when the tag is missing", () => {
  const dir = mkTmp();
  try {
    const git = gitRunner(dir);
    initFixtureRepo(dir);
    mkdirSync(join(dir, "integrations/mastra"), { recursive: true });
    writeFileSync(join(dir, "integrations/mastra/index.ts"), "1\n");
    git("add", "-A");
    git("commit", "-qm", "feat: initial mastra integration");

    const history = collectHistory(dir, bump({ oldVersion: "(new)" }));
    assert.match(history.rangeNote, /not found|approximate/);
    assert.equal(history.commits.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- end-to-end through the CLI with a mock Anthropic server ------------------

type RunResult = { status: number; stdout: string; stderr: string };

function runScript(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", SCRIPT, ...args], {
      cwd: process.cwd(),
      // ANTHROPIC_API_KEY is cleared unless a case sets it: inheriting a real
      // key from the developer's environment would let a test that must not
      // reach the network quietly call the live API.
      env: { ...process.env, ANTHROPIC_API_KEY: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // A child that outlives the test would otherwise be orphaned, holding its
    // fixture directory open after cleanup.
    const kill = setTimeout(() => child.kill("SIGKILL"), 45_000);
    kill.unref?.();
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => {
      clearTimeout(kill);
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(kill);
      resolve({ status: status ?? -1, stdout, stderr });
    });
  });
}

function setupFixtureRepo(dir: string): void {
  const git = gitRunner(dir);
  initFixtureRepo(dir);
  mkdirSync(join(dir, "integrations/mastra"), { recursive: true });
  writeFileSync(join(dir, "integrations/mastra/index.ts"), "1\n");
  git("add", "-A");
  git("commit", "-qm", "feat: initial mastra integration");
  git("tag", "@ag-ui/mastra@0.1.0");
  writeFileSync(join(dir, "integrations/mastra/index.ts"), "2\n");
  git("add", "-A");
  git("commit", "-qm", "fix: forward tool call results");
}

test(
  "sends exactly one correctly-formed request covering every pending package",
  { timeout: 60_000 },
  async () => {
    const dir = mkTmp();
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      setupFixtureRepo(dir);
      // A second package, so "one call per run" is actually observable.
      mkdirSync(join(dir, "integrations/agno"), { recursive: true });
      writeFileSync(join(dir, "integrations/agno/index.ts"), "1\n");
      const git = gitRunner(dir);
      git("add", "-A");
      git("commit", "-qm", "feat: agno streaming support");

      const accumulated = join(dir, "accumulated.json");
      writeFileSync(
        accumulated,
        JSON.stringify([
          bump(),
          bump({
            name: "@ag-ui/agno",
            path: "integrations/agno",
            oldVersion: "(new)",
            newVersion: "0.1.0",
          }),
        ]),
      );

      // Capture what the script actually sends. Without these assertions a
      // regression to the model id, endpoint, method, or headers stays green —
      // which is exactly how the predecessor script 404'd for months.
      const seen: Array<{
        method: string;
        url: string;
        headers: Record<string, string | string[] | undefined>;
        body: string;
      }> = [];
      server = await startServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seen.push({
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers,
            body,
          });
          const modelJson = JSON.stringify({
            entries: [
              { name: "@ag-ui/mastra", notes: "- Mastra note.", breaking: "" },
              { name: "@ag-ui/agno", notes: "- Agno note.", breaking: "" },
            ],
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ content: [{ type: "text", text: modelJson }] }),
          );
        });
      });

      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          join(dir, "summary.md"),
          "--failure-output",
          join(dir, "failure.txt"),
          "--repo-root",
          dir,
          "--date",
          "2026-08-24",
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}/`,
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(seen.length, 1, "exactly one Anthropic call per run");
      const [call] = seen;
      assert.equal(call.method, "POST");
      assert.equal(call.url, "/v1/messages");
      assert.equal(call.headers["x-api-key"], "sk-test-mock");
      assert.equal(call.headers["anthropic-version"], "2023-06-01");
      assert.equal(call.headers["content-type"], "application/json");
      const payload = JSON.parse(call.body);
      assert.equal(payload.model, "claude-opus-4-8");
      assert.ok(payload.max_tokens > 0);
      assert.equal(payload.messages.length, 1);
      assert.equal(payload.messages[0].role, "user");
      // Both packages' histories must be in the single prompt.
      const prompt = payload.messages[0].content;
      assert.match(prompt, /Package: @ag-ui\/mastra/);
      assert.match(prompt, /Package: @ag-ui\/agno/);
      assert.match(prompt, /forward tool call results/);
      assert.match(prompt, /agno streaming support/);
    } finally {
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "the real generator output survives the real Python extractor",
  { timeout: 60_000 },
  async () => {
    // Cross-language contract. Both sides were previously tested only against
    // hand-written fixtures, so a heading emitted by renderEntry that the
    // extractor treats as an entry boundary went unnoticed: the file was
    // complete but publication silently dropped everything after it.
    const dir = mkTmp();
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      setupFixtureRepo(dir);
      mkdirSync(join(dir, "scripts/release"), { recursive: true });
      writeFileSync(
        join(dir, "scripts/release/release.config.json"),
        JSON.stringify({
          scopes: {
            "integration-mastra": {
              packages: [
                {
                  name: "@ag-ui/mastra",
                  path: "integrations/mastra",
                  ecosystem: "typescript",
                },
              ],
            },
          },
        }),
      );
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(accumulated, JSON.stringify([bump()]));

      // Model output that WOULD form a boundary if embedded unchanged.
      server = await startServer((_req, res) => {
        const modelJson = JSON.stringify({
          entries: [
            {
              name: "@ag-ui/mastra",
              notes:
                "- First bullet.\n\n## Migration\n\n- Required step.\n\n```md\n## Fenced sample stays put\n```",
              breaking: "- Callers must re-verify tool results.",
            },
          ],
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ content: [{ type: "text", text: modelJson }] }),
        );
      });

      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          join(dir, "summary.md"),
          "--failure-output",
          join(dir, "failure.txt"),
          "--repo-root",
          dir,
          "--date",
          "2026-08-24",
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}/`,
        },
      );
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      // Now read it back with the REAL publish-side extractor.
      const extracted = spawnSync(
        "python3",
        [
          join(process.cwd(), "scripts/release/extract-changelog-entry.py"),
          "@ag-ui/mastra",
          "0.2.0",
          "--demote",
          "2",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, AGUI_RELEASE_REPO_ROOT: dir },
        },
      );
      assert.equal(extracted.status, 0, extracted.stderr);
      // Everything the model wrote must survive the round trip.
      assert.match(extracted.stdout, /First bullet\./);
      assert.match(extracted.stdout, /Migration/);
      assert.match(extracted.stdout, /Required step\./);
      assert.match(extracted.stdout, /Callers must re-verify tool results\./);
      assert.match(extracted.stdout, /Fenced sample stays put/);
      // And the fenced sample must NOT have been demoted as if it were prose.
      assert.match(extracted.stdout, /^## Fenced sample stays put$/m);
    } finally {
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "writes CHANGELOG.md, summary and result JSON on model success",
  { timeout: 60_000 },
  async () => {
    const http = await import("node:http");
    const dir = mkTmp();
    let server: import("node:http").Server | undefined;
    try {
      setupFixtureRepo(dir);
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(accumulated, JSON.stringify([bump()]));

      server = http.createServer((_req, res) => {
        const modelJson = JSON.stringify({
          entries: [
            {
              name: "@ag-ui/mastra",
              notes: "- Forwarded tool call results to the client.",
              breaking: "",
            },
          ],
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ content: [{ type: "text", text: modelJson }] }),
        );
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      const summary = join(dir, "summary.md");
      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          summary,
          "--failure-output",
          failure,
          "--repo-root",
          dir,
          "--date",
          "2026-08-24",
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/`,
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(existsSync(failure), false, "no failure file on success");

      const changelog = readFileSync(
        join(dir, "integrations/mastra/CHANGELOG.md"),
        "utf8",
      );
      assert.match(changelog, /## 0\.2\.0 — 2026-08-24/);
      assert.match(changelog, /Forwarded tool call results/);
      assert.match(changelog, /### Breaking changes\n\nNone\./);

      const summaryText = readFileSync(summary, "utf8");
      assert.match(summaryText, /@ag-ui\/mastra 0\.1\.0 → 0\.2\.0/);

      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed.written, ["integrations/mastra/CHANGELOG.md"]);
      assert.deepEqual(parsed.skipped, []);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "exits 0, writes failure file and NO changelog on API error",
  { timeout: 60_000 },
  async () => {
    const http = await import("node:http");
    const dir = mkTmp();
    let server: import("node:http").Server | undefined;
    try {
      setupFixtureRepo(dir);
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(accumulated, JSON.stringify([bump()]));

      server = http.createServer((_req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "not_found_error", message: "model: nope" },
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      const summary = join(dir, "summary.md");
      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          summary,
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/`,
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(existsSync(failure), "failure file must exist");
      const reason = readFileSync(failure, "utf8");
      assert.match(reason, /404|not_found/i);
      assert.equal(
        existsSync(join(dir, "integrations/mastra/CHANGELOG.md")),
        false,
        "no changelog may be written on failure",
      );
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "exits 0 and writes failure file when the connection drops mid-response",
  { timeout: 60_000 },
  async () => {
    const http = await import("node:http");
    const dir = mkTmp();
    let server: import("node:http").Server | undefined;
    try {
      setupFixtureRepo(dir);
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(accumulated, JSON.stringify([bump()]));

      // Send headers and a partial body, then kill the socket: the failure
      // surfaces on the response stream, not the request.
      server = http.createServer((_req, res) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": "1000000",
        });
        res.write('{"content":[{"type":"text","text":"partial');
        setTimeout(() => res.destroy(), 50);
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          join(dir, "summary.md"),
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/`,
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(existsSync(failure), "failure file must exist");
      assert.match(
        readFileSync(failure, "utf8"),
        /stream failed|aborted|socket|ECONNRESET/i,
      );
      assert.equal(
        existsSync(join(dir, "integrations/mastra/CHANGELOG.md")),
        false,
        "no changelog may be written on a truncated response",
      );
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "exits 0 and writes failure file when ANTHROPIC_API_KEY is missing",
  { timeout: 60_000 },
  async () => {
    const dir = mkTmp();
    try {
      setupFixtureRepo(dir);
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(accumulated, JSON.stringify([bump()]));
      const failure = join(dir, "failure.txt");

      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          join(dir, "summary.md"),
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        { ANTHROPIC_API_KEY: "" },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(readFileSync(failure, "utf8"), /ANTHROPIC_API_KEY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a first-scope failure leaves a ZERO-byte summary, not a lone newline",
  { timeout: 60_000 },
  async () => {
    // The workflow gates its "rendered from the committed CHANGELOG.md
    // entries" preamble on `[ -s summary ]`, which a 1-byte file passes. A
    // newline-only summary therefore printed that claim above an empty
    // section on every first-scope failure.
    const dir = mkTmp();
    try {
      setupFixtureRepo(dir);
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(accumulated, JSON.stringify([bump()]));
      const summary = join(dir, "summary.md");
      const failure = join(dir, "failure.txt");

      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          summary,
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        { ANTHROPIC_API_KEY: "" }, // forces a failure with nothing skipped
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(existsSync(failure), "the failure must still be reported");
      assert.equal(
        readFileSync(summary, "utf8").length,
        0,
        "an empty summary must be zero bytes so `[ -s ]` reports false",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a missing API key on a stacked run still writes the summary for committed entries",
  { timeout: 60_000 },
  async () => {
    const dir = mkTmp();
    try {
      setupFixtureRepo(dir);
      writeFileSync(
        join(dir, "integrations/mastra/CHANGELOG.md"),
        "# Changelog\n\n## 0.2.0 — 2026-08-20\n\n- Committed by scope A.\n\n### Breaking changes\n\nNone.\n",
      );
      mkdirSync(join(dir, "integrations/agno"), { recursive: true });
      writeFileSync(join(dir, "integrations/agno/index.ts"), "1\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "feat: agno change"], { cwd: dir });
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(
        accumulated,
        JSON.stringify([
          bump(),
          bump({
            name: "@ag-ui/agno",
            path: "integrations/agno",
            oldVersion: "(new)",
            newVersion: "0.1.0",
          }),
        ]),
      );

      const summary = join(dir, "summary.md");
      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          summary,
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        { ANTHROPIC_API_KEY: "" },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(readFileSync(failure, "utf8"), /ANTHROPIC_API_KEY/);
      assert.match(readFileSync(summary, "utf8"), /Committed by scope A/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a later-scope failure still writes the summary for already-committed entries",
  { timeout: 60_000 },
  async () => {
    const http = await import("node:http");
    const dir = mkTmp();
    let server: import("node:http").Server | undefined;
    try {
      setupFixtureRepo(dir);
      // Scope A's entry is already committed (earlier stacking run)...
      writeFileSync(
        join(dir, "integrations/mastra/CHANGELOG.md"),
        "# Changelog\n\n## 0.2.0 — 2026-08-20\n\n- Committed by scope A.\n\n### Breaking changes\n\nNone.\n",
      );
      // ...and scope B's package is pending, but generation fails.
      mkdirSync(join(dir, "integrations/agno"), { recursive: true });
      writeFileSync(join(dir, "integrations/agno/index.ts"), "1\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "feat: agno change"], { cwd: dir });
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(
        accumulated,
        JSON.stringify([
          bump(),
          bump({
            name: "@ag-ui/agno",
            path: "integrations/agno",
            oldVersion: "(new)",
            newVersion: "0.1.0",
          }),
        ]),
      );

      server = http.createServer((_req, res) => {
        res.writeHead(500);
        res.end("boom");
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      const summary = join(dir, "summary.md");
      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          summary,
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/`,
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(existsSync(failure), "failure file must exist");
      // The committed scope-A entry still reaches the PR body...
      assert.match(readFileSync(summary, "utf8"), /Committed by scope A/);
      // ...and the failed scope-B package gained no half-written changelog.
      assert.equal(
        existsSync(join(dir, "integrations/agno/CHANGELOG.md")),
        false,
      );
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a write failure on the second package rolls the first one back",
  {
    timeout: 60_000,
    // Root ignores the read-only bit, so the write would succeed and the test
    // would assert nothing.
    skip: process.getuid?.() === 0 ? "cannot test EACCES as root" : false,
  },
  async () => {
    const dir = mkTmp();
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      setupFixtureRepo(dir);
      const git = gitRunner(dir);
      mkdirSync(join(dir, "integrations/agno"), { recursive: true });
      writeFileSync(join(dir, "integrations/agno/index.ts"), "1\n");
      git("add", "-A");
      git("commit", "-qm", "feat: agno change");
      // Mastra has a pre-existing changelog whose content must be restored.
      const mastraChangelog = join(dir, "integrations/mastra/CHANGELOG.md");
      const original = "# Changelog\n\n## 0.1.0 — 2026-07-01\n\n- Older.\n";
      writeFileSync(mastraChangelog, original);
      // Agno's CHANGELOG.md is READ-ONLY: readable during classification, but
      // the write fails EACCES — failing the second write after the first has
      // already succeeded, which is the case the rollback exists for.
      const agnoChangelog = join(dir, "integrations/agno/CHANGELOG.md");
      writeFileSync(agnoChangelog, "# Changelog\n");
      chmodSync(agnoChangelog, 0o444);

      const accumulated = join(dir, "accumulated.json");
      writeFileSync(
        accumulated,
        JSON.stringify([
          bump(),
          bump({
            name: "@ag-ui/agno",
            path: "integrations/agno",
            oldVersion: "(new)",
            newVersion: "0.1.0",
          }),
        ]),
      );

      server = await startServer((_req, res) => {
        const modelJson = JSON.stringify({
          entries: [
            { name: "@ag-ui/mastra", notes: "- Mastra note.", breaking: "" },
            { name: "@ag-ui/agno", notes: "- Agno note.", breaking: "" },
          ],
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ content: [{ type: "text", text: modelJson }] }),
        );
      });

      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          join(dir, "summary.md"),
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}/`,
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(readFileSync(failure, "utf8"), /failed to write changelog/);
      // The documented contract is that a failed run modifies no changelog.
      assert.equal(
        readFileSync(mastraChangelog, "utf8"),
        original,
        "the first package's changelog must be rolled back",
      );
    } finally {
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "one malformed accumulated entry fails the run instead of silently dropping a package",
  { timeout: 60_000 },
  async () => {
    const dir = mkTmp();
    try {
      setupFixtureRepo(dir);
      const accumulated = join(dir, "accumulated.json");
      // Second entry is missing `file`. Skipping it would publish that
      // package with no notes and no warning anywhere.
      const valid = bump();
      const broken: Record<string, unknown> = {
        ...bump({ name: "@ag-ui/agno", path: "integrations/agno" }),
      };
      delete broken.file;
      writeFileSync(accumulated, JSON.stringify([valid, broken]));

      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          join(dir, "summary.md"),
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        { ANTHROPIC_API_KEY: "sk-test-mock" },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(readFileSync(failure, "utf8"), /malformed/);
      assert.equal(
        existsSync(join(dir, "integrations/mastra/CHANGELOG.md")),
        false,
        "no package may be written when the payload is untrustworthy",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a non-benign git failure is reported as such, not as a missing tag",
  { timeout: 60_000 },
  async () => {
    // repo-root is NOT a git repository, so `rev-parse` fails with status 128.
    // Treating that as "tag missing" would silently downgrade the package to
    // the approximate-range fallback and describe the wrong commits, so the
    // failure reason must name rev-parse rather than the later git log.
    const dir = mkTmp();
    try {
      mkdirSync(join(dir, "scripts/release"), { recursive: true });
      writeFileSync(
        join(dir, "scripts/release/release.config.json"),
        JSON.stringify({ scopes: {} }),
      );
      mkdirSync(join(dir, "integrations/mastra"), { recursive: true });
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(accumulated, JSON.stringify([bump()]));

      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          join(dir, "summary.md"),
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        { ANTHROPIC_API_KEY: "sk-test-mock" },
      );
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(readFileSync(failure, "utf8"), /git rev-parse for tag/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a malformed release.config.json fails instead of dropping nested excludes",
  { timeout: 60_000 },
  async () => {
    // Degrading to "no exclusions" would fold a nested package's commits into
    // its parent's entry and still report success.
    const dir = mkTmp();
    try {
      setupFixtureRepo(dir);
      mkdirSync(join(dir, "scripts/release"), { recursive: true });
      writeFileSync(
        join(dir, "scripts/release/release.config.json"),
        "{ not valid json",
      );
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(accumulated, JSON.stringify([bump()]));

      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          join(dir, "summary.md"),
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        { ANTHROPIC_API_KEY: "sk-test-mock" },
      );
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(readFileSync(failure, "utf8"), /release\.config\.json/);
      assert.equal(
        existsSync(join(dir, "integrations/mastra/CHANGELOG.md")),
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "an unreadable existing changelog fails cleanly and keeps committed entries in the summary",
  { timeout: 60_000 },
  async () => {
    const dir = mkTmp();
    try {
      setupFixtureRepo(dir);
      const git = gitRunner(dir);
      // Package A already has a committed entry for this version (skipped).
      writeFileSync(
        join(dir, "integrations/mastra/CHANGELOG.md"),
        "# Changelog\n\n## 0.2.0 — 2026-08-20\n\n- Committed by scope A.\n",
      );
      // Package B's CHANGELOG.md is a directory: it exists, so it is read, and
      // the read raises. Crashing here would skip the summary write entirely
      // and drop A's entry from the PR body.
      mkdirSync(join(dir, "integrations/agno"), { recursive: true });
      writeFileSync(join(dir, "integrations/agno/index.ts"), "1\n");
      git("add", "-A");
      git("commit", "-qm", "feat: agno change");
      mkdirSync(join(dir, "integrations/agno/CHANGELOG.md"), {
        recursive: true,
      });

      const accumulated = join(dir, "accumulated.json");
      writeFileSync(
        accumulated,
        JSON.stringify([
          bump(),
          bump({
            name: "@ag-ui/agno",
            path: "integrations/agno",
            oldVersion: "(new)",
            newVersion: "0.1.0",
          }),
        ]),
      );

      const summary = join(dir, "summary.md");
      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          summary,
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        { ANTHROPIC_API_KEY: "sk-test-mock" },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(
        readFileSync(failure, "utf8"),
        /cannot read existing changelog/,
      );
      assert.match(readFileSync(summary, "utf8"), /Committed by scope A/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "an unwritable summary path leaves every changelog untouched",
  { timeout: 60_000 },
  async () => {
    // The all-or-nothing contract covers this ordering: the summary is written
    // BEFORE any changelog, so failing to write it cannot leave changelogs
    // modified while the run reports failure.
    const dir = mkTmp();
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      setupFixtureRepo(dir);
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(accumulated, JSON.stringify([bump()]));
      // A directory where the summary file should go: writing it raises EISDIR.
      const summary = join(dir, "summary.md");
      mkdirSync(summary, { recursive: true });

      server = await startServer((_req, res) => {
        const modelJson = JSON.stringify({
          entries: [
            { name: "@ag-ui/mastra", notes: "- Mastra note.", breaking: "" },
          ],
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ content: [{ type: "text", text: modelJson }] }),
        );
      });

      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          summary,
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}/`,
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(readFileSync(failure, "utf8"), /summary/i);
      assert.equal(
        existsSync(join(dir, "integrations/mastra/CHANGELOG.md")),
        false,
        "no changelog may be written when the summary could not be written",
      );
    } finally {
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "the PR-body summary is bounded and says what it omitted",
  { timeout: 60_000 },
  async () => {
    const dir = mkTmp();
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      setupFixtureRepo(dir);
      const git = gitRunner(dir);
      // Eight packages with very long notes: unbounded, the summary would blow
      // GitHub's 65,536-character PR-body limit and the PR would 422 after the
      // version bumps were already pushed.
      const names: string[] = [];
      for (let i = 0; i < 8; i++) {
        const pkg = `pkg${i}`;
        names.push(pkg);
        mkdirSync(join(dir, `integrations/${pkg}`), { recursive: true });
        writeFileSync(join(dir, `integrations/${pkg}/index.ts`), "1\n");
      }
      git("add", "-A");
      git("commit", "-qm", "feat: many packages");

      const accumulated = join(dir, "accumulated.json");
      writeFileSync(
        accumulated,
        JSON.stringify(
          names.map((n) =>
            bump({
              name: n,
              path: `integrations/${n}`,
              oldVersion: "(new)",
              newVersion: "0.1.0",
            }),
          ),
        ),
      );

      const longNote = `- ${"x".repeat(9000)}`;
      server = await startServer((_req, res) => {
        const modelJson = JSON.stringify({
          entries: names.map((n) => ({
            name: n,
            notes: longNote,
            breaking: "",
          })),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ content: [{ type: "text", text: modelJson }] }),
        );
      });

      const summary = join(dir, "summary.md");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          summary,
          "--failure-output",
          join(dir, "failure.txt"),
          "--repo-root",
          dir,
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}/`,
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const text = readFileSync(summary, "utf8");
      // Assert the ceiling the code intends, NOT GitHub's raw 65,536 limit.
      // Asserting the raw limit passes even if MAX_SUMMARY_CHARS were raised
      // to 64,000 — at which point the workflow's table, preamble and
      // boilerplate would push the assembled PR body over the limit and the
      // PR would 422 after the version bumps were already pushed. The margin
      // between this ceiling and 65,536 is the point.
      assert.ok(
        text.length <= MAX_SUMMARY_CHARS + 1_000,
        `summary must respect its own ${MAX_SUMMARY_CHARS}-char ceiling (plus the omission notice), got ${text.length}`,
      );
      assert.ok(
        MAX_SUMMARY_CHARS < 50_000,
        "the ceiling must leave room for the workflow's own PR-body boilerplate",
      );
      assert.match(text, /omitted from this summary/);
      // Every package still gets its own committed changelog — only the
      // informational summary is trimmed.
      const written = JSON.parse(result.stdout).written as string[];
      assert.equal(written.length, 8);
    } finally {
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "skips packages whose entry already exists and keeps the edited text in the summary",
  { timeout: 60_000 },
  async () => {
    const http = await import("node:http");
    const dir = mkTmp();
    let server: import("node:http").Server | undefined;
    try {
      setupFixtureRepo(dir);
      // Pre-existing (e.g. human-edited) entry for the new version.
      writeFileSync(
        join(dir, "integrations/mastra/CHANGELOG.md"),
        "# Changelog\n\n## 0.2.0 — 2026-08-20\n\n- Hand-written by a human.\n\n### Breaking changes\n\nNone.\n",
      );
      const accumulated = join(dir, "accumulated.json");
      writeFileSync(accumulated, JSON.stringify([bump()]));

      // Server that fails the test if called: nothing should be generated.
      let called = false;
      server = http.createServer((_req, res) => {
        called = true;
        res.writeHead(500);
        res.end();
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;

      const summary = join(dir, "summary.md");
      const failure = join(dir, "failure.txt");
      const result = await runScript(
        [
          "--accumulated",
          accumulated,
          "--summary-output",
          summary,
          "--failure-output",
          failure,
          "--repo-root",
          dir,
        ],
        {
          ANTHROPIC_API_KEY: "sk-test-mock",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/`,
        },
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(
        called,
        false,
        "model must not be called for skipped entries",
      );
      assert.equal(existsSync(failure), false);

      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed.written, []);
      assert.equal(parsed.skipped.length, 1);
      assert.match(readFileSync(summary, "utf8"), /Hand-written by a human/);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
