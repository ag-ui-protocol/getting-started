import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/release/prepare-release.ts");
const DOTNET_PROPS = "sdks/dotnet/Directory.Build.props";
const MANAGED_AGENTS_PROPS =
  "integrations/claude-managed-agents/dotnet/Directory.Build.props";

// Read the .NET shared VersionPrefix from ground truth rather than hardcoding
// the shipping version. Hardcoding it made this test chase every prod version
// bump (e.g. it broke when the packages went 0.0.1 -> 0.0.3); deriving the
// expected values from the real props file keeps the test focused on what
// prepare-release.ts actually does — parse the current version and apply the
// requested semver bump — without tracking releases.
function currentDotnetVersion(props = DOTNET_PROPS): string {
  const content = readFileSync(join(process.cwd(), props), "utf8");
  const match = content.match(
    /<VersionPrefix(?:\s+[^>]*)?>([^<]+)<\/VersionPrefix>/,
  );
  assert.ok(match, `Cannot read <VersionPrefix> from ${props}`);
  return match[1];
}

function bumpMinor(version: string): string {
  const [major, minor] = version.split(".").map((n) => parseInt(n, 10));
  return `${major}.${minor + 1}.0`;
}

async function runPrepareRelease(
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", SCRIPT, ...args], {
      env: process.env,
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
  "dry-run bumps sdk-dotnet shared VersionPrefix from Directory.Build.props",
  { timeout: 30_000 },
  async () => {
    const expectedOldVersion = currentDotnetVersion();
    const expectedNewVersion = bumpMinor(expectedOldVersion);

    const result = await runPrepareRelease([
      "--scope",
      "sdk-dotnet",
      "--bump",
      "minor",
      "--dry-run",
    ]);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.scope, "sdk-dotnet");
    assert.equal(output.packages.length, 5);
    assert.deepEqual(
      output.packages.map((pkg: { name: string }) => pkg.name),
      [
        "AGUI.Abstractions",
        "AGUI.Formatting",
        "AGUI.Protobuf",
        "AGUI.Client",
        "AGUI.Server",
      ],
    );
    for (const pkg of output.packages) {
      assert.equal(pkg.oldVersion, expectedOldVersion);
      assert.equal(pkg.newVersion, expectedNewVersion);
      assert.equal(pkg.file, DOTNET_PROPS);
      assert.equal(pkg.ecosystem, "dotnet");
    }
  },
);

// Pins the wiring of the second .NET scope end to end. It also guards the
// version-source lookup: prepare-release.ts assumed every .NET package versioned
// off sdks/dotnet/Directory.Build.props, so any future non-shared .NET scope
// would have bumped — and reported — the wrong file for this package.
test(
  "dry-run bumps a .NET integration from its own Directory.Build.props",
  { timeout: 30_000 },
  async () => {
    const expectedOldVersion = currentDotnetVersion(MANAGED_AGENTS_PROPS);
    const expectedNewVersion = bumpMinor(expectedOldVersion);

    const result = await runPrepareRelease([
      "--scope",
      "integration-claude-managed-agents-dotnet",
      "--bump",
      "minor",
      "--dry-run",
    ]);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.scope, "integration-claude-managed-agents-dotnet");
    assert.deepEqual(
      output.packages.map((pkg: { name: string }) => pkg.name),
      ["AGUI.ClaudeManagedAgents"],
    );
    const [pkg] = output.packages;
    assert.equal(pkg.oldVersion, expectedOldVersion);
    assert.equal(pkg.newVersion, expectedNewVersion);
    // Its own props file, not the SDK's.
    assert.equal(pkg.file, MANAGED_AGENTS_PROPS);
    assert.equal(pkg.ecosystem, "dotnet");
    assert.equal(
      pkg.path,
      "integrations/claude-managed-agents/dotnet/src/AGUI.ClaudeManagedAgents",
    );
  },
);
