import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeGithubOutput,
  resolveModeSafe,
  resolveJobResultSafe,
  parsePackagesSafe,
  parseGroupsSafe,
} from "./build-release-notification";

const WRAPPER = join(
  process.cwd(),
  "scripts/release/build-release-notification.ts",
);

const RUN_URL = "https://github.com/ag-ui-protocol/ag-ui/actions/runs/123";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "release-notify-wrapper-"));
}

/**
 * The release-signal / intent env vars the wrapper reads. The helper DELETES
 * these from the inherited env before applying caller overrides, so each test
 * controls them exactly (a real GITHUB_OUTPUT / GITHUB_ACTIONS / MODE etc. set
 * on the runner — e.g. under GitHub Actions — must not leak in and pollute the
 * fail-loud "GITHUB_OUTPUT unset" test or the DRY_RUN coercion cases). HOME /
 * PATH / pnpm / corepack vars pass THROUGH so `pnpm tsx` works in any CI image.
 */
const CONTROLLED_ENV_KEYS = [
  "GITHUB_OUTPUT",
  "GITHUB_ACTIONS",
  "DRY_RUN",
  "MODE",
  "NPM_RESULT",
  "NPM_INTENDED",
  "BUILD_RESULT",
  "TS_PACKAGES",
  "TS_GROUPS",
  "PY_RESULT",
  "PY_INTENDED",
  "PY_BUILD_RESULT",
  "PY_PACKAGES",
  "SCOPE",
  "RUN_URL",
  "NPM_ORG_URL",
  "PY_BASE_URL",
] as const;

/**
 * Run the wrapper CLI as a subprocess; returns { status, stdout, stderr }.
 *
 * Starts from a COPY of process.env (so HOME / PATH / pnpm / corepack vars pass
 * through — stripping them can make `pnpm tsx` fail in some CI images), DELETES
 * the controlled release/intent keys (so the suite's own GitHub Actions env
 * can't leak into a test), THEN applies the caller-supplied overrides.
 */
async function runWrapper(
  env: Record<string, string | undefined>,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of CONTROLLED_ENV_KEYS) {
    delete cleanEnv[key];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) cleanEnv[k] = v;
    else delete cleanEnv[k];
  }
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["tsx", WRAPPER], { env: cleanEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ status: code ?? 0, stdout, stderr }));
  });
}

