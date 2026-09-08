#!/usr/bin/env npx tsx
/**
 * prepare-release.ts
 *
 * Bumps versions for a given release scope and outputs a JSON summary.
 *
 * Usage:
 *   npx tsx scripts/release/prepare-release.ts --scope <scope> --bump <patch|minor|major|prerelease> [--preid alpha] [--dry-run]
 *
 * Reads scope definitions from scripts/release/release.config.json.
 * For TypeScript packages, edits package.json.
 * For Python packages, edits pyproject.toml using regex (handles both
 * [project].version and [tool.poetry].version).
 * For .NET packages, edits the VersionPrefix in the Directory.Build.props the
 * scope names as its `versionSource`.
 * For Maven packages, edits the project <version> in the reactor pom.xml the
 * scope names as its `versionSource`, AND the <parent><version> of every module
 * that pom lists — Maven requires the parent version to be a literal, so the
 * reactor version is physically repeated in each module and a root-only edit
 * leaves the build unresolvable.
 *
 * Outputs JSON to stdout:
 *   {
 *     "scope": "...",
 *     "packages": [{ "name", "oldVersion", "newVersion", "file", "path" }],
 *     "files": ["<every file actually written>"]
 *   }
 *
 * `files` exists because a package's `file` is its VERSION SOURCE, which for
 * Maven is not the complete set of files the bump touched. Callers that stage a
 * commit (prepare-release.yml) must use `files`, or a Maven bump commits a root
 * pom whose modules still declare the old parent version.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  scope: string;
  bump: "patch" | "minor" | "major" | "prerelease";
  preid: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: Partial<CliArgs> = { preid: "alpha", dryRun: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--scope":
        parsed.scope = args[++i];
        break;
      case "--bump":
        parsed.bump = args[++i] as CliArgs["bump"];
        break;
      case "--preid":
        parsed.preid = args[++i];
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
    }
  }

  if (!parsed.scope || !parsed.bump) {
    console.error(
      "Usage: prepare-release.ts --scope <scope> --bump <patch|minor|major|prerelease> [--preid alpha] [--dry-run]"
    );
    process.exit(1);
  }

  if (!["patch", "minor", "major", "prerelease"].includes(parsed.bump!)) {
    console.error(`Invalid bump type: ${parsed.bump}`);
    process.exit(1);
  }

  return parsed as CliArgs;
}

// ---------------------------------------------------------------------------
// Version utilities (simple semver — no external dependency)
// ---------------------------------------------------------------------------

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseSemVer(version: string): SemVer {
  // Handles X.Y.Z and X.Y.Z-tag.N
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/
  );
  if (!match) {
    throw new Error(`Cannot parse version: ${version}`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
  };
}

function formatSemVer(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease ? `${base}-${v.prerelease}` : base;
}

function bumpVersion(
  current: string,
  bump: CliArgs["bump"],
  preid: string
): string {
  const v = parseSemVer(current);

  switch (bump) {
    case "major":
      return formatSemVer({ major: v.major + 1, minor: 0, patch: 0, prerelease: null });
    case "minor":
      return formatSemVer({ major: v.major, minor: v.minor + 1, patch: 0, prerelease: null });
    case "patch":
      if (v.prerelease) {
        // If currently a prerelease, patch bump just drops the prerelease
        return formatSemVer({ ...v, prerelease: null });
      }
      return formatSemVer({ major: v.major, minor: v.minor, patch: v.patch + 1, prerelease: null });
    case "prerelease": {
      if (v.prerelease) {
        // Already a prerelease — increment the numeric suffix
        const match = v.prerelease.match(/^(.+)\.(\d+)$/);
        if (match && match[1] === preid) {
          return formatSemVer({ ...v, prerelease: `${preid}.${parseInt(match[2], 10) + 1}` });
        }
        // Different preid or no numeric suffix — start at 0
        return formatSemVer({ ...v, prerelease: `${preid}.0` });
      }
      // Not a prerelease — bump patch and add prerelease tag
      return formatSemVer({
        major: v.major,
        minor: v.minor,
        patch: v.patch + 1,
        prerelease: `${preid}.0`,
      });
    }
  }
}

/**
 * Convert an npm-style prerelease version to PEP 440 for Python.
 * e.g., "0.0.53-alpha.0" -> "0.0.53a0"
 */
