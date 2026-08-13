/**
 * Smoke-test for the 0.1.0-schemas-to-subpath codemod.
 *
 * Runs the transform against the input fixture via jscodeshift subprocess and
 * diffs the result against the expected fixture. Exits 0 on success, 1 on mismatch.
 *
 * Usage:
 *   npx ts-node codemods/test.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const FIXTURES_DIR = join(__dirname, "__fixtures__");
const INPUT = join(FIXTURES_DIR, "0.1.0-schemas-to-subpath.input.ts");
const EXPECTED = join(FIXTURES_DIR, "0.1.0-schemas-to-subpath.expected.ts");
const CODEMOD = resolve(__dirname, "0.1.0-schemas-to-subpath.ts");

// Use a unique temp directory per run so concurrent invocations don't race.
const TMP_DIR = mkdtempSync(join(tmpdir(), "codemod-test-"));
const TEMP = join(TMP_DIR, "codemod-test.ts");

copyFileSync(INPUT, TEMP);

// `shell: true` lets us invoke npx via the shell — required on Windows where
// the binary is `npx.cmd` and Node 24's execFileSync no longer performs
// PATHEXT resolution. Args are static literals so shell injection is not a
// concern; CODEMOD and TEMP are absolute paths derived from __dirname/tmpdir.
execFileSync(
  "npx",
  ["--yes", "jscodeshift", "-t", CODEMOD, "--parser=tsx", TEMP],
  { stdio: "inherit", shell: true },
);

const actual = readFileSync(TEMP, "utf8");
const expected = readFileSync(EXPECTED, "utf8");

// Normalize line endings and trailing whitespace for comparison
const normalize = (s: string) => s.replace(/\r\n/g, "\n").trimEnd() + "\n";

if (normalize(actual) === normalize(expected)) {
  console.log("PASS — codemod output matches expected fixture.");
  process.exit(0);
} else {
  console.error("FAIL — codemod output differs from expected.");
  const actualLines = normalize(actual).split("\n");
  const expectedLines = normalize(expected).split("\n");
  const maxLines = Math.max(actualLines.length, expectedLines.length);
  for (let i = 0; i < maxLines; i++) {
    const a = actualLines[i] ?? "<missing>";
    const e = expectedLines[i] ?? "<missing>";
    if (a !== e) {
      console.error(`  Line ${i + 1}:`);
      console.error(`    expected: ${JSON.stringify(e)}`);
      console.error(`    actual:   ${JSON.stringify(a)}`);
    }
  }
  process.exit(1);
}
