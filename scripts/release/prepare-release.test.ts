import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/release/prepare-release.ts");
const DOTNET_PROPS = "sdks/dotnet/Directory.Build.props";
const MANAGED_AGENTS_PROPS =
  "integrations/claude-managed-agents/dotnet/Directory.Build.props";
const JAVA_POM = "sdks/community/java/ag-ui/pom.xml";

// Same reasoning as currentDotnetVersion: read ground truth so the test tracks
// what the bumper DOES, not what version happens to be shipping. Parses the
// project-level <version> — a pom has <version> for its parent, dependencies
// and plugins too, so anchor on the reactor's own <artifactId>/<version> pair.
function currentJavaVersion(pom = JAVA_POM): string {
  const content = readFileSync(join(process.cwd(), pom), "utf8");
  const match = content.match(
    /<artifactId>java-ag-ui<\/artifactId>\s*<version>([^<]+)<\/version>/,
  );
  assert.ok(match, `Cannot read reactor <version> from ${pom}`);
  return match[1];
}

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
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", SCRIPT, ...args], {
      env: { ...process.env, ...extraEnv },
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

// Pins the Maven scope end to end. The load-bearing detail is `files`: a Maven
// bump rewrites the reactor pom AND every module's <parent><version>, because
// Maven requires the parent version to be a literal. A caller that staged only
// `packages[].file` (the version SOURCE) would commit a reactor whose modules
// still point at the old version, leaving main unbuildable.
test(
  "dry-run bumps sdk-java shared version from the reactor pom",
  { timeout: 30_000 },
  async () => {
    const expectedOldVersion = currentJavaVersion();
    const expectedNewVersion = bumpMinor(expectedOldVersion);

    const result = await runPrepareRelease([
      "--scope",
      "sdk-java",
      "--bump",
      "minor",
      "--dry-run",
    ]);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.scope, "sdk-java");
    assert.deepEqual(
      output.packages.map((pkg: { name: string }) => pkg.name),
      ["java-core", "java-client", "java-server"],
    );
    for (const pkg of output.packages) {
      assert.equal(pkg.oldVersion, expectedOldVersion);
      assert.equal(pkg.newVersion, expectedNewVersion);
      // Every module versions off the reactor pom, not its own pom.
      assert.equal(pkg.file, JAVA_POM);
      assert.equal(pkg.ecosystem, "maven");
      // groupId is what detect-java-version-changes.sh builds its Maven Central
      // lookup URL from; a missing one would 404 and read as "never published".
      assert.equal(pkg.groupId, "com.ag-ui.community");
    }
    // --dry-run writes nothing, so nothing is reported as written.
    assert.deepEqual(output.files, []);
  },
);

// The reactor pom carries <version> elements for plugins (maven-gpg-plugin
// 3.2.8, jacoco, ...) and dependencies BELOW the project version. A bumper that
// grabbed "the first <version>" or used a global regex would rewrite one of
// those instead. Assert the reported version is the reactor's, not a plugin's.
test(
  "sdk-java reads the project version, not a plugin or dependency version",
  { timeout: 30_000 },
  async () => {
    const result = await runPrepareRelease([
      "--scope",
      "sdk-java",
      "--bump",
      "patch",
      "--dry-run",
    ]);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    const [pkg] = output.packages;
    assert.equal(pkg.oldVersion, currentJavaVersion());

    const pom = readFileSync(join(process.cwd(), JAVA_POM), "utf8");
    const pluginVersions = [
      ...pom.matchAll(
        /<artifactId>maven-gpg-plugin<\/artifactId>\s*<version>([^<]+)<\/version>/g,
      ),
    ].map((m) => m[1]);
    assert.ok(
      pluginVersions.length > 0,
      "expected the pom to pin a plugin version",
    );
    for (const pluginVersion of pluginVersions) {
      assert.notEqual(
        pkg.oldVersion,
        pluginVersion,
        `read a plugin version (${pluginVersion}) as the reactor version`,
      );
    }
  },
);

