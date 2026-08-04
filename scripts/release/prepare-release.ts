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
 *
 * Outputs JSON to stdout:
 *   { "scope": "...", "packages": [{ "name", "oldVersion", "newVersion", "file", "path" }] }
 */

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
  ecosystem: "typescript" | "python" | "dotnet";
  buildSystem?: "uv" | "poetry";
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
  return path.join(repoRoot, pkg.path, "pyproject.toml");
}

function readVersionFile(filePath: string, ecosystem: PackageConfig["ecosystem"]): string {
  if (ecosystem === "typescript") {
    return readTsVersion(filePath);
  }
  if (ecosystem === "dotnet") {
    return readDotnetVersion(filePath);
  }
  return readPyVersion(filePath);
}

function readVersion(repoRoot: string, pkg: PackageConfig, versionSource?: string): string {
  const filePath = getVersionFilePath(repoRoot, pkg, versionSource);
  return readVersionFile(filePath, pkg.ecosystem);
}

function writeVersionFile(filePath: string, ecosystem: PackageConfig["ecosystem"], newVersion: string): void {
  if (ecosystem === "typescript") {
    writeTsVersion(filePath, newVersion);
  } else if (ecosystem === "dotnet") {
    writeDotnetVersion(filePath, newVersion);
  } else {
    writePyVersion(filePath, newVersion);
  }
}

function writeVersion(repoRoot: string, pkg: PackageConfig, newVersion: string, versionSource?: string): void {
  const filePath = getVersionFilePath(repoRoot, pkg, versionSource);
  writeVersionFile(filePath, pkg.ecosystem, newVersion);
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
  const repoRoot = path.resolve(__dirname, "../..");

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
  }> = [];

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
      writeVersionFile(versionSourcePath, versionSourceEcosystem, newVersion);
      const written = readVersionFile(versionSourcePath, versionSourceEcosystem);
      if (written !== newVersion) {
        console.error(`ERROR: Verification failed for ${scopeConfig.versionSource}: expected ${newVersion}, got ${written}`);
        process.exit(1);
      }
    }

    for (const pkg of scopeConfig.packages) {
      const filePath = versionSourceEcosystem === "dotnet"
        ? versionSourcePath
        : getVersionFilePath(repoRoot, pkg, scopeConfig.versionSource);
      const relPath = path.relative(repoRoot, filePath);

      const versionToWrite = pkg.ecosystem === 'python' ? toPep440(newVersion) : newVersion;

      if (versionSourceEcosystem !== "dotnet" && !args.dryRun) {
        writeVersion(repoRoot, pkg, versionToWrite, scopeConfig.versionSource);
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
        writeVersion(repoRoot, pkg, newVersion, scopeConfig.versionSource);
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
      });
    }
  }

  // Output JSON summary to stdout (logs go to stderr)
  const output = {
    scope: args.scope,
    packages: results,
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
