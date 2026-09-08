import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXTRACT = join(
  process.cwd(),
  "scripts/release/extract-changelog-entry.py",
);
const RELEASE_SH = join(
  process.cwd(),
  "scripts/release/create-or-update-release.sh",
);
const RECONCILE_SH = join(
  process.cwd(),
  "scripts/release/reconcile-release.sh",
);

// Builds a fixture repo root with its own release.config.json and one
// package changelog, consumed via the AGUI_RELEASE_REPO_ROOT override.
function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "extract-changelog-"));
  mkdirSync(join(dir, "scripts/release"), { recursive: true });
  mkdirSync(join(dir, "integrations/mastra"), { recursive: true });
  writeFileSync(
    join(dir, "scripts/release/release.config.json"),
    JSON.stringify({
      prereleaseTag: "canary",
      scopes: {
        "integration-mastra": {
          description: "Mastra integration",
          sharedVersion: false,
          packages: [
            {
              name: "@ag-ui/mastra",
              path: "integrations/mastra",
              ecosystem: "typescript",
            },
          ],
        },
        "integration-agno": {
          description: "Agno integration",
          sharedVersion: false,
          packages: [
            {
              name: "@ag-ui/agno",
              path: "integrations/agno",
              ecosystem: "typescript",
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "integrations/mastra/CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "## 0.2.0 — 2026-08-24",
      "",
      "- Forwarded tool call results to the client.",
      "",
      "### Breaking changes",
      "",
      "None.",
      "",
      "## 0.1.0 — 2026-07-01",
      "",
      "- Initial release.",
      "",
      "### Breaking changes",
      "",
      "None.",
      "",
    ].join("\n"),
  );
  return dir;
}

function runExtract(
  root: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", [EXTRACT, ...args], {
    encoding: "utf8",
    env: { ...process.env, AGUI_RELEASE_REPO_ROOT: root },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

test("extracts exactly the requested version's body, without the heading", () => {
  const root = fixtureRoot();
  try {
    const r = runExtract(root, ["@ag-ui/mastra", "0.2.0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Forwarded tool call results/);
    assert.match(r.stdout, /### Breaking changes/);
    assert.doesNotMatch(r.stdout, /## 0\.2\.0/);
    assert.doesNotMatch(r.stdout, /Initial release/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--demote shifts headings so the entry nests under the release body", () => {
  const root = fixtureRoot();
  try {
    const r = runExtract(root, ["@ag-ui/mastra", "0.2.0", "--demote", "2"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^##### Breaking changes$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extracts Keep-a-Changelog bracketed headings (hand-maintained files)", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## [0.3.0] - 2026-08-24",
        "",
        "- Hand-written in Keep-a-Changelog style.",
        "",
        "## [0.2.0] - 2026-08-01",
        "",
        "- Older entry.",
        "",
      ].join("\n"),
    );
    const r = runExtract(root, ["@ag-ui/mastra", "0.3.0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Hand-written in Keep-a-Changelog style/);
    assert.doesNotMatch(r.stdout, /Older entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a matching heading inside a fence ABOVE the entry is not mistaken for it, and ~~~ fences count", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "```md",
        "## 0.2.0 — this is a fenced example, not the entry",
        "```",
        "",
        "## 0.2.0 — 2026-08-24",
        "",
        "- The real entry.",
        "",
        "~~~",
        "## heading inside tilde fence",
        "~~~",
        "",
        "### Breaking changes",
        "",
        "None.",
        "",
      ].join("\n"),
    );
    const r = runExtract(root, ["@ag-ui/mastra", "0.2.0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /The real entry/);
    assert.match(r.stdout, /heading inside tilde fence/);
    assert.match(r.stdout, /### Breaking changes/);
    assert.doesNotMatch(r.stdout, /fenced example, not the entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a '## ' line inside a fenced code block does not truncate the entry", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## 0.2.0 — 2026-08-24",
        "",
        "- Docs example below.",
        "",
        "```md",
        "## Example heading inside a fence",
        "```",
        "",
        "### Breaking changes",
        "",
        "None.",
        "",
        "## 0.1.0 — 2026-07-01",
        "",
        "- Older entry.",
        "",
      ].join("\n"),
    );
    const r = runExtract(root, ["@ag-ui/mastra", "0.2.0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Example heading inside a fence/);
    assert.match(r.stdout, /### Breaking changes/);
    assert.doesNotMatch(r.stdout, /Older entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A hand-edited CHANGELOG may legitimately use a wider fence to show a
// three-backtick example. Collapsing fences to three characters, or letting a
// closer carry an info string, ends the block early — so a literal "## " line
// inside it reads as the next version and publication truncates the entry,
// potentially before Breaking changes. Cases follow CommonMark 0.31.2 §4.5.
for (const { name, fence } of [
  {
    name: "four-backtick",
    fence: ["````md", "```", "## Inside the block", "````"],
  },
  {
    name: "four-tilde",
    fence: ["~~~~md", "~~~", "## Inside the block", "~~~~"],
  },
  {
    name: "closer with an info string",
    fence: ["```md", "```js", "## Inside the block", "```"],
  },
  {
    name: "three-space indented",
    fence: ["   ```md", "## Inside the block", "   ```"],
  },
  {
    // A tilde line neither opens nor closes a backtick block.
    name: "backtick block containing a tilde line",
    fence: ["```md", "~~~", "## Inside the block", "```"],
  },
]) {
  test(`a ${name} fence does not truncate the entry`, () => {
    const root = fixtureRoot();
    try {
      writeFileSync(
        join(root, "integrations/mastra/CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 0.2.0 — 2026-08-24",
          "",
          "- Docs example below.",
          "",
          ...fence,
          "",
          "### Breaking changes",
          "",
          "Removes `runAgent`.",
          "",
          "## 0.1.0 — 2026-07-01",
          "",
          "- Older entry.",
          "",
        ].join("\n"),
      );
      const r = runExtract(root, ["@ag-ui/mastra", "0.2.0"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Inside the block/);
      assert.match(r.stdout, /### Breaking changes/);
      assert.match(r.stdout, /Removes `runAgent`/);
      assert.doesNotMatch(r.stdout, /Older entry/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// The mirror of the cases above: four or more leading spaces is an indented
// code block, not a fence. Treating it as one would open a block that never
// closes, swallowing the next version's heading — so the entry would run to the
// end of the file and publish the whole changelog as one release's notes.
test("a four-space indented ``` does not open a fence and swallow later entries", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## 0.2.0 — 2026-08-24",
        "",
        "- An indented code block, not a fence:",
        "",
        "    ```",
        "    literal backticks",
        "",
        "## 0.1.0 — 2026-07-01",
        "",
        "- Older entry.",
        "",
      ].join("\n"),
    );
    const r = runExtract(root, ["@ag-ui/mastra", "0.2.0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /literal backticks/);
    assert.doesNotMatch(r.stdout, /Older entry/);
    assert.doesNotMatch(r.stdout, /## 0\.1\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// CommonMark: a backtick fence's info string may not contain a backtick, so
// such a line is ordinary text. Treating it as an opener starts a block that
// never closes, which swallows the NEXT version's heading — the entry then runs
// to end of file and publishes older releases' notes as part of this one. The
// mirror of the truncation cases above, and it reaches a hand-edited changelog.
test("a backtick in a backtick fence's info string does not open a fence", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      [
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
      ].join("\n"),
    );
    const r = runExtract(root, ["@ag-ui/mastra", "0.2.0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /current/);
    assert.match(r.stdout, /literal/);
    // The 0.1.0 heading ends the entry, so neither it nor its notes leak in.
    assert.doesNotMatch(r.stdout, /## 0\.1\.0/);
    assert.doesNotMatch(r.stdout, /Older entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The restriction is backtick-only: a tilde fence's info string may contain a
// backtick, so this one IS a fence and must still shield the heading inside it.
test("a backtick in a tilde fence's info string still opens a fence", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## 0.2.0 — 2026-08-24",
        "",
        "~~~lang`ok",
        "## Inside the block",
        "~~~",
        "",
        "### Breaking changes",
        "",
        "Removes `runAgent`.",
        "",
        "## 0.1.0 — 2026-07-01",
        "",
        "- Older entry.",
        "",
      ].join("\n"),
    );
    const r = runExtract(root, ["@ag-ui/mastra", "0.2.0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Inside the block/);
    assert.match(r.stdout, /### Breaking changes/);
    assert.doesNotMatch(r.stdout, /Older entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exits 3 for an unknown package, a missing file, and a missing version", () => {
  const root = fixtureRoot();
  try {
    assert.equal(runExtract(root, ["@ag-ui/unknown", "1.0.0"]).status, 3);
    assert.equal(runExtract(root, ["@ag-ui/mastra", "9.9.9"]).status, 3);
    rmSync(join(root, "integrations/mastra/CHANGELOG.md"));
    assert.equal(runExtract(root, ["@ag-ui/mastra", "0.2.0"]).status, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A fake `gh` that VALIDATES its invocation rather than blindly capturing
// stdin: a shim which accepts anything lets a malformed real `gh` call (wrong
// subcommand, missing --notes-file) pass the suite while failing in production.
// `release view` serves $GH_FIXTURE_BODY, or exits 1 when GH_FIXTURE_ABSENT=1
// so the create path can be exercised. Every invocation is appended to
// $GH_FIXTURE_CALLS.
function installGhShim(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$GH_FIXTURE_CALLS"',
      'cmd="$1 $2"; shift 2',
      'case "$cmd" in',
      '  "release view")',
      '    [ -n "$1" ] || { echo "shim: release view needs a tag" >&2; exit 64; }',
      "    shift",
      '    [ "${GH_FIXTURE_ABSENT:-0}" = "1" ] && exit 1',
      '    [ -f "$GH_FIXTURE_BODY" ] || exit 1',
      "    # The real CLI requires a field after --json; accepting a bare",
      "    # --json would hide a malformed call that fails after publication.",
      "    # No further args is the existence probe; --json requests the body.",
      "    [ $# -eq 0 ] && exit 0",
      '    [ "$1" = "--json" ] || { echo "shim: expected --json, got $1" >&2; exit 64; }',
      '    [ -n "$2" ] || { echo "shim: --json needs a field list" >&2; exit 64; }',
      '    cat "$GH_FIXTURE_BODY"',
      "    exit 0 ;;",
      '  "release edit")',
      '    [ -n "$1" ] || { echo "shim: release edit needs a tag" >&2; exit 64; }',
      "    shift",
      '    [ "$1" = "--notes-file" ] || { echo "shim: expected --notes-file, got $1" >&2; exit 64; }',
      '    [ "$2" = "-" ] || { echo "shim: expected notes on stdin, got $2" >&2; exit 64; }',
      '    cat > "$GH_FIXTURE_UPDATED"; exit 0 ;;',
      '  "release create")',
      '    [ -n "$1" ] || { echo "shim: release create needs a tag" >&2; exit 64; }',
      "    shift",
      "    seen_notes=0",
      "    while [ $# -gt 0 ]; do",
      '      case "$1" in',
      '        --notes-file) [ "$2" = "-" ] || { echo "shim: expected notes on stdin" >&2; exit 64; }; seen_notes=1; shift 2 ;;',
      '        --title) [ -n "$2" ] || { echo "shim: --title needs a value" >&2; exit 64; }; shift 2 ;;',
      '        *) echo "shim: unexpected create arg $1" >&2; exit 64 ;;',
      "      esac",
      "    done",
      '    [ "$seen_notes" = "1" ] || { echo "shim: create without --notes-file" >&2; exit 64; }',
      '    cat > "$GH_FIXTURE_UPDATED"; exit 0 ;;',
      "esac",
      'echo "shim: unsupported invocation: $cmd" >&2',
      "exit 64",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

function runReleaseScript(
  root: string,
  packages: unknown[],
  bodyFile: string,
  updatedFile: string,
  extraEnv: Record<string, string> = {},
  script: string = RELEASE_SH,
): { status: number; stderr: string; calls: string } {
  const callsFile = join(root, "gh-calls.txt");
  const r = spawnSync(
    "bash",
    [script, "typescript", JSON.stringify(packages)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${installGhShim(root)}:${process.env.PATH}`,
        AGUI_RELEASE_REPO_ROOT: root,
        GH_FIXTURE_BODY: bodyFile,
        GH_FIXTURE_UPDATED: updatedFile,
        GH_FIXTURE_CALLS: callsFile,
        DRY_RUN: "false",
        ...extraEnv,
      },
    },
  );
  return {
    status: r.status ?? -1,
    stderr: r.stderr,
    calls: existsSync(callsFile) ? readFileSync(callsFile, "utf8") : "",
  };
}

test("a table row inside approved notes does not suppress a later package's append", () => {
  const root = fixtureRoot();
  try {
    // Existing body written by the current script version (has sentinels for
    // another package) whose notes contain a compatibility table row that
    // looks exactly like @ag-ui/mastra's install row key.
    const bodyFile = join(root, "body.txt");
    writeFileSync(
      bodyFile,
      [
        "## Packages Published",
        "### Python (PyPI) - published at 10:00:00 UTC",
        "| Package | Version | Install |",
        "|---------|---------|--------|",
        "| ag_ui_strands | 0.3.1 | `pip install ag_ui_strands==0.3.1` |",
        "",
        "#### ag_ui_strands@0.3.1",
        "",
        "- Compatible peers:",
        "",
        "| Peer | Version |",
        "|------|---------|",
        "| @ag-ui/mastra | 0.2.0 |",
        "",
        "<!-- ag-ui-published: ag_ui_strands@0.3.1 -->",
      ].join("\n"),
    );
    const updatedFile = join(root, "updated.txt");
    const r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      bodyFile,
      updatedFile,
    );
    assert.equal(r.status, 0, r.stderr);
    const updated = readFileSync(updatedFile, "utf8");
    assert.match(updated, /`npm install @ag-ui\/mastra@0\.2\.0`/);
    assert.match(updated, /<!-- ag-ui-published: @ag-ui\/mastra@0\.2\.0 -->/);
    assert.match(updated, /Forwarded tool call results/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a genuinely recorded package is not appended twice (sentinel path), and legacy bodies fall back to row keys", () => {
  const root = fixtureRoot();
  try {
    // Sentinel body already recording mastra → no update.
    const bodyFile = join(root, "body.txt");
    const updatedFile = join(root, "updated.txt");
    writeFileSync(
      bodyFile,
      "## Packages Published\n| @ag-ui/mastra | 0.2.0 | `npm install @ag-ui/mastra@0.2.0` |\n<!-- ag-ui-published: @ag-ui/mastra@0.2.0 -->\n",
    );
    let r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      bodyFile,
      updatedFile,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(updatedFile), false, "sentinel present → no edit");

    // Legacy body (no sentinels anywhere) with the plain row → also no update.
    writeFileSync(
      bodyFile,
      "## Packages Published\n| @ag-ui/mastra | 0.2.0 | `npm install @ag-ui/mastra@0.2.0` |\n",
    );
    r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      bodyFile,
      updatedFile,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(updatedFile), false, "legacy row → no edit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the create path builds a new release with the approved notes", () => {
  const root = fixtureRoot();
  try {
    const updatedFile = join(root, "updated.txt");
    const r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      join(root, "absent-body.txt"),
      updatedFile,
      { GH_FIXTURE_ABSENT: "1" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.calls, /release create/, "must take the create path");
    const body = readFileSync(updatedFile, "utf8");
    assert.match(body, /## Packages Published/);
    assert.match(body, /`npm install @ag-ui\/mastra@0\.2\.0`/);
    assert.match(body, /Forwarded tool call results/);
    assert.match(body, /<!-- ag-ui-published: @ag-ui\/mastra@0\.2\.0 -->/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an extractor FAULT is reported, not published as 'no notes approved'", () => {
  const root = fixtureRoot();
  try {
    // Undecodable bytes: the changelog exists, so this is a fault (exit 1),
    // not an absent entry (exit 3). Publishing the reassuring absence text
    // here would lie to consumers AND let reconcile consider it done.
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      Buffer.from([
        0x23, 0x23, 0x20, 0x30, 0x2e, 0x32, 0x2e, 0x30, 0x0a, 0xff, 0xfe,
      ]),
    );
    const updatedFile = join(root, "updated.txt");
    const r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      join(root, "absent-body.txt"),
      updatedFile,
      { GH_FIXTURE_ABSENT: "1" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stderr,
      /could not read release notes/,
      "a fault must be surfaced to the operator",
    );
    assert.match(r.stderr, /::warning title=Release notes unreadable/);
    const body = readFileSync(updatedFile, "utf8");
    assert.match(body, /could not be read/);
    assert.doesNotMatch(
      body,
      /No release notes were approved/,
      "a fault must not masquerade as an expected absence",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fault is marked retryable, so reconcile repairs it once fixed", () => {
  const root = fixtureRoot();
  try {
    // Undecodable changelog: the notes cannot be read (exit 1).
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      Buffer.from([0x23, 0x23, 0x20, 0x30, 0x2e, 0x32, 0x2e, 0x30, 0x0a, 0xff]),
    );
    const updatedFile = join(root, "updated.txt");
    const created = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      join(root, "absent-body.txt"),
      updatedFile,
      { GH_FIXTURE_ABSENT: "1" },
    );
    assert.equal(created.status, 0, created.stderr);
    const faultBody = readFileSync(updatedFile, "utf8");
    // The fault must NOT claim the published sentinel...
    assert.match(
      faultBody,
      /<!-- ag-ui-unreadable: @ag-ui\/mastra@0\.2\.0 -->/,
    );
    assert.doesNotMatch(
      faultBody,
      /<!-- ag-ui-published: @ag-ui\/mastra@0\.2\.0 -->/,
    );

    // ...so with the changelog now readable, reconcile still sees it as
    // missing and repairs it, rather than treating the placeholder as final.
    rmSync(updatedFile);
    const bodyFile = join(root, "body.txt");
    writeFileSync(bodyFile, faultBody);
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      "# Changelog\n\n## 0.2.0 — 2026-08-24\n\n- Repaired notes.\n",
    );
    const reconciled = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      bodyFile,
      updatedFile,
      {},
      RECONCILE_SH,
    );
    assert.equal(reconciled.status, 0, reconciled.stderr);
    assert.match(reconciled.stderr, /missing entry for @ag-ui\/mastra@0\.2\.0/);
    assert.match(readFileSync(updatedFile, "utf8"), /Repaired notes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the create path budgets its notes too, not just the append path", () => {
  const root = fixtureRoot();
  try {
    // A single approved entry larger than the whole budget. On the create path
    // this would otherwise build an over-limit body and `gh release create`
    // would fail AFTER the packages were published and tagged.
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## 0.2.0 — 2026-08-24",
        "",
        `- ${"y".repeat(115_000)}`,
        "",
      ].join("\n"),
    );
    const updatedFile = join(root, "updated.txt");
    const r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      join(root, "absent-body.txt"),
      updatedFile,
      { GH_FIXTURE_ABSENT: "1" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.calls, /release create/);
    const body = readFileSync(updatedFile, "utf8");
    assert.ok(
      body.length < 125_000,
      `release body must stay under GitHub's limit, got ${body.length}`,
    );
    assert.match(body, /Notes omitted to stay within GitHub/);
    assert.match(body, /<!-- ag-ui-published: @ag-ui\/mastra@0\.2\.0 -->/);
    assert.match(r.stderr, /::warning title=Release notes omitted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the append path budgets against the body already on the release", () => {
  const root = fixtureRoot();
  try {
    // A body already near the budget, written by this script version.
    const bodyFile = join(root, "body.txt");
    writeFileSync(
      bodyFile,
      [
        "## Packages Published",
        "| ag_ui_strands | 0.3.1 | `pip install ag_ui_strands==0.3.1` |",
        `- ${"x".repeat(112_000)}`,
        "<!-- ag-ui-published: ag_ui_strands@0.3.1 -->",
      ].join("\n"),
    );
    const updatedFile = join(root, "updated.txt");
    const r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      bodyFile,
      updatedFile,
    );
    assert.equal(r.status, 0, r.stderr);
    const updated = readFileSync(updatedFile, "utf8");
    // Over budget: the row and sentinel stay (presence checks depend on them)
    // but the prose is replaced with a pointer, and it is announced.
    assert.match(updated, /`npm install @ag-ui\/mastra@0\.2\.0`/);
    assert.match(updated, /<!-- ag-ui-published: @ag-ui\/mastra@0\.2\.0 -->/);
    assert.match(updated, /Notes omitted to stay within GitHub/);
    assert.doesNotMatch(updated, /Forwarded tool call results/);
    assert.match(r.stderr, /::warning title=Release notes omitted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an over-budget FAULT stays retryable instead of being marked published", () => {
  const root = fixtureRoot();
  try {
    // Undecodable changelog (a fault) AND an existing body over budget, so the
    // block is replaced by a pointer. If that pointer carried the published
    // marker the fault would be frozen into the release forever.
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      Buffer.from([0x23, 0x23, 0x20, 0x30, 0x2e, 0x32, 0x2e, 0x30, 0x0a, 0xff]),
    );
    const bodyFile = join(root, "body.txt");
    writeFileSync(
      bodyFile,
      [
        "## Packages Published",
        "| ag_ui_strands | 0.3.1 | `pip install ag_ui_strands==0.3.1` |",
        `- ${"x".repeat(112_000)}`,
        "<!-- ag-ui-published: ag_ui_strands@0.3.1 -->",
      ].join("\n"),
    );
    const updatedFile = join(root, "updated.txt");
    const r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      bodyFile,
      updatedFile,
    );
    assert.equal(r.status, 0, r.stderr);
    const updated = readFileSync(updatedFile, "utf8");
    // The fault block is ONE sentence, so the budget must not replace it:
    // "read them in CHANGELOG.md" would hide that the notes were unreadable,
    // and replacing a one-line block saves nothing anyway.
    assert.match(updated, /could not be read/);
    assert.doesNotMatch(
      updated,
      /Notes omitted to stay within GitHub/,
      "a fault block must keep its disclosure, not become a pointer",
    );
    assert.match(updated, /<!-- ag-ui-unreadable: @ag-ui\/mastra@0\.2\.0 -->/);
    assert.doesNotMatch(
      updated,
      /<!-- ag-ui-published: @ag-ui\/mastra@0\.2\.0 -->/,
      "an over-budget fault must not be recorded as published",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an over-budget MISSING entry keeps its disclosure instead of a pointer", () => {
  const root = fixtureRoot();
  try {
    // No entry for this version (extractor exit 3) AND a body over budget.
    // Replacing the one-line "no notes were approved" disclosure with
    // "read them in CHANGELOG.md" would point consumers at notes that do not
    // exist, and would hide the absence from anyone reading the release.
    const bodyFile = join(root, "body.txt");
    writeFileSync(
      bodyFile,
      [
        "## Packages Published",
        "| ag_ui_strands | 0.3.1 | `pip install ag_ui_strands==0.3.1` |",
        `- ${"x".repeat(112_000)}`,
        "<!-- ag-ui-published: ag_ui_strands@0.3.1 -->",
      ].join("\n"),
    );
    const updatedFile = join(root, "updated.txt");
    const r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "8.8.8",
          path: "integrations/mastra",
        },
      ],
      bodyFile,
      updatedFile,
    );
    assert.equal(r.status, 0, r.stderr);
    const updated = readFileSync(updatedFile, "utf8");
    assert.match(updated, /No release notes were approved/);
    assert.doesNotMatch(
      updated,
      /Notes omitted to stay within GitHub/,
      "a missing-entry block must keep its disclosure, not become a pointer",
    );
    assert.match(updated, /<!-- ag-ui-published: @ag-ui\/mastra@8\.8\.8 -->/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persistent fault is not appended twice, and a repair adds no second row", () => {
  const root = fixtureRoot();
  try {
    const unreadable = Buffer.from([
      0x23, 0x23, 0x20, 0x30, 0x2e, 0x32, 0x0a, 0xff,
    ]);
    writeFileSync(join(root, "integrations/mastra/CHANGELOG.md"), unreadable);
    // A body that already records this package as unreadable, with its row.
    const bodyFile = join(root, "body.txt");
    writeFileSync(
      bodyFile,
      [
        "## Packages Published",
        "### TypeScript (npm) - published at 10:00:00 UTC",
        "| @ag-ui/mastra | 0.2.0 | `npm install @ag-ui/mastra@0.2.0` |",
        "",
        "#### @ag-ui/mastra@0.2.0",
        "",
        "_Release notes could not be read..._",
        "",
        "<!-- ag-ui-unreadable: @ag-ui/mastra@0.2.0 -->",
      ].join("\n"),
    );
    const updatedFile = join(root, "updated.txt");
    const pkgs = [
      { name: "@ag-ui/mastra", version: "0.2.0", path: "integrations/mastra" },
    ];

    // Still unreadable: nothing new to say, so nothing is appended.
    const again = runReleaseScript(root, pkgs, bodyFile, updatedFile);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /still unreadable; not duplicating/);
    assert.equal(existsSync(updatedFile), false, "no duplicate placeholder");

    // Now repaired: the real notes are appended, without a second install row.
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      "# Changelog\n\n## 0.2.0 — 2026-08-24\n\n- Repaired notes.\n",
    );
    const repaired = runReleaseScript(root, pkgs, bodyFile, updatedFile);
    assert.equal(repaired.status, 0, repaired.stderr);
    const updated = readFileSync(updatedFile, "utf8");
    assert.match(updated, /Repaired notes/);
    assert.match(updated, /<!-- ag-ui-published: @ag-ui\/mastra@0\.2\.0 -->/);
    const rowCount =
      updated.split("`npm install @ag-ui/mastra@0.2.0`").length - 1;
    assert.equal(rowCount, 1, "the install row must not be duplicated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty packages array is rejected rather than silently doing nothing", () => {
  const root = fixtureRoot();
  try {
    // reconcile is given an EXISTING release body. Otherwise it delegates to
    // create-or-update-release.sh, whose own guard rejects the payload — and
    // reconcile's guard would pass the test without existing at all.
    const bodyFile = join(root, "body.txt");
    writeFileSync(
      bodyFile,
      "## Packages Published\n<!-- ag-ui-published: ag_ui_strands@0.3.1 -->\n",
    );
    for (const script of [RELEASE_SH, RECONCILE_SH]) {
      const r = spawnSync("bash", [script, "typescript", "[]"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${installGhShim(root)}:${process.env.PATH}`,
          AGUI_RELEASE_REPO_ROOT: root,
          GH_FIXTURE_BODY: bodyFile,
          GH_FIXTURE_UPDATED: join(root, "updated.txt"),
          GH_FIXTURE_CALLS: join(root, "gh-calls.txt"),
          DRY_RUN: "false",
        },
      });
      assert.notEqual(r.status, 0, `${script} must reject []`);
      assert.match(r.stderr, /empty/);
    }
    assert.equal(
      existsSync(join(root, "updated.txt")),
      false,
      "nothing may be written for an empty payload",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed packages-json fails loudly instead of publishing an empty release", () => {
  const root = fixtureRoot();
  try {
    for (const script of [RELEASE_SH, RECONCILE_SH]) {
      const r = spawnSync("bash", [script, "typescript", "not-json"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${installGhShim(root)}:${process.env.PATH}`,
          AGUI_RELEASE_REPO_ROOT: root,
          GH_FIXTURE_CALLS: join(root, "gh-calls.txt"),
          DRY_RUN: "false",
        },
      });
      assert.notEqual(r.status, 0, `${script} must reject malformed JSON`);
      assert.match(r.stderr, /not a JSON array/);
    }
    // And an array whose entries lack the required fields — in BOTH scripts,
    // since reconcile reads the same payload shape.
    //
    // Asserting only "exits non-zero with this message" is not enough for
    // reconcile: with its own guard deleted, jq yields literal `null` fields,
    // reconcile decides the package is missing and delegates to
    // create-or-update-release.sh, and THAT script's guard produces the same
    // failure and message. So assert reconcile rejects before it touches
    // GitHub at all — with the guard, it makes no `gh` call whatsoever.
    const bodyFile = join(root, "existing-body.txt");
    writeFileSync(
      bodyFile,
      "## Packages Published\n<!-- ag-ui-published: ag_ui_strands@0.3.1 -->\n",
    );
    for (const script of [RELEASE_SH, RECONCILE_SH]) {
      const callsFile = join(root, `calls-${script.split("/").pop()}.txt`);
      const r = spawnSync("bash", [script, "typescript", '[{"nope":1}]'], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${installGhShim(root)}:${process.env.PATH}`,
          AGUI_RELEASE_REPO_ROOT: root,
          GH_FIXTURE_BODY: bodyFile,
          GH_FIXTURE_UPDATED: join(root, "updated-malformed.txt"),
          GH_FIXTURE_CALLS: callsFile,
          DRY_RUN: "false",
        },
      });
      assert.notEqual(
        r.status,
        0,
        `${script} must reject entries missing fields`,
      );
      assert.match(r.stderr, /string \.name and \.version/);
      assert.equal(
        existsSync(callsFile),
        false,
        `${script} must reject the payload before invoking gh at all`,
      );
    }
    assert.equal(
      existsSync(join(root, "updated-malformed.txt")),
      false,
      "nothing may be written for a malformed payload",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a marker quoted inside approved notes cannot fake a recorded package", () => {
  const root = fixtureRoot();
  try {
    // A changelog entry that documents this very mechanism — entirely
    // plausible for this repo — must not make a LATER package look recorded.
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## 0.2.0 — 2026-08-25",
        "",
        "- Release bodies now carry a per-package marker, for example:",
        "",
        "```html",
        "<!-- ag-ui-published: @ag-ui/agno@9.9.9 -->",
        "```",
        "",
      ].join("\n"),
    );
    const updatedFile = join(root, "updated.txt");
    const created = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      join(root, "absent.txt"),
      updatedFile,
      { GH_FIXTURE_ABSENT: "1" },
    );
    assert.equal(created.status, 0, created.stderr);
    const body = readFileSync(updatedFile, "utf8");
    // The quoted marker is neutralised, so only real markers remain...
    assert.match(body, /&lt;!-- ag-ui-published: @ag-ui\/agno@9\.9\.9 -->/);
    assert.doesNotMatch(
      body,
      /\n<!-- ag-ui-published: @ag-ui\/agno@9\.9\.9 -->/,
    );
    // ...and mastra's own marker is intact.
    assert.match(body, /<!-- ag-ui-published: @ag-ui\/mastra@0\.2\.0 -->/);

    // Now the agno package must still be treated as MISSING and appended.
    const bodyFile = join(root, "body.txt");
    writeFileSync(bodyFile, body);
    const appended = runReleaseScript(
      root,
      [{ name: "@ag-ui/agno", version: "9.9.9", path: "integrations/agno" }],
      bodyFile,
      join(root, "updated2.txt"),
    );
    assert.equal(appended.status, 0, appended.stderr);
    assert.match(
      readFileSync(join(root, "updated2.txt"), "utf8"),
      /`npm install @ag-ui\/agno@9\.9\.9`/,
      "a package whose marker only appears inside quoted notes must still be appended",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repaired fault whose version has no entry stops being retried", () => {
  const root = fixtureRoot();
  try {
    // Body records mastra as unreadable (retryable, no published marker).
    const bodyFile = join(root, "body.txt");
    writeFileSync(
      bodyFile,
      [
        "## Packages Published",
        "| @ag-ui/mastra | 7.7.7 | `npm install @ag-ui/mastra@7.7.7` |",
        "",
        "#### @ag-ui/mastra@7.7.7",
        "",
        "_Release notes could not be read..._",
        "",
        "<!-- ag-ui-unreadable: @ag-ui/mastra@7.7.7 -->",
      ].join("\n"),
    );
    // The changelog is readable now, but has no entry for 7.7.7 → exit 3.
    // That is a RESOLVED state, not a continuing fault: it must be recorded
    // with the published marker, or reconcile retries it forever.
    const updatedFile = join(root, "updated.txt");
    const r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "7.7.7",
          path: "integrations/mastra",
        },
      ],
      bodyFile,
      updatedFile,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /still unreadable/);
    const updated = readFileSync(updatedFile, "utf8");
    assert.match(updated, /No release notes were approved/);
    assert.match(updated, /<!-- ag-ui-published: @ag-ui\/mastra@7\.7\.7 -->/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile keys on sentinels, not on look-alike rows in approved notes", () => {
  const root = fixtureRoot();
  try {
    // Mastra is NOT recorded, but another package's notes contain a table row
    // that looks exactly like Mastra's install row. Row-key matching would
    // call the release complete and never repair it.
    const bodyFile = join(root, "body.txt");
    writeFileSync(
      bodyFile,
      [
        "## Packages Published",
        "| ag_ui_strands | 0.3.1 | `pip install ag_ui_strands==0.3.1` |",
        "",
        "#### ag_ui_strands@0.3.1",
        "",
        "| Peer | Version |",
        "|------|---------|",
        "| @ag-ui/mastra | 0.2.0 |",
        "",
        "<!-- ag-ui-published: ag_ui_strands@0.3.1 -->",
      ].join("\n"),
    );
    const updatedFile = join(root, "updated.txt");
    const r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      bodyFile,
      updatedFile,
      {},
      RECONCILE_SH,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /missing entry for @ag-ui\/mastra@0\.2\.0/);
    // Reconcile must have repaired it by delegating to create-or-update.
    assert.match(readFileSync(updatedFile, "utf8"), /Forwarded tool call/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile does nothing when the sentinel is genuinely present", () => {
  const root = fixtureRoot();
  try {
    const bodyFile = join(root, "body.txt");
    writeFileSync(
      bodyFile,
      "## Packages Published\n<!-- ag-ui-published: @ag-ui/mastra@0.2.0 -->\n",
    );
    const updatedFile = join(root, "updated.txt");
    const r = runReleaseScript(
      root,
      [
        {
          name: "@ag-ui/mastra",
          version: "0.2.0",
          path: "integrations/mastra",
        },
      ],
      bodyFile,
      updatedFile,
      {},
      RECONCILE_SH,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /nothing to reconcile/);
    assert.equal(existsSync(updatedFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fenced headings survive the --demote path the publisher actually uses", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(
      join(root, "integrations/mastra/CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## 0.2.0 — 2026-08-24",
        "",
        "- Example follows.",
        "",
        "```md",
        "## Sample heading in a code block",
        "```",
        "",
        "### Breaking changes",
        "",
        "None.",
        "",
      ].join("\n"),
    );
    // --demote 2 is what create-or-update-release.sh passes, so fence
    // awareness must hold on THAT path, not just on the undemoted one.
    const r = runExtract(root, ["@ag-ui/mastra", "0.2.0", "--demote", "2"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^##### Breaking changes$/m, "prose is demoted");
    assert.match(
      r.stdout,
      /^## Sample heading in a code block$/m,
      "a heading inside a fence must not be rewritten",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit code 1 marks a fault: unreadable config and bad --demote", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(
      join(root, "scripts/release/release.config.json"),
      "{ not json",
    );
    const bad = runExtract(root, ["@ag-ui/mastra", "0.2.0"]);
    assert.equal(
      bad.status,
      1,
      "a malformed config is a fault, not an absence",
    );
    assert.match(bad.stderr, /cannot read/);

    const root2 = fixtureRoot();
    try {
      const usage = runExtract(root2, [
        "@ag-ui/mastra",
        "0.2.0",
        "--demote",
        "x",
      ]);
      assert.equal(usage.status, 1);
      assert.match(usage.stderr, /--demote requires an integer/);
      const argc = runExtract(root2, ["@ag-ui/mastra"]);
      assert.equal(argc.status, 1);
      assert.match(argc.stderr, /Usage:/);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run release body carries the approved entry and flags missing ones", () => {
  const root = fixtureRoot();
  try {
    const packages = JSON.stringify([
      { name: "@ag-ui/mastra", version: "0.2.0", path: "integrations/mastra" },
      { name: "@ag-ui/mastra", version: "9.9.9", path: "integrations/mastra" },
    ]);
    const r = spawnSync("bash", [RELEASE_SH, "typescript", packages], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGUI_RELEASE_REPO_ROOT: root,
        DRY_RUN: "true",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    // DRY_RUN prints the would-be body to stderr.
    assert.match(r.stderr, /#### @ag-ui\/mastra@0\.2\.0/);
    assert.match(r.stderr, /Forwarded tool call results/);
    assert.match(r.stderr, /##### Breaking changes/);
    assert.match(r.stderr, /#### @ag-ui\/mastra@9\.9\.9/);
    assert.match(r.stderr, /No release notes were approved/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