// The one behaviour a dry-run cannot cover, and the one most likely to break
// main: a real bump must rewrite the reactor pom AND every module's
// <parent><version>. Maven forbids property interpolation in a parent version,
// so a root-only edit leaves every module pointing at a parent that no longer
// exists and `mvn install` fails at resolution. Runs the real writer against the
// working tree and restores it in `finally`.
test(
  "a real sdk-java bump rewrites the reactor pom AND every module parent",
  { timeout: 30_000 },
  async () => {
    const modulePoms = ["core", "client", "server"].map((m) =>
      join("sdks/community/java/ag-ui", m, "pom.xml"),
    );
    const touched = [JAVA_POM, ...modulePoms];
    const original = new Map(
      touched.map((p) => [p, readFileSync(join(process.cwd(), p), "utf8")]),
    );

    const oldVersion = currentJavaVersion();
    const newVersion = bumpMinor(oldVersion);

    try {
      const result = await runPrepareRelease([
        "--scope",
        "sdk-java",
        "--bump",
        "minor",
      ]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      const output = JSON.parse(result.stdout);
      assert.deepEqual(
        [...output.files].sort(),
        [...touched].sort(),
        "every written pom must be reported in `files` so the release PR stages it",
      );

      assert.equal(currentJavaVersion(), newVersion);
      for (const modulePom of modulePoms) {
        const content = readFileSync(join(process.cwd(), modulePom), "utf8");
        const parent = content.match(
          /<parent>[\s\S]*?<version>([^<]+)<\/version>[\s\S]*?<\/parent>/,
        );
        assert.ok(parent, `no <parent><version> in ${modulePom}`);
        assert.equal(
          parent[1],
          newVersion,
          `${modulePom} still points at the old parent version`,
        );
      }
    } finally {
      for (const [p, content] of original) {
        writeFileSync(join(process.cwd(), p), content, "utf8");
      }
    }

    // Restored, so a failure here does not leave the repo bumped.
    assert.equal(currentJavaVersion(), oldVersion);
  },
);

// The write path was previously untestable: repoRoot was pinned to the script's
// own location, so a non-dry-run would have edited the real repo, leaving
// --dry-run (which never writes) as the only safe mode. PREPARE_RELEASE_ROOT
// redirects config, package files and lockfiles at a throwaway tree, so the
// uv.lock re-lock can be exercised for real.
//
// Guards the drift behind #2313/#2314: bumping pyproject.toml alone left every
// released package's uv.lock self-entry a version stale.
function haveUv(): boolean {
  const probe = spawnSync("uv", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

async function buildFixture(
  {
    withDependent = false,
    virtualReleased = false,
  }: { withDependent?: boolean; virtualReleased?: boolean } = {},
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "prepare-release-fixture-"));
  mkdirSync(join(root, "scripts/release"), { recursive: true });
  mkdirSync(join(root, "fixture-pkg"), { recursive: true });

  writeFileSync(
    join(root, "scripts/release/release.config.json"),
    JSON.stringify({
      prereleaseTag: "alpha",
      scopes: {
        "fixture-py": {
          description: "Fixture package (Python, uv)",
          sharedVersion: false,
          packages: [
            {
              name: "fixture_pkg",
              path: "fixture-pkg",
              ecosystem: "python",
              buildSystem: "uv",
            },
          ],
        },
      },
    }),
  );

  // No dependencies, so `uv lock` needs no network and resolves instantly.
  writeFileSync(
    join(root, "fixture-pkg/pyproject.toml"),
    [
      "[project]",
      'name = "fixture_pkg"',
      'version = "0.1.0"',
      'requires-python = ">=3.10"',
      "dependencies = []",
      "",
      // `package = false` makes this a VIRTUAL project, which changes the source
      // form a consumer's lock records for it from `directory` to `virtual`.
      // A virtual project has no build backend -- it is not installable.
      ...(virtualReleased
        ? ["[tool.uv]", "package = false", ""]
        : ["[build-system]", 'requires = ["hatchling"]', 'build-backend = "hatchling.build"', ""]),
    ].join("\n"),
  );

  // Seed a real lock rather than hand-writing one, so the self-entry is
  // whatever this uv actually emits.
  const seed = spawnSync("uv", ["lock"], {
    cwd: join(root, "fixture-pkg"),
    stdio: "ignore",
  });
  assert.equal(seed.status, 0, "fixture `uv lock` seed failed");

  // A second, UNRELEASED package that consumes the released one through a
  // `[tool.uv.sources]` path override — the shape integrations/langgraph/python
  // has while PNI-274 is open. Its lock embeds the released package's VERSION,
  // so bumping the released package alone strands it.
  if (withDependent) {
    mkdirSync(join(root, "fixture-dep"), { recursive: true });
    writeFileSync(
      join(root, "fixture-dep/pyproject.toml"),
      [
        "[project]",
        'name = "fixture_dep"',
        'version = "9.9.9"',
        'requires-python = ">=3.10"',
        'dependencies = ["fixture_pkg"]',
        "",
        "[tool.uv.sources]",
        'fixture_pkg = { path = "../fixture-pkg" }',
        "",
        "[build-system]",
        'requires = ["hatchling"]',
        'build-backend = "hatchling.build"',
        "",
      ].join("\n"),
    );
    const depSeed = spawnSync("uv", ["lock"], {
      cwd: join(root, "fixture-dep"),
      stdio: "ignore",
    });
    assert.equal(depSeed.status, 0, "dependent fixture `uv lock` seed failed");
  }

  return root;
}

// The version some OTHER lock records for a package it pulls in from a local
// directory. uv writes the path source as `directory = "<rel>"`, and the
// embedded version goes stale the moment the released package is bumped.
function pathDepVersion(lockPath: string, relDir: string): string | null {
  const blocks = readFileSync(lockPath, "utf8").split("[[package]]");
  for (const block of blocks) {
    // uv writes `directory`, `editable` or `virtual` depending on the target; the
    // embedded version goes stale either way, so accept all three here.
    const isPathSource = ["directory", "editable", "virtual"].some((form) =>
      block.includes(`source = { ${form} = "${relDir}" }`),
    );
    if (!isPathSource) continue;
    const match = block.match(/^version = "([^"]+)"/m);
    if (match) return match[1];
  }
  return null;
}