// ---- writeGithubOutput (in-process) -----------------------------------------
test("writeGithubOutput round-trips a multi-line message through the GITHUB_OUTPUT heredoc", () => {
  const dir = mkTmp();
  try {
    const outputPath = join(dir, "out.txt");
    writeFileSync(outputPath, "");
    const message = "line one\nline two · <https://x|y>";

    writeGithubOutput(outputPath, { message, shouldPost: true });

    const raw = readFileSync(outputPath, "utf8");
    const m = raw.match(/^message<<(\S+)\n([\s\S]*?)\n\1\n/m);
    assert.notEqual(m, null);
    assert.equal(m![2], message);
    assert.ok(raw.includes("should_post=true"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeGithubOutput uses a per-write RANDOM delimiter (not a fixed sentinel)", () => {
  const dir = mkTmp();
  try {
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    writeFileSync(a, "");
    writeFileSync(b, "");

    writeGithubOutput(a, { message: "x", shouldPost: true });
    writeGithubOutput(b, { message: "x", shouldPost: true });

    const delimA = readFileSync(a, "utf8").match(/^message<<(\S+)/m)?.[1];
    const delimB = readFileSync(b, "utf8").match(/^message<<(\S+)/m)?.[1];

    assert.ok(delimA);
    assert.ok(delimB);
    // The real delimiter shape is EOF_<16-hex> (randomBytes(8).toString("hex")).
    assert.match(delimA!, /^EOF_[0-9a-f]{16}$/);
    assert.match(delimB!, /^EOF_[0-9a-f]{16}$/);
    assert.notEqual(delimA, delimB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeGithubOutput does not corrupt output when the message contains a heredoc-like token", () => {
  const dir = mkTmp();
  try {
    const outputPath = join(dir, "out.txt");
    writeFileSync(outputPath, "");
    // Embed a token in the real delimiter shape (EOF_<16-hex>) so this actually
    // exercises collision-safety against the implementation's format.
    const message = "EOF_deadbeefdeadbeef\nstill the message";

    writeGithubOutput(outputPath, { message, shouldPost: true });

    const raw = readFileSync(outputPath, "utf8");
    const m = raw.match(/^message<<(\S+)\n([\s\S]*?)\n\1\n/m);
    assert.notEqual(m, null);
    assert.equal(m![2], message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- resolveModeSafe --------------------------------------------------------
for (const mode of ["stable", "prerelease", ""] as const) {
  test(`resolveModeSafe passes through the known mode "${mode}" unchanged`, () => {
    assert.equal(resolveModeSafe(mode), mode);
  });
}

test('resolveModeSafe coerces an unknown MODE (typo) to "" (degrade, no crash)', () => {
  assert.doesNotThrow(() => resolveModeSafe("stabel"));
  assert.equal(resolveModeSafe("stabel"), "");
});

// ---- resolveJobResultSafe ---------------------------------------------------
for (const result of [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "",
] as const) {
  test(`resolveJobResultSafe passes through the known job result "${result}" unchanged`, () => {
    assert.equal(resolveJobResultSafe(result), result);
  });
}

test('resolveJobResultSafe coerces an unknown job result to "failure" (page-on-uncertainty)', () => {
  assert.doesNotThrow(() => resolveJobResultSafe("succeeded"));
  assert.equal(resolveJobResultSafe("succeeded"), "failure");
});

// ---- parsePackagesSafe ------------------------------------------------------
test("parsePackagesSafe parses a valid JSON array of {name,version}", () => {
  const parsed = parsePackagesSafe(
    '[{"name":"@ag-ui/core","version":"1.0.0","path":"x"}]',
  );
  assert.deepEqual(parsed, [{ name: "@ag-ui/core", version: "1.0.0" }]);
});

test("parsePackagesSafe degrades to [] on empty / malformed JSON (cosmetic, never crashes)", () => {
  assert.deepEqual(parsePackagesSafe(""), []);
  assert.deepEqual(parsePackagesSafe("not json"), []);
  assert.deepEqual(parsePackagesSafe("{}"), []);
  // Entries missing a name are dropped.
  assert.deepEqual(parsePackagesSafe('[{"version":"1.0.0"}]'), []);
});

// ---- parseGroupsSafe --------------------------------------------------------
test("parseGroupsSafe parses a valid dist-tag grouping object", () => {
  assert.deepEqual(parseGroupsSafe('{"latest":["@ag-ui/core"]}'), {
    latest: ["@ag-ui/core"],
  });
});

test("parseGroupsSafe degrades to {} on empty / malformed JSON", () => {
  assert.deepEqual(parseGroupsSafe(""), {});
  assert.deepEqual(parseGroupsSafe("not json"), {});
  assert.deepEqual(parseGroupsSafe("[]"), {});
});

// ---- wrapper CLI fail-loud (subprocess) -------------------------------------
test(
  "fails loud (non-zero + ::error::) when running under Actions with GITHUB_OUTPUT unset",
  { timeout: 30_000 },
  async () => {
    const { status, stderr } = await runWrapper({
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: undefined,
      MODE: "stable",
      NPM_RESULT: "success",
      BUILD_RESULT: "success",
      TS_PACKAGES: '[{"name":"@ag-ui/core","version":"1.0.0"}]',
      TS_GROUPS: '{"latest":["@ag-ui/core"]}',
    });
    assert.notEqual(status, 0);
    assert.match(stderr, /::error::/);
  },
);

test(
  "writes output and exits 0 when GITHUB_OUTPUT is set",
  { timeout: 30_000 },
  async () => {
    const dir = mkTmp();
    try {
      const out = join(dir, "gho.txt");
      writeFileSync(out, "");
      const { status } = await runWrapper({
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: out,
        MODE: "stable",
        NPM_RESULT: "success",
        BUILD_RESULT: "success",
        TS_PACKAGES: '[{"name":"@ag-ui/core","version":"1.0.0"}]',
        TS_GROUPS: '{"latest":["@ag-ui/core"]}',
      });
      assert.equal(status, 0);
      const raw = readFileSync(out, "utf8");
      assert.ok(raw.includes("should_post=true"));
      assert.match(raw, /^message<<\S+/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---- wrapper CLI DRY_RUN string coercion (subprocess) -----------------------
async function postFor(
  dryRun: string,
): Promise<{ status: number; raw: string }> {
  const dir = mkTmp();
  try {
    const out = join(dir, "gho.txt");
    writeFileSync(out, "");
    const { status } = await runWrapper({
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: out,
      MODE: "stable",
      NPM_RESULT: "success",
      BUILD_RESULT: "success",
      TS_PACKAGES: '[{"name":"@ag-ui/core","version":"1.0.0"}]',
      TS_GROUPS: '{"latest":["@ag-ui/core"]}',
      DRY_RUN: dryRun,
    });
    return { status, raw: readFileSync(out, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  'DRY_RUN="true" → should_post=false (suppressed)',
  { timeout: 30_000 },
  async () => {
    const { status, raw } = await postFor("true");
    assert.equal(status, 0);
    assert.ok(raw.includes("should_post=false"));
  },
);

test(
  'DRY_RUN="false" → posts on an otherwise-successful stable run',
  { timeout: 30_000 },
  async () => {
    const { status, raw } = await postFor("false");
    assert.equal(status, 0);
    assert.ok(raw.includes("should_post=true"));
  },
);

test(
  'DRY_RUN="" (empty) → posts on an otherwise-successful stable run',
  { timeout: 30_000 },
  async () => {
    const { status, raw } = await postFor("");
    assert.equal(status, 0);
    assert.ok(raw.includes("should_post=true"));
  },
);

// ---- wrapper CLI end-to-end message rendering (subprocess) ------------------
test(
  "mixed lane: npm success + PyPI failure → one 🚀 line and one 🔴 line in one message",
  { timeout: 30_000 },
  async () => {
    const dir = mkTmp();
    try {
      const out = join(dir, "gho.txt");
      writeFileSync(out, "");
      const { status } = await runWrapper({
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: out,
        MODE: "stable",
        NPM_RESULT: "success",
        BUILD_RESULT: "success",
        NPM_INTENDED: "true",
        TS_PACKAGES: '[{"name":"@ag-ui/core","version":"1.0.0"}]',
        TS_GROUPS: '{"latest":["@ag-ui/core"]}',
        PY_INTENDED: "true",
        PY_RESULT: "failure",
        PY_BUILD_RESULT: "success",
        // Build succeeded and detected a PyPI package, then the shared publish
        // job failed: the detected package set is the authoritative
        // "release attempted" signal the failure arm now gates on.
        PY_PACKAGES: '[{"name":"ag-ui-protocol","version":"1.0.0"}]',
        RUN_URL,
      });
      assert.equal(status, 0);
      const m = readFileSync(out, "utf8").match(
        /^message<<(\S+)\n([\s\S]*?)\n\1\n/m,
      );
      assert.notEqual(m, null);
      const message = m![2];
      assert.ok(message.includes("🚀"));
      assert.ok(message.includes("🔴"));
      assert.ok(message.includes("PyPI release failed"));
      assert.equal(message.split("\n").length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "PyPI build failure during a real release (PY_BUILD_RESULT=failure, publish skipped) → 🔴 PyPI alert",
  { timeout: 30_000 },
  async () => {
    const dir = mkTmp();
    try {
      const out = join(dir, "gho.txt");
      writeFileSync(out, "");
      const { status } = await runWrapper({
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: out,
        PY_INTENDED: "true",
        PY_RESULT: "skipped",
        PY_BUILD_RESULT: "failure",
        RUN_URL,
      });
      assert.equal(status, 0);
      const raw = readFileSync(out, "utf8");
      assert.ok(raw.includes("should_post=true"));
      const m = raw.match(/^message<<(\S+)\n([\s\S]*?)\n\1\n/m);
      assert.notEqual(m, null);
      assert.ok(m![2].includes("🔴"));
      assert.ok(m![2].includes("PyPI release failed"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "routine merge (MODE='', no intent, build skipped) → should_post=false (no false red)",
  { timeout: 30_000 },
  async () => {
    const dir = mkTmp();
    try {
      const out = join(dir, "gho.txt");
      writeFileSync(out, "");
      const { status } = await runWrapper({
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: out,
        MODE: "",
        BUILD_RESULT: "skipped",
        NPM_RESULT: "skipped",
        NPM_INTENDED: "false",
        PY_INTENDED: "false",
        PY_RESULT: "skipped",
        PY_BUILD_RESULT: "skipped",
        RUN_URL,
      });
      assert.equal(status, 0);
      assert.ok(readFileSync(out, "utf8").includes("should_post=false"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "npm success with empty TS_PACKAGES (degraded) → no false success line",
  { timeout: 30_000 },
  async () => {
    const dir = mkTmp();
    try {
      const out = join(dir, "gho.txt");
      writeFileSync(out, "");
      const { status } = await runWrapper({
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: out,
        MODE: "stable",
        NPM_RESULT: "success",
        BUILD_RESULT: "success",
        TS_PACKAGES: "",
        TS_GROUPS: "",
      });
      assert.equal(status, 0);
      assert.ok(readFileSync(out, "utf8").includes("should_post=false"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