function toPep440(version: string): string {
  const v = parseSemVer(version);
  const base = `${v.major}.${v.minor}.${v.patch}`;
  if (!v.prerelease) return base;

  const match = v.prerelease.match(/^(alpha|beta|rc)\.(\d+)$/);
  if (match) {
    const pep440Map: Record<string, string> = { alpha: "a", beta: "b", rc: "rc" };
    return `${base}${pep440Map[match[1]]}${match[2]}`;
  }

  // For canary/dev/custom tags, use .devN format
  // Extract any numeric suffix for uniqueness
  const numMatch = v.prerelease.match(/(\d+)$/);
  const devNum = numMatch ? numMatch[1] : "0";
  return `${base}.dev${devNum}`;
}

// ---------------------------------------------------------------------------
// Python version bumping (PEP 440 style for non-prerelease)
// ---------------------------------------------------------------------------

function bumpPythonVersion(
  current: string,
  bump: CliArgs["bump"],
  preid: string
): string {
  // Parse PEP 440 version: X.Y.Z or X.Y.ZaN, X.Y.ZbN, X.Y.ZrcN
  const preMatch = current.match(/^(\d+\.\d+\.\d+)(a|b|rc)(\d+)$/);
  if (preMatch) {
    const base = preMatch[1];
    const tag = preMatch[2];
    const num = parseInt(preMatch[3], 10);

    switch (bump) {
      case "patch":
      case "minor":
      case "major": {
        // For stable bumps on a prerelease, convert to npm-style, bump, convert back
        const npmVersion = `${base}-${tag === "a" ? "alpha" : tag === "b" ? "beta" : "rc"}.${num}`;
        const bumped = bumpVersion(npmVersion, bump, preid);
        return toPep440(bumped);
      }
      case "prerelease": {
        const tagMap: Record<string, string> = { a: "alpha", b: "beta", rc: "rc" };
        const npmPreid = tagMap[tag] || "alpha";
        if (npmPreid === preid) {
          return `${base}${tag}${num + 1}`;
        }
        // Different preid — check if it's a known PEP 440 tag
        const knownTags: Record<string, string> = { alpha: "a", beta: "b", rc: "rc" };
        const preidParts = preid.split(".");
        const preidName = preidParts[0];
        if (knownTags[preidName]) {
          const preidNum = preidParts[1] || "0";
          return `${base}${knownTags[preidName]}${preidNum}`;
        }
        // For canary/custom tags, use .devN with numeric component for uniqueness
        const numPart = preidParts.slice(1).join("") || "0";
        return `${base}.dev${numPart}`;
      }
    }
  }

  // Standard X.Y.Z version
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Cannot parse Python version: ${current}`);
  }
  const [major, minor, patch] = parts;

  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "prerelease": {
      const knownTags: Record<string, string> = { alpha: "a", beta: "b", rc: "rc" };
      const preidParts = preid.split(".");
      const preidName = preidParts[0];
      if (knownTags[preidName]) {
        const preidNum = preidParts[1] || "0";
        return `${major}.${minor}.${patch + 1}${knownTags[preidName]}${preidNum}`;
      }
      // For canary/custom tags, use .devN with numeric component for uniqueness
      const numPart = preidParts.slice(1).join("") || "0";
      return `${major}.${minor}.${patch + 1}.dev${numPart}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

interface PackageConfig {
  name: string;
  path: string;
  ecosystem: "typescript" | "python" | "dotnet" | "maven";
  buildSystem?: "uv" | "poetry";
  /** Maven only: the groupId the artifact publishes under. */
  groupId?: string;
}

interface ScopeConfig {
  description: string;
  sharedVersion: boolean;
  versionSource?: string;
  packages: PackageConfig[];
}

interface ReleaseConfig {
  scopes: Record<string, ScopeConfig>;
}

// ---------------------------------------------------------------------------
// Package version reading / writing
// ---------------------------------------------------------------------------

function readTsVersion(pkgJsonPath: string): string {
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  return pkg.version;
}

function writeTsVersion(pkgJsonPath: string, newVersion: string): void {
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  pkg.version = newVersion;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

function readPyVersion(pyprojectPath: string): string {
  const content = fs.readFileSync(pyprojectPath, "utf-8");
  const lines = content.split('\n');
  let inProjectSection = false;
  let inPoetrySection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Detect section headers: lines starting with [ but not [[ (TOML array of tables)
    if (trimmed.startsWith('[') && !trimmed.startsWith('[[')) {
      inProjectSection = trimmed === '[project]';
      inPoetrySection = trimmed === '[tool.poetry]';
      continue;
    }
    if ((inProjectSection || inPoetrySection) && trimmed.startsWith('version')) {
      const match = trimmed.match(/^version\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  }

  throw new Error(`Cannot read version from ${pyprojectPath}`);
}

function writePyVersion(pyprojectPath: string, newVersion: string): void {
  const content = fs.readFileSync(pyprojectPath, "utf-8");
  const lines = content.split('\n');
  let inProjectSection = false;
  let inPoetrySection = false;
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Detect section headers: lines starting with [ but not [[ (TOML array of tables)
    if (trimmed.startsWith('[') && !trimmed.startsWith('[[')) {
      inProjectSection = trimmed === '[project]';
      inPoetrySection = trimmed === '[tool.poetry]';
      continue;
    }
    if ((inProjectSection || inPoetrySection) && trimmed.startsWith('version')) {
      const match = lines[i].match(/^(\s*version\s*=\s*)"[^"]*"/);
      if (match) {
        lines[i] = lines[i].replace(/^(\s*version\s*=\s*)"[^"]*"/, `$1"${newVersion}"`);
        replaced = true;
        break;
      }
    }
  }

  if (!replaced) {
    throw new Error(`Cannot find version field in ${pyprojectPath}`);
  }

  fs.writeFileSync(pyprojectPath, lines.join('\n'), "utf-8");
}

/**
 * Re-lock a uv-managed Python package after its version has been bumped.
 *
 * uv.lock carries an entry for the package it locks -- the one whose ``source``
 * is ``{ editable = "." }`` -- so editing pyproject.toml alone leaves that entry
 * one version stale. Every release did exactly that, so every release shipped a
 * stale lock: four consecutive aws-strands releases are each a one-line,
 * one-file commit, and ag_ui_adk drifted five releases deep before anyone
 * noticed. #2313 repaired the accumulated drift; this stops it recurring.
 *
 * ``uv lock`` may also flush latent metadata corrections that have nothing to do
 * with the bump -- it rewrites the whole file once it has any reason to, and what
 * it writes reflects the package metadata in uv's cache at that moment. Observed:
 * the same uv binary added an ``exceptiongroup`` dependency marker on Aug 4 that
 * it had not added on Jul 30, because the cache had refreshed from PyPI in
 * between. Those are corrections rather than corruption, and the companion
 * ``uv lock --check`` CI gate is what keeps them from piling up: with locks kept
 * continuously current, a release bump has nothing extra to flush and its diff
 * stays to the version line.
 *
 * Packages with no uv.lock (poetry-managed, or unlocked) are skipped. A missing
 * ``uv`` is fatal rather than skipped -- silently shipping a stale lock is the
 * exact failure this exists to prevent.
 *
 * Returns the absolute path of the lock it rewrote, or ``null`` when there was
 * nothing to re-lock. **The caller must report that path**: rewriting the file
 * on disk is only half the job, because the release workflow stages exactly the
 * paths this script names in its ``files`` output --
 *
 *     for f in $FILES; do git add "$f"; done
 *
 * -- and nothing else. A lock that is regenerated but not reported is left
 * unstaged in the runner's working tree and discarded when the job ends, so the
 * release PR carries the pyproject bump alone and the ``uv lock --check`` gate
 * added alongside this function rejects it. That is not hypothetical: it is why
 * crew-ai 0.3.0 (#2366) and aws-strands 0.2.5 (#2374) both needed a hand-pushed
 * "sync uv.lock" commit before their release PRs could go green.
 */
function relockPythonPackage(repoRoot: string, pyprojectPath: string): string[] {
  const pkgDir = path.dirname(pyprojectPath);
  const lockPath = path.join(pkgDir, "uv.lock");

  const rewritten: string[] = [];
  if (fs.existsSync(lockPath)) {
    runUvLock(pkgDir);
    rewritten.push(lockPath);
  }
  for (const dependentLock of findPathDependentLocks(repoRoot, pkgDir)) {
    runUvLock(path.dirname(dependentLock));
    rewritten.push(dependentLock);
  }
  return rewritten;
}

/** `uv lock` in one directory, with the missing-uv case spelled out. */
function runUvLock(pkgDir: string): void {
  try {
    // stdout belongs to this script's JSON summary -- discard uv's so the
    // summary stays parseable, and pass its stderr through for diagnostics.
    execFileSync("uv", ["lock"], {
      cwd: pkgDir,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `uv is required to re-lock ${pkgDir} after a version bump, but was not ` +
          `found on PATH. Install uv (https://docs.astral.sh/uv/) -- without it ` +
          `the release would publish a uv.lock pinning the previous version.`,
      );
    }
    throw error;
  }
}

/**
 * Every OTHER first-party uv.lock that pulls ``pkgDir`` in from the filesystem.
 *
 * A ``[tool.uv.sources]`` path override makes a consumer's lock carry the
 * released package's VERSION, not just its name:
 *
 *     [[package]]
 *     name = "ag-ui-protocol"
 *     version = "0.1.20"
 *     source = { directory = "../../../sdks/python" }
 *
 * So bumping the released package strands every such consumer, and the
 * ``uv lock --check`` gate then fails in a package the release never touched.
 * That is #2553: release/next bumped ag-ui-protocol 0.1.20 -> 0.1.21 and both
 * the ``lockfiles`` and ``langgraph-python`` jobs went red on
 * integrations/langgraph/python/uv.lock.
 *
 * Scope matches the gate this exists to satisfy (see the ``lockfiles`` job in
 * unit-python-sdk.yml): first-party locks only, ``examples/`` excluded. Example
 * locks are deliberately left alone -- they are not gated, several are stale
 * today, and dojo-e2e relocks them non-frozen anyway, so touching them here
 * would drag unrelated dependency churn into every release PR.
 *
 * Matching is on the resolved directory rather than the literal string, because
 * the same package is reached by a different relative path from each consumer.
 */
function findPathDependentLocks(repoRoot: string, pkgDir: string): string[] {
  const SKIP = new Set(["node_modules", ".venv", ".git", "examples"]);
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.name === "uv.lock" && dir !== pkgDir) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(repoRoot);

  return found.filter((lockPath) => {
    const lockDir = path.dirname(lockPath);
    // uv has three directory-based source forms, and all three embed the
    // dependency's version, so all three go stale on a bump:
    //   directory -- a non-editable path source
    //   editable  -- an editable path source
    //   virtual   -- a path source whose target sets `[tool.uv] package = false`
    // `virtual` is easy to miss because it is the one that does not correspond to
    // something installable, but uv still records `version = "..."` for it and
    // still fails `uv lock --check` when that version moves.
    const sources = fs
      .readFileSync(lockPath, "utf-8")
      .matchAll(/^source = \{ (?:directory|editable|virtual) = "([^"]+)" \}$/gm);
    for (const [, rel] of sources) {
      if (path.resolve(lockDir, rel) === pkgDir) return true;
    }
    return false;
  });
}

function readDotnetVersion(propsPath: string): string {
  const content = fs.readFileSync(propsPath, "utf-8");
  const match = content.match(/<VersionPrefix(?:\s+[^>]*)?>([^<]+)<\/VersionPrefix>/);
  if (!match) {
    throw new Error(`Cannot read <VersionPrefix> from ${propsPath}`);
  }
  return match[1];
}

function writeDotnetVersion(propsPath: string, newVersion: string): void {
  const content = fs.readFileSync(propsPath, "utf-8");
  const next = content.replace(
    /(<VersionPrefix(?:\s+[^>]*)?>)([^<]+)(<\/VersionPrefix>)/,
    `$1${newVersion}$3`,
  );
  if (next === content) {
    throw new Error(`Cannot find <VersionPrefix> in ${propsPath}`);
  }
  fs.writeFileSync(propsPath, next, "utf-8");
}

// ---------------------------------------------------------------------------
// Maven pom.xml version bumping
//
// A pom has <version> elements all over it — <parent>, every <dependency>,
// every <plugin>, and arbitrary <properties> like <junit.version>. A "first
// <version> in the file" regex therefore reads the PARENT version in every
// child module and a plugin version in some roots. These helpers walk the
// element tree instead and address elements by their exact path, so
// project>version and project>parent>version are never confused for each other
// or for anything nested deeper.
// ---------------------------------------------------------------------------

/** Blank out comments, preserving byte offsets so ranges stay valid. */
function stripXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
}

interface ElementRange {
  /** Offset of the first character of the element's text content. */
  start: number;
  /** Offset just past the last character of the element's text content. */
  end: number;
}

/**
 * Find the text ranges of every element at an exact element path, e.g.
 * ["project", "parent", "version"]. Offsets index into the ORIGINAL string, so
 * a caller can splice a replacement in directly.
 */
function findElementRanges(content: string, elementPath: string[]): ElementRange[] {
  const scannable = stripXmlComments(content);
  // Tag names may be namespaced (ns:version); attributes are skipped.
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)(?:\s[^>]*?)?(\/?)>/g;
  const stack: string[] = [];
  const ranges: ElementRange[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(scannable)) !== null) {
    const [full, closing, name, selfClosing] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    if (selfClosing) {
      continue;
    }
    stack.push(name);
    if (
      stack.length === elementPath.length &&
      stack.every((n, i) => n === elementPath[i])
    ) {
      const start = match.index + full.length;
      const end = scannable.indexOf(`</${name}>`, start);
      if (end === -1) {
        throw new Error(`Unterminated <${name}> in pom while reading ${elementPath.join(">")}`);
      }
      ranges.push({ start, end });
    }
  }

  return ranges;
}

function findSingleElementRange(content: string, elementPath: string[]): ElementRange | null {
  const ranges = findElementRanges(content, elementPath);
  return ranges.length > 0 ? ranges[0] : null;
}

/** The reactor version: the <version> that is a direct child of <project>. */
function readMavenVersion(pomPath: string): string {
  const content = fs.readFileSync(pomPath, "utf-8");
  const range = findSingleElementRange(content, ["project", "version"]);
  if (!range) {
    throw new Error(`Cannot read project <version> from ${pomPath}`);
  }
  return content.slice(range.start, range.end).trim();
}

function replaceRange(content: string, range: ElementRange, value: string): string {
  return content.slice(0, range.start) + value + content.slice(range.end);
}

/**
 * Write a new reactor version: the root pom's project>version plus the
 * project>parent>version of every module the root lists. Returns the absolute
 * path of every file written so the caller can stage them all.
 */
function writeMavenVersion(pomPath: string, newVersion: string): string[] {
  const rootContent = fs.readFileSync(pomPath, "utf-8");
  const rootRange = findSingleElementRange(rootContent, ["project", "version"]);
  if (!rootRange) {
    throw new Error(`Cannot find project <version> in ${pomPath}`);
  }
  fs.writeFileSync(pomPath, replaceRange(rootContent, rootRange, newVersion), "utf-8");

  const written = [pomPath];
  const reactorDir = path.dirname(pomPath);

  for (const moduleRange of findElementRanges(rootContent, ["project", "modules", "module"])) {
    const moduleName = rootContent.slice(moduleRange.start, moduleRange.end).trim();
    const modulePom = path.join(reactorDir, moduleName, "pom.xml");
    if (!fs.existsSync(modulePom)) {
      throw new Error(
        `Module "${moduleName}" declared in ${pomPath} has no pom.xml at ${modulePom}`,
      );
    }
    const moduleContent = fs.readFileSync(modulePom, "utf-8");
    const parentRange = findSingleElementRange(moduleContent, ["project", "parent", "version"]);
    if (!parentRange) {
      // A module without an inherited parent version is not part of this
      // reactor's shared version and bumping the root would silently orphan it.
      throw new Error(`Cannot find <parent><version> in ${modulePom}`);
    }
    fs.writeFileSync(modulePom, replaceRange(moduleContent, parentRange, newVersion), "utf-8");
    written.push(modulePom);
  }

  return written;
}

/** Verify every module's parent version matches the reactor version. */
function readMavenModuleParentVersions(pomPath: string): Record<string, string> {
  const rootContent = fs.readFileSync(pomPath, "utf-8");
  const reactorDir = path.dirname(pomPath);
  const versions: Record<string, string> = {};
  for (const moduleRange of findElementRanges(rootContent, ["project", "modules", "module"])) {
    const moduleName = rootContent.slice(moduleRange.start, moduleRange.end).trim();
    const modulePom = path.join(reactorDir, moduleName, "pom.xml");
    const moduleContent = fs.readFileSync(modulePom, "utf-8");
    const parentRange = findSingleElementRange(moduleContent, ["project", "parent", "version"]);
    versions[moduleName] = parentRange
      ? moduleContent.slice(parentRange.start, parentRange.end).trim()
      : "";
  }
  return versions;
}

function getVersionFilePath(repoRoot: string, pkg: PackageConfig, versionSource?: string): string {
  if (pkg.ecosystem === "typescript") {
    return path.join(repoRoot, pkg.path, "package.json");
  }
  if (pkg.ecosystem === "dotnet") {
    // A .NET version lives in a shared Directory.Build.props rather than the
    // csproj, and each .NET scope names its own. Assuming the SDK's file bumps
    // the wrong package as soon as a second .NET scope exists, so the scope has
    // to declare it.
    if (!versionSource) {
      throw new Error(
        `Scope for ${pkg.name} must declare a "versionSource" pointing at its Directory.Build.props`
      );
    }
    return path.join(repoRoot, versionSource);
  }
  if (pkg.ecosystem === "maven") {
    // A Maven module inherits its version from the reactor pom; its own pom
    // carries no <version> at all. Same reasoning as .NET: the scope names the
    // reactor pom so a second Maven scope cannot bump the wrong one.
    if (!versionSource) {
      throw new Error(
        `Scope for ${pkg.name} must declare a "versionSource" pointing at its reactor pom.xml`
      );
    }
    return path.join(repoRoot, versionSource);
  }
  return path.join(repoRoot, pkg.path, "pyproject.toml");
}

function readVersionFile(filePath: string, ecosystem: PackageConfig["ecosystem"]): string {
  if (ecosystem === "typescript") {
    return readTsVersion(filePath);
  }
  if (ecosystem === "dotnet") {
    return readDotnetVersion(filePath);
  }
  if (ecosystem === "maven") {
    return readMavenVersion(filePath);
  }
  return readPyVersion(filePath);
}

function readVersion(repoRoot: string, pkg: PackageConfig, versionSource?: string): string {
  const filePath = getVersionFilePath(repoRoot, pkg, versionSource);
  return readVersionFile(filePath, pkg.ecosystem);
}

/** Returns the absolute path of every file written (Maven fans out to modules). */
function writeVersionFile(
  repoRoot: string,
  filePath: string,
  ecosystem: PackageConfig["ecosystem"],
  newVersion: string
): string[] {
  if (ecosystem === "typescript") {
    writeTsVersion(filePath, newVersion);
  } else if (ecosystem === "dotnet") {
    writeDotnetVersion(filePath, newVersion);
  } else if (ecosystem === "maven") {
    return writeMavenVersion(filePath, newVersion);
  } else {
    writePyVersion(filePath, newVersion);
    // Each re-locked uv.lock -- this package's own, plus any consumer that
    // path-depends on it -- is a further modified file and must be reported, or
    // the release workflow never stages it. See relockPythonPackage.
    return [filePath, ...relockPythonPackage(repoRoot, filePath)];
  }
  return [filePath];
}

function writeVersion(
  repoRoot: string,
  pkg: PackageConfig,
  newVersion: string,
  versionSource?: string
): string[] {
  const filePath = getVersionFilePath(repoRoot, pkg, versionSource);
  return writeVersionFile(repoRoot, filePath, pkg.ecosystem, newVersion);
}

function computeNewVersion(
  current: string,
  bump: CliArgs["bump"],
  preid: string,
  ecosystem: PackageConfig["ecosystem"]
): string {
  if (ecosystem === "python") {
    return bumpPythonVersion(current, bump, preid);
  }
  if (ecosystem === "dotnet" && bump === "prerelease") {
    return `${current}-${preid}`;
  }
  return bumpVersion(current, bump, preid);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs();
  // Normally the repo this script ships in. Overridable so tests can point the
  // whole thing -- config, package files, lockfiles -- at a throwaway fixture
  // tree, since the write path cannot otherwise be exercised without editing
  // the real repo.
  const repoRoot =
    process.env.PREPARE_RELEASE_ROOT ?? path.resolve(__dirname, "../..");

  const configPath = path.join(repoRoot, "scripts/release/release.config.json");
  const config: ReleaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  const scopeConfig = config.scopes[args.scope];
  if (!scopeConfig) {
    const available = Object.keys(config.scopes).sort().join(", ");
    console.error(`Unknown scope: "${args.scope}". Available: ${available}`);
    process.exit(1);
  }

  const results: Array<{
    name: string;
    oldVersion: string;
    newVersion: string;
    file: string;
    path: string;
    ecosystem: string;
    buildSystem?: string;
    groupId?: string;
  }> = [];

  // Every file actually written, so callers can stage a complete commit. A
  // package's `file` is only its version SOURCE — for Maven the bump also
  // rewrites each module's <parent><version>.
  const modifiedFiles = new Set<string>();
  const recordWritten = (paths: string[]): void => {
    for (const p of paths) {
      modifiedFiles.add(path.relative(repoRoot, p));
    }
  };

  if (scopeConfig.sharedVersion && scopeConfig.versionSource) {
    // All packages share one version — read from versionSource
    const versionSourcePath = path.join(repoRoot, scopeConfig.versionSource);
    const versionSourceEcosystem = scopeConfig.packages[0]?.ecosystem;
    if (!versionSourceEcosystem) {
      throw new Error(`Scope ${args.scope} has no packages`);
    }
    const currentVersion = readVersionFile(versionSourcePath, versionSourceEcosystem);
    const newVersion = computeNewVersion(currentVersion, args.bump, args.preid, versionSourceEcosystem);

    console.error(`[${args.scope}] Shared version: ${currentVersion} -> ${newVersion}`);

    if (versionSourceEcosystem === "dotnet" && args.bump !== "prerelease" && !args.dryRun) {
      recordWritten(writeVersionFile(repoRoot, versionSourcePath, versionSourceEcosystem, newVersion));
      const written = readVersionFile(versionSourcePath, versionSourceEcosystem);
      if (written !== newVersion) {
        console.error(`ERROR: Verification failed for ${scopeConfig.versionSource}: expected ${newVersion}, got ${written}`);
        process.exit(1);
      }
    }

    // Maven writes the reactor pom for EVERY bump type, including prerelease:
    // unlike .NET (where a prerelease suffix is applied at pack time via
    // -p:VersionSuffix and the props file stays put), the pom is the only place
    // a Maven version exists.
    if (versionSourceEcosystem === "maven" && !args.dryRun) {
      recordWritten(writeVersionFile(repoRoot, versionSourcePath, versionSourceEcosystem, newVersion));
      const written = readVersionFile(versionSourcePath, versionSourceEcosystem);
      if (written !== newVersion) {
        console.error(`ERROR: Verification failed for ${scopeConfig.versionSource}: expected ${newVersion}, got ${written}`);
        process.exit(1);
      }
      // A module left on the old parent version makes the reactor unbuildable,
      // and Maven would only surface it much later, mid-release.
      for (const [moduleName, moduleVersion] of Object.entries(
        readMavenModuleParentVersions(versionSourcePath),
      )) {
        if (moduleVersion !== newVersion) {
          console.error(
            `ERROR: Verification failed for module ${moduleName}: <parent><version> is ${moduleVersion || "(missing)"}, expected ${newVersion}`,
          );
          process.exit(1);
        }
      }
    }

    const sharedVersionSourceFile =
      versionSourceEcosystem === "dotnet" || versionSourceEcosystem === "maven";

    for (const pkg of scopeConfig.packages) {
      const filePath = sharedVersionSourceFile
        ? versionSourcePath
        : getVersionFilePath(repoRoot, pkg, scopeConfig.versionSource);
      const relPath = path.relative(repoRoot, filePath);

      const versionToWrite = pkg.ecosystem === 'python' ? toPep440(newVersion) : newVersion;

      if (!sharedVersionSourceFile && !args.dryRun) {
        recordWritten(writeVersion(repoRoot, pkg, versionToWrite, scopeConfig.versionSource));
        // Verify
        const written = readVersion(repoRoot, pkg, scopeConfig.versionSource);
        if (written !== versionToWrite) {
          console.error(`ERROR: Verification failed for ${pkg.name}: expected ${versionToWrite}, got ${written}`);
          process.exit(1);
        }
      }

      results.push({
        name: pkg.name,
        oldVersion: currentVersion,
        newVersion: versionToWrite,
        file: relPath,
        path: pkg.path,
        ecosystem: pkg.ecosystem,
        ...(pkg.buildSystem && { buildSystem: pkg.buildSystem }),
        ...(pkg.groupId && { groupId: pkg.groupId }),
      });
    }
  } else {
    // Each package has its own version
    for (const pkg of scopeConfig.packages) {
      const filePath = getVersionFilePath(repoRoot, pkg, scopeConfig.versionSource);
      const relPath = path.relative(repoRoot, filePath);
      const currentVersion = readVersion(repoRoot, pkg, scopeConfig.versionSource);
      const newVersion = computeNewVersion(currentVersion, args.bump, args.preid, pkg.ecosystem);

      console.error(`[${args.scope}] ${pkg.name}: ${currentVersion} -> ${newVersion}`);

      if (!args.dryRun) {
        recordWritten(writeVersion(repoRoot, pkg, newVersion, scopeConfig.versionSource));
        // Verify
        const written = readVersion(repoRoot, pkg, scopeConfig.versionSource);
        if (written !== newVersion) {
          console.error(`ERROR: Verification failed for ${pkg.name}: expected ${newVersion}, got ${written}`);
          process.exit(1);
        }
      }

      results.push({
        name: pkg.name,
        oldVersion: currentVersion,
        newVersion,
        file: relPath,
        path: pkg.path,
        ecosystem: pkg.ecosystem,
        ...(pkg.buildSystem && { buildSystem: pkg.buildSystem }),
        ...(pkg.groupId && { groupId: pkg.groupId }),
      });
    }
  }

  // Output JSON summary to stdout (logs go to stderr)
  const output = {
    scope: args.scope,
    packages: results,
    // On --dry-run nothing is written, so this is empty by construction.
    files: [...modifiedFiles].sort(),
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