function selfEntryVersion(lockPath: string): string | null {
  // The locked package is the one whose source is the local directory.
  const blocks = readFileSync(lockPath, "utf8").split("[[package]]");
  for (const block of blocks) {
    if (!block.includes('source = { editable = "." }')) continue;
    const match = block.match(/^version = "([^"]+)"/m);
    if (match) return match[1];
  }
  return null;
}

test(
  "a Python version bump re-locks uv.lock's self-entry",
  { timeout: 120_000, skip: haveUv() ? false : "uv not on PATH" },
  async () => {
    const root = await buildFixture();
    const pyproject = join(root, "fixture-pkg/pyproject.toml");
    const lock = join(root, "fixture-pkg/uv.lock");

    assert.equal(selfEntryVersion(lock), "0.1.0", "fixture seed lock");

    const result = await runPrepareRelease(["--scope", "fixture-py", "--bump", "minor"], {
      PREPARE_RELEASE_ROOT: root,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    // stdout must stay parseable — uv's own output is discarded for this reason.
    const output = JSON.parse(result.stdout);
    assert.equal(output.packages[0].newVersion, "0.2.0");

    assert.match(readFileSync(pyproject, "utf8"), /^version = "0\.2\.0"$/m);
    // The regression: this stayed at 0.1.0 before the fix.
    assert.equal(selfEntryVersion(lock), "0.2.0", "uv.lock self-entry not re-locked");

    rmSync(root, { recursive: true, force: true });
  },
);

// Re-locking the file on disk is only half the job. The release workflow stages
// exactly the paths named in `files` (`for f in $FILES; do git add "$f"; done`),
// so a lock that is rewritten but not reported never reaches the release commit
// and the `uv lock --check` gate rejects the PR. crew-ai 0.3.0 (#2366) and
// aws-strands 0.2.5 (#2374) both had to be unblocked by hand for this reason.
test(
  "a Python version bump reports uv.lock among the modified files",
  { timeout: 120_000, skip: haveUv() ? false : "uv not on PATH" },
  async () => {
    const root = await buildFixture();

    const result = await runPrepareRelease(["--scope", "fixture-py", "--bump", "minor"], {
      PREPARE_RELEASE_ROOT: root,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.deepEqual(
      output.files,
      ["fixture-pkg/pyproject.toml", "fixture-pkg/uv.lock"],
      "uv.lock missing from `files` — the release workflow would not stage it",
    );

    rmSync(root, { recursive: true, force: true });
  },
);

// A package with no uv.lock must not gain a phantom entry in `files`: the
// workflow would `git add` a path that does not exist and abort the release.
// (buildFixture seeds a real lock with `uv lock`, hence the same uv guard.)
test("a Python bump with no uv.lock reports only the manifest", {
  timeout: 120_000,
  skip: haveUv() ? false : "uv not on PATH",
}, async () => {
  const root = await buildFixture();
  rmSync(join(root, "fixture-pkg/uv.lock"), { force: true });

  const result = await runPrepareRelease(["--scope", "fixture-py", "--bump", "minor"], {
    PREPARE_RELEASE_ROOT: root,
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.files, ["fixture-pkg/pyproject.toml"]);

  rmSync(root, { recursive: true, force: true });
});

// A released package can be consumed by another first-party package through a
// `[tool.uv.sources]` path override. That consumer's uv.lock embeds the released
// package's VERSION, so bumping the release alone leaves the consumer's lock
// stale and the `uv lock --check` gate turns the release PR red in a package the
// release did not even touch.
//
// This is the failure behind #2553: release/next bumped ag-ui-protocol
// 0.1.20 -> 0.1.21 in sdks/python, and both the `lockfiles` and
// `langgraph-python` jobs failed on integrations/langgraph/python/uv.lock —
// which pins `ag-ui-protocol 0.1.20` from `directory = "../../../sdks/python"`.
// Nothing was wrong with the PR; the bumper simply never relocked the consumer.
test(
  "a Python version bump re-locks packages that path-depend on the bumped one",
  { timeout: 120_000, skip: haveUv() ? false : "uv not on PATH" },
  async () => {
    const root = await buildFixture({ withDependent: true });
    const depLock = join(root, "fixture-dep/uv.lock");

    assert.equal(
      pathDepVersion(depLock, "../fixture-pkg"),
      "0.1.0",
      "dependent fixture seed lock",
    );

    const result = await runPrepareRelease(["--scope", "fixture-py", "--bump", "minor"], {
      PREPARE_RELEASE_ROOT: root,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    // The regression: this stayed at 0.1.0, so `uv lock --check` failed here.
    assert.equal(
      pathDepVersion(depLock, "../fixture-pkg"),
      "0.2.0",
      "dependent uv.lock not re-locked",
    );

    // And it must be REPORTED, or the workflow never stages it — same failure
    // mode as the released package's own lock.
    const output = JSON.parse(result.stdout);
    assert.deepEqual(
      output.files,
      // `files` is emitted sorted.
      [
        "fixture-dep/uv.lock",
        "fixture-pkg/pyproject.toml",
        "fixture-pkg/uv.lock",
      ],
      "dependent uv.lock missing from `files`",
    );

    rmSync(root, { recursive: true, force: true });
  },
);

// uv records a path dependency in three different source forms, and the matcher
// that finds dependents has to know all three or it silently skips one:
//
//     source = { directory = "../pkg" }   non-editable path source
//     source = { editable  = "../pkg" }   editable path source
//     source = { virtual   = "../pkg" }   target sets `[tool.uv] package = false`
//
// `virtual` is the easy one to miss, because it is the form that does NOT
// correspond to something installable -- but uv still records `version = "..."`
// for it, so it still goes stale on a bump and still fails `uv lock --check`.
// Reported on #2555 review with a reproduction; this is that reproduction as a
// test. Before the fix the matcher covered only directory|editable, so the
// dependent below kept the old version and never reached `files`.
test(
  "a Python version bump re-locks a dependent that records the `virtual` path form",
  { timeout: 120_000, skip: haveUv() ? false : "uv not on PATH" },
  async () => {
    const root = await buildFixture({ withDependent: true, virtualReleased: true });
    const depLock = join(root, "fixture-dep/uv.lock");

    // Guard the fixture itself: if uv ever stops emitting `virtual` here, this
    // test would pass for the wrong reason, so assert the form is really present.
    assert.match(
      readFileSync(depLock, "utf8"),
      /source = \{ virtual = "\.\.\/fixture-pkg" \}/,
      "fixture did not produce a `virtual` path source -- test would be vacuous",
    );
    assert.equal(pathDepVersion(depLock, "../fixture-pkg"), "0.1.0", "dependent seed lock");

    const result = await runPrepareRelease(["--scope", "fixture-py", "--bump", "minor"], {
      PREPARE_RELEASE_ROOT: root,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    assert.equal(
      pathDepVersion(depLock, "../fixture-pkg"),
      "0.2.0",
      "dependent uv.lock not re-locked through the `virtual` source form",
    );

    const output = JSON.parse(result.stdout);
    assert.ok(
      output.files.includes("fixture-dep/uv.lock"),
      `dependent uv.lock missing from \`files\`: ${JSON.stringify(output.files)}`,
    );

    rmSync(root, { recursive: true, force: true });
  },
);
