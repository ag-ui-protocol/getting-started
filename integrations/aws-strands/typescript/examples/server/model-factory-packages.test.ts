/**
 * Guards how this examples package gets what it imports: every provider branch
 * the factory implements constructs, every provider client the SDK needs for
 * those branches is declared here and installed at a version the SDK accepts
 * rather than borrowed from whatever an unrelated workspace package hoisted,
 * every external module anything under `server/` names is declared in the
 * manifest field that has to hold it, and every binary and file the package
 * scripts name is there to be run.
 *
 * Deliberately unmocked, unlike `model-factory.test.ts`. The openai, anthropic
 * and gemini branches lazily import a `@strands-agents/sdk/models/*` module
 * whose provider client is an optional peer of the SDK, so nothing installs
 * that client on our behalf, and mocking the module out is what hides a client
 * that fails to resolve.
 *
 * Construction is the weak half of this file and cannot be strengthened from
 * here. pnpm hoists installed packages into `node_modules/.pnpm/node_modules`,
 * and resolution falls through to that copy, so a client missing from both this
 * package's link tree and the SDK's own resolves anyway: with both `openai`
 * links moved aside, the SDK resolves openai 4.104.0 from the hoisted copy, far
 * outside the `^6.7.0` it peers on, and all four construct cases below still
 * pass. The declaration and installed-version cases are what catch a borrowed
 * or wrong-versioned client; construction only catches a branch whose module
 * cannot load at all.
 *
 * Construction is offline: no provider client issues a request until the agent
 * streams, so a placeholder key is enough.
 *
 * The declaration cases read this examples package's own manifest and scan
 * `server/`, the directory every example lives under. The adapter package next
 * door deliberately does not mirror the SDK's peer ranges as its own, because
 * whoever installs the SDK gets the SDK's demands directly, so nothing in this
 * file says anything about what the adapter should declare.
 */

import fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModel } from "./model-factory";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SERVER_DIR = "server";

const SERVER_ROOT = path.join(PACKAGE_ROOT, SERVER_DIR);

const SDK = "@strands-agents/sdk";

/**
 * Anti-vacuity floor, not the list of clients that must be declared: which
 * clients those are is derived from the factory's own provider branches and the
 * SDK's own optional peers. A derivation that quietly produced nothing would
 * pass every case it feeds, so the cases assert this floor first.
 */
const PROVIDER_CLIENT_FLOOR = ["@anthropic-ai/sdk", "@google/genai", "openai"];

/** The same kind of floor for the branches read out of the factory's source. */
const PROVIDER_BRANCH_FLOOR = ["bedrock", "openai"];

/** The same kind of floor for the peers walked out of installed manifests. */
const REQUIRED_PEER_FLOOR = [
  "@modelcontextprotocol/sdk",
  "@opentelemetry/api",
  "zod",
];

/**
 * Each branch paired with the class it must hand back, loaded from the module
 * the factory loads it from. Identity, not `constructor.name`, which is a build
 * artifact: this is the one file that runs against the real dist. Kept in step
 * with the factory by the coverage case below, which derives the branch list
 * from the factory's source rather than trusting this array to be complete.
 */
const PROVIDERS = [
  {
    provider: "openai",
    modelClass: () =>
      import("@strands-agents/sdk/models/openai").then((m) => m.OpenAIModel),
  },
  {
    provider: "anthropic",
    modelClass: () =>
      import("@strands-agents/sdk/models/anthropic").then(
        (m) => m.AnthropicModel,
      ),
  },
  {
    provider: "gemini",
    modelClass: () =>
      import("@strands-agents/sdk/models/google").then((m) => m.GoogleModel),
  },
  {
    provider: "bedrock",
    modelClass: () => import("@strands-agents/sdk").then((m) => m.BedrockModel),
  },
];

interface Manifest {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

type Resolver = ReturnType<typeof createRequire>;

const examplesRequire = createRequire(path.join(PACKAGE_ROOT, "package.json"));

function readJson<T>(...segments: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(...segments), "utf8")) as T;
}

/**
 * The SDK does not export `./package.json`, so the only way to its manifest is
 * to walk up from the entry file Node actually resolved. That entry sits
 * several directories below the package root for a build-directory layout, and
 * none of those directories carry a manifest. The name check is defensive: it
 * keeps the walk from ever claiming a parent package's manifest as ours.
 */
function packageRootOf(entry: string, name: string): string {
  let dir = path.dirname(entry);

  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest) && readJson<Manifest>(manifest).name === name) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `No package.json naming ${name} above the resolved entry ${entry}`,
      );
    }
    dir = parent;
  }
}

/** Real path of the package directory `resolver` loads `name` from. */
function resolvedPackageDir(resolver: Resolver, name: string): string {
  return fs.realpathSync(packageRootOf(resolver.resolve(name), name));
}

/**
 * Real path of the copy of `name` a module in `fromDir` gets: the nearest
 * `node_modules/<name>` walking up from there, which is the search Node runs
 * for a bare specifier. Not `resolver.resolve`, which additionally needs the
 * package to export its own root, and `@modelcontextprotocol/sdk` does not
 * (verified: MODULE_NOT_FOUND). For every SDK peer this package declares that
 * `resolve` can name, the two agree on the directory.
 */
function installedPackageDir(fromDir: string, name: string): string {
  let dir = fromDir;

  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return fs.realpathSync(candidate);
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`No installed copy of ${name} reachable from ${fromDir}`);
    }
    dir = parent;
  }
}

function examplesManifest(): Manifest {
  return readJson<Manifest>(PACKAGE_ROOT, "package.json");
}

function declaredDependencies(): Record<string, string> {
  const { dependencies } = examplesManifest();
  if (!dependencies) {
    throw new Error("examples package.json declares no dependencies");
  }

  return dependencies;
}

function declaredDevDependencies(): Record<string, string> {
  const { devDependencies } = examplesManifest();
  if (!devDependencies) {
    throw new Error("examples package.json declares no devDependencies");
  }

  return devDependencies;
}

/**
 * Both fields merged, for the cases about ranges rather than about fields. A
 * package declared in both would lose its `dependencies` range to this merge,
 * which is why a separate case forbids declaring one twice.
 */
function declaredEverywhere(): Record<string, string> {
  return { ...declaredDependencies(), ...declaredDevDependencies() };
}

function sdkPackageDir(): string {
  return resolvedPackageDir(examplesRequire, SDK);
}

function sdkManifest(): Manifest {
  return readJson<Manifest>(sdkPackageDir(), "package.json");
}

function sdkPeerDependencies(): Record<string, string> {
  return sdkManifest().peerDependencies ?? {};
}

/** SDK peers nothing installs on our behalf, so the importer must declare them. */
function optionalSdkPeers(): Set<string> {
  const { peerDependenciesMeta } = sdkManifest();

  return new Set(
    Object.entries(peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional)
      .map(([name]) => name),
  );
}

/**
 * TypeScript's source extensions, not just `.ts`: an example added as `.mts`,
 * `.cts` or `.tsx` has to be scanned like any other.
 */
const TYPESCRIPT_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx"];

/**
 * The suffix the configured runner selects. Everything else under `server/` is
 * a file a running demo can load, so the two sets are complements and the
 * naming case below keeps a test-looking file from falling into the wrong one.
 */
const TEST_SUFFIX = ".test.ts";

/** Every spelling that reads as a test to a person, whatever the runner takes. */
const TEST_LOOKING = /\.(test|spec)\.[cm]?tsx?$/;

function typeScriptFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : typeScriptFiles(full);
    }

    if (!entry.isFile()) {
      return [];
    }

    return TYPESCRIPT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
      ? [full]
      : [];
  });
}

function isTestFile(file: string): boolean {
  return path.basename(file).endsWith(TEST_SUFFIX);
}

/** Files a running demo loads: everything under `server/` bar the tests. */
function runtimeFiles(): string[] {
  return typeScriptFiles(SERVER_ROOT).filter((file) => !isTestFile(file));
}

function testFiles(): string[] {
  return typeScriptFiles(SERVER_ROOT).filter(isTestFile);
}

/**
 * The include patterns the runner is configured with, read out of the config
 * instead of assumed, so the split above cannot drift from what vitest selects
 * without a case failing. This package owns its runner, so this is its own
 * config and not the adapter's next door, whose include no longer reaches here.
 */
function runnerIncludePatterns(): string[] {
  const file = path.join(PACKAGE_ROOT, "vitest.config.ts");
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const patterns: string[] = [];
  let found = false;

  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
      node.name.text === "include" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      found = true;
      for (const element of node.initializer.elements) {
        if (!ts.isStringLiteralLike(element)) {
          throw new Error(`non-literal entry in the include array of ${file}`);
        }
        patterns.push(element.text);
      }
      return;
    }

    ts.forEachChild(node, visit);
  };
  visit(source);

  if (!found) {
    throw new Error(`no include array to read out of ${file}`);
  }

  return patterns;
}

/** `@scope/pkg/sub` and `pkg/sub` both name the package that must be declared. */
function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");

  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

/**
 * A relative path and a `#name` subpath import both resolve inside the
 * importing package, the latter through its own `imports` map, so neither names
 * a package that could be declared.
 */
function isInternalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("#");
}

type SpecifierSink = (specifier: string, erased: boolean) => void;

/**
 * Whether an import clause leaves nothing behind to run: `import type ...`, or
 * a named import whose every binding carries its own `type`. A binding without
 * `type` counts as a value even when it happens to name a type, which is the
 * safe direction: it asks for a declaration the package would need anyway.
 */
function isErasedImportClause(clause: ts.ImportClause | undefined): boolean {
  // `import "x"` binds nothing and still runs the module for its side effects.
  if (!clause) {
    return false;
  }

  if (clause.isTypeOnly) {
    return true;
  }

  const bindings = clause.namedBindings;
  if (clause.name || !bindings || !ts.isNamedImports(bindings)) {
    return false;
  }

  return (
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

/** The same question for a re-export. `export * from` re-exports values. */
function isErasedExportClause(
  clause: ts.NamedExportBindings | undefined,
): boolean {
  if (!clause || !ts.isNamedExports(clause)) {
    return false;
  }

  return (
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

/**
 * Every module specifier one parsed file names, each flagged with whether the
 * compiler erases it. The flag is the point: a specifier the compiler erases
 * names a package typechecking needs and nothing loads at runtime, so the two
 * kinds cannot be demanded of the same manifest field.
 *
 * Literal specifiers only. A computed or templated `import()` argument names no
 * package here, so for the provider-client derivation below a client reached
 * only through one would go unguarded while the floor still passed.
 *
 * `declare module "x"` is not visited as a specifier at all: it augments a
 * package rather than importing one, and its body is walked like any other.
 */
function visitSpecifiers(source: ts.SourceFile, sink: SpecifierSink): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        sink(
          node.moduleSpecifier.text,
          isErasedImportClause(node.importClause),
        );
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        sink(
          node.moduleSpecifier.text,
          node.isTypeOnly || isErasedExportClause(node.exportClause),
        );
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        sink(node.moduleReference.expression.text, node.isTypeOnly);
      }
    } else if (ts.isImportTypeNode(node)) {
      // `import("x").Foo` and `typeof import("x")`, both in type position.
      if (
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        sink(node.argument.literal.text, true);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const runtimeLoad =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      const [first] = node.arguments;
      if (runtimeLoad && first && ts.isStringLiteralLike(first)) {
        sink(first.text, false);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

interface ImportScan {
  /** Packages something loads to run: value imports, `require`, `import()`. */
  values: Set<string>;
  /** Packages named only by specifiers the compiler erases. */
  types: Set<string>;
  /** Value specifiers as written, subpath included. */
  valueSpecifiers: Set<string>;
  /** Whether anything scanned names a Node builtin, erased or not. */
  builtins: boolean;
}

/** What the given files name from outside their own package, static or lazy. */
function scanImports(files: string[]): ImportScan {
  const values = new Set<string>();
  const types = new Set<string>();
  const valueSpecifiers = new Set<string>();
  let builtins = false;

  for (const file of files) {
    visitSpecifiers(parse(file), (specifier, erased) => {
      if (isBuiltin(specifier)) {
        builtins = true;
        return;
      }

      if (isInternalSpecifier(specifier)) {
        return;
      }

      if (erased) {
        types.add(packageNameOf(specifier));
        return;
      }

      valueSpecifiers.add(specifier);
      values.add(packageNameOf(specifier));
    });
  }

  return { values, types, valueSpecifiers, builtins };
}

/**
 * Packages named by anything reachable from `specifier` through relative
 * imports. The SDK's `models/openai` and `models/google` entries are barrels
 * that re-export the file naming the client, so a one-level scan finds nothing
 * and following the relative imports finds the client. The SDK's exports map
 * splits `types` from `default` and declares no `require`/`import` condition,
 * so the file `require` resolves here is the file the factory's dynamic import
 * loads. Emitted JavaScript carries nothing the compiler erased, so the
 * erasure flag is not consulted on this walk.
 */
function reachableExternals(specifier: string): Set<string> {
  const externals = new Set<string>();
  const seen = new Set<string>();
  const pending = [fs.realpathSync(examplesRequire.resolve(specifier))];

  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);

    const fileRequire = createRequire(file);
    visitSpecifiers(parse(file), (found) => {
      if (isBuiltin(found) || found.startsWith("#")) {
        return;
      }

      if (!found.startsWith(".")) {
        externals.add(packageNameOf(found));
        return;
      }

      // Left to throw on purpose. A relative import that will not resolve is
      // coverage lost, everything past it going unscanned, not noise to skip.
      pending.push(fs.realpathSync(fileRequire.resolve(found)));
    });
  }

  return externals;
}

/**
 * Provider clients the examples are responsible for declaring: the SDK's own
 * optional peers reachable from the SDK modules the runtime files load.
 * Derived rather than listed because the import scan cannot see these, a
 * provider branch importing `@strands-agents/sdk/models/x` and never naming the
 * client underneath, so a hand-written list would leave a branch added later
 * uncovered. The bedrock branch contributes nothing: it imports the SDK root,
 * whose client is a hard dependency of the SDK rather than a peer.
 */
function providerClients(): Set<string> {
  const optional = optionalSdkPeers();
  const clients = new Set<string>();

  for (const specifier of scanImports(runtimeFiles()).valueSpecifiers) {
    if (packageNameOf(specifier) !== SDK) {
      continue;
    }

    for (const external of reachableExternals(specifier)) {
      if (optional.has(external)) {
        clients.add(external);
      }
    }
  }

  return clients;
}

/**
 * Manifest of the copy of `name` linked into this package. A declared package
 * with nothing linked is worth naming, rather than letting a bare ENOENT
 * surface under a test title about something else.
 */
function installedManifest(name: string): Manifest {
  const file = path.join(PACKAGE_ROOT, "node_modules", name, "package.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      `${name} is declared by the examples package but nothing is linked at ${path.dirname(file)}; run pnpm install`,
    );
  }

  return readJson<Manifest>(file);
}

/**
 * Packages that an installed package peers on without marking the peer
 * optional. Declaring one of these without importing it is correct: the
 * examples import the package that demands it, and pnpm reports a missing peer
 * otherwise.
 *
 * One level deep, and only over the packages passed in, which the callers
 * narrow to what the examples both name and declare. A peer of a peer, and the
 * peers of a declared package nothing under `server/` names, are outside this
 * walk.
 */
function requiredPeersOf(packages: Iterable<string>): Set<string> {
  const required = new Set<string>();

  for (const name of packages) {
    const manifest = installedManifest(name);

    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!manifest.peerDependenciesMeta?.[peer]?.optional) {
        required.add(peer);
      }
    }
  }

  return required;
}

interface ScriptCommand {
  name: string;
  /** Whitespace-separated words of the command, as written. */
  tokens: string[];
}

function scriptCommands(): ScriptCommand[] {
  const { scripts } = examplesManifest();
  if (!scripts) {
    throw new Error("examples package.json declares no scripts");
  }

  return Object.entries(scripts).map(([name, command]) => ({
    name,
    tokens: command.trim().split(/\s+/),
  }));
}

/** The tool each script runs, which is the first word of the command. */
function scriptBinaries(): Set<string> {
  return new Set(scriptCommands().map(({ tokens }) => tokens[0]));
}

/**
 * Binary names the declared packages install into `node_modules/.bin`, read out
 * of each installed manifest's `bin` field. A package's binary need not share
 * its name: `tsc` comes from `typescript`. So a script's tool is satisfied by
 * whichever declared package actually provides it, not by a name match.
 */
function installedBinaries(): Map<string, string> {
  const provided = new Map<string, string>();

  for (const name of Object.keys(declaredEverywhere())) {
    let manifest: Manifest;
    try {
      manifest = readJson<Manifest>(
        installedPackageDir(PACKAGE_ROOT, name),
        "package.json",
      );
    } catch {
      // A declaration with nothing installed is a different case's subject.
      continue;
    }

    const { bin } = manifest;
    if (typeof bin === "string") {
      provided.set(name, name);
    } else if (bin) {
      for (const binary of Object.keys(bin)) {
        provided.set(binary, name);
      }
    }
  }

  return provided;
}

/** A script argument naming a file in this package, e.g. `server/server.ts`. */
const SCRIPT_SOURCE_ARGUMENT = /\.[cm]?[jt]sx?$/;

/**
 * The package names a `@types/*` entry could be typing. DefinitelyTyped mangles
 * a scoped package's slash to `__`, so `@types/foo__bar` types `@foo/bar`; a
 * name without `__` is taken as written. Both readings of a mangled name are
 * offered because the mangling cannot be reversed with certainty.
 */
function typedPackageCandidates(name: string): string[] | null {
  const prefix = "@types/";
  if (!name.startsWith(prefix)) {
    return null;
  }

  const typed = name.slice(prefix.length);

  return typed.includes("__")
    ? [`@${typed.replace("__", "/")}`, typed]
    : [typed];
}

/**
 * The provider names the factory branches on, read out of its source: every
 * string literal it compares the provider against. Derived rather than taken
 * from the message it throws, so that a branch added without updating that
 * message still has to be covered here. A factory that stopped comparing an
 * identifier named `provider` against literals would yield nothing, which the
 * floor the cases assert turns into a failure rather than silent coverage loss.
 */
function factoryProviderBranches(): string[] {
  const file = path.join(SERVER_ROOT, "model-factory.ts");
  const branches = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
    ) {
      for (const [left, right] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        if (
          ts.isIdentifier(left) &&
          left.text === "provider" &&
          ts.isStringLiteralLike(right)
        ) {
          branches.add(right.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(parse(file));

  return [...branches].sort();
}

/** The provider set the factory itself names when it rejects an unknown one. */
async function advertisedProviders(): Promise<string[]> {
  vi.stubEnv("MODEL_PROVIDER", "not-a-provider");

  const error: unknown = await createModel().then(
    () => {
      throw new Error("createModel resolved for an unknown provider");
    },
    (rejection: unknown) => rejection,
  );

  const message = error instanceof Error ? error.message : String(error);
  const advertised = /Supported: ([^.\n]+)/.exec(message);
  expect(
    advertised,
    `no supported-provider list to parse out of: ${message}`,
  ).not.toBeNull();

  return (advertised as RegExpExecArray)[1]
    .split(",")
    .map((provider) => provider.trim());
}

describe("examples model factory provider packages", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("GOOGLE_API_KEY", "test-key");
    vi.stubEnv("OPENAI_BASE_URL", "");
    // Every branch reads MODEL_ID, so leaving it unstubbed would hand the
    // construct cases whatever the developer happens to have exported.
    vi.stubEnv("MODEL_ID", "test-model");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(PROVIDERS)(
    "constructs the model class $provider names",
    async ({ provider, modelClass }) => {
      vi.stubEnv("MODEL_PROVIDER", provider);

      const created = await createModel();

      expect(created).toBeInstanceOf(await modelClass());
    },
  );

  it("rejects a provider it does not support", async () => {
    vi.stubEnv("MODEL_PROVIDER", "nope");

    await expect(createModel()).rejects.toThrow(/Unknown MODEL_PROVIDER: nope/);
  });

  it("constructs every provider branch the factory implements", () => {
    const branches = factoryProviderBranches();
    expect(branches).toEqual(expect.arrayContaining(PROVIDER_BRANCH_FLOOR));

    expect(
      PROVIDERS.map(({ provider }) => provider).sort(),
      "a provider branch of the factory with no construct case above",
    ).toEqual(branches);
  });

  it("advertises every provider branch it implements", async () => {
    const branches = factoryProviderBranches();
    expect(branches).toEqual(expect.arrayContaining(PROVIDER_BRANCH_FLOOR));

    expect(
      (await advertisedProviders()).sort(),
      "the provider list the factory names when it rejects one is not the set of branches it has",
    ).toEqual(branches);
  });

  it("declares every provider client the SDK needs, as a dependency", () => {
    const clients = [...providerClients()].sort();
    expect(clients).toEqual(expect.arrayContaining(PROVIDER_CLIENT_FLOOR));

    const runtime = Object.keys(declaredDependencies());
    for (const client of clients) {
      expect(
        runtime,
        `${client} is needed to run a demo, so it belongs in dependencies`,
      ).toContain(client);

      // A declared dependency is linked into this package's own node_modules; a
      // client that only resolves because an unrelated package hoisted it is not.
      expect(
        fs.existsSync(path.join(PACKAGE_ROOT, "node_modules", client)),
        `${client} is declared but nothing is linked for it`,
      ).toBe(true);
    }
  });

  it("declares every SDK-constrained dependency inside the SDK's own range", () => {
    const declared = declaredEverywhere();
    const peers = sdkPeerDependencies();
    const constrained = Object.keys(declared).filter((name) => name in peers);

    expect(constrained).toEqual(
      expect.arrayContaining([...PROVIDER_CLIENT_FLOOR, "zod"]),
    );

    for (const name of constrained) {
      const range = declared[name];

      // `semver.subset` throws rather than returning false on a specifier that
      // is not a range, `workspace:*` included. Nothing declares an SDK peer as
      // one today; the installed-version case covers the same set either way.
      if (!semver.validRange(range)) {
        expect(
          range.startsWith("workspace:"),
          `${name}: declared ${range}, neither a semver range nor a workspace link`,
        ).toBe(true);
        continue;
      }

      // Exact range equality would be wrong: a compatible tightening resolves to
      // the identical copy. The relation wanted is that our range cannot admit a
      // version the SDK rejects.
      expect(
        semver.subset(range, peers[name]),
        `${name}: declared ${range} admits versions outside the SDK's ${peers[name]}`,
      ).toBe(true);
    }
  });

  it("installs every SDK-constrained dependency at a version the SDK accepts", () => {
    const peers = sdkPeerDependencies();
    const constrained = Object.keys(declaredEverywhere()).filter(
      (name) => name in peers,
    );

    expect(constrained).toEqual(
      expect.arrayContaining([...PROVIDER_CLIENT_FLOOR, "zod"]),
    );

    // What a manifest declares and what got installed are separate questions.
    // The workspace root sets `pnpm.overrides` in defiance of declared ranges,
    // so an override can plant a version the SDK rejects underneath a declared
    // range that reads as correct. Resolution runs from the SDK's own directory
    // because the SDK is the package whose demands these are.
    const sdkDir = sdkPackageDir();
    for (const name of constrained) {
      const dir = installedPackageDir(sdkDir, name);
      const { version } = readJson<Manifest>(dir, "package.json");

      expect(version, `no version in the manifest at ${dir}`).toBeDefined();
      expect(
        semver.satisfies(version as string, peers[name]),
        `${name}: the SDK resolves ${version} from ${dir}, outside the ${peers[name]} it peers on`,
      ).toBe(true);
    }
  });

  it("resolves zod to the same copy the SDK loads", () => {
    // A split zod copy fails silently rather than loudly: the SDK's `tool()`
    // detects schemas with `value instanceof z.ZodType`, so a ZodObject built
    // from another copy is taken for a raw JSON schema and every example tool
    // quietly loses input validation. The provider clients need no equivalent
    // assertion because no client object crosses the boundary in either
    // direction: the examples never import a client, and the SDK builds its own
    // inside the model it hands back.
    const sdkRequire = createRequire(
      path.join(sdkPackageDir(), "package.json"),
    );

    expect(resolvedPackageDir(sdkRequire, "zod")).toBe(
      resolvedPackageDir(examplesRequire, "zod"),
    );
  });

  it("names every test file the way the runner selects tests", () => {
    expect(
      runnerIncludePatterns(),
      `the split in this file assumes the runner selects ${SERVER_DIR}/**/*${TEST_SUFFIX} and nothing else`,
    ).toEqual([`${SERVER_DIR}/**/*${TEST_SUFFIX}`]);

    const files = typeScriptFiles(SERVER_ROOT).map((file) =>
      path.relative(PACKAGE_ROOT, file),
    );
    expect(
      files.filter((file) => isTestFile(file)),
      "no test file scanned under server/",
    ).not.toEqual([]);

    const unrunnable = files
      .filter((file) => TEST_LOOKING.test(path.basename(file)))
      .filter((file) => !isTestFile(file))
      .sort();

    expect(
      unrunnable,
      `named like a test the runner does not select, so it never runs and is scanned as a file a demo loads; rename it to *${TEST_SUFFIX}`,
    ).toEqual([]);
  });

  it("declares every module the runtime files load as a dependency", () => {
    const loaded = scanImports(runtimeFiles()).values;
    expect(loaded, "nothing scanned under server/").toContain(SDK);

    const declared = new Set(Object.keys(declaredDependencies()));
    const undeclared = [...loaded].filter((name) => !declared.has(name)).sort();

    expect(
      undeclared,
      "loaded by a runtime file under server/, which needs it installed to run, but not in dependencies",
    ).toEqual([]);
  });

  it("declares every module named only for its types somewhere", () => {
    const runtime = scanImports(runtimeFiles());
    const tests = scanImports(testFiles());
    expect(
      runtime.types,
      "nothing under server/ named a package in a type-only position",
    ).toContain(SDK);

    const loaded = new Set([...runtime.values, ...tests.values]);
    const declared = new Set(Object.keys(declaredEverywhere()));
    const undeclared = [...new Set([...runtime.types, ...tests.types])]
      .filter((name) => !loaded.has(name) && !declared.has(name))
      .sort();

    // Erased before anything runs, so devDependencies is enough; typechecking
    // still needs the package installed, so declared nowhere is not.
    expect(
      undeclared,
      "named under server/ for its types only, but declared in neither dependencies nor devDependencies",
    ).toEqual([]);
  });

  it("declares every module only the tests name as a devDependency", () => {
    const tests = scanImports(testFiles());
    const named = new Set([...tests.values, ...tests.types]);
    expect(named, "no test files scanned under server/").toContain("vitest");

    const runtime = scanImports(runtimeFiles());
    const runtimeNamed = new Set([...runtime.values, ...runtime.types]);
    const declared = new Set(Object.keys(declaredDevDependencies()));
    const misplaced = [...named]
      .filter((name) => !runtimeNamed.has(name) && !declared.has(name))
      .sort();

    expect(
      misplaced,
      "named only by a test under server/, so running a demo does not need it, but not in devDependencies",
    ).toEqual([]);
  });

  it("declares no package in both dependency fields", () => {
    const runtime = new Set(Object.keys(declaredDependencies()));
    const both = Object.keys(declaredDevDependencies())
      .filter((name) => runtime.has(name))
      .sort();

    expect(
      both,
      "declared in both dependencies and devDependencies, where the range cases would only ever check the devDependencies one",
    ).toEqual([]);
  });

  it("keeps every types package out of dependencies", () => {
    const inDev = Object.keys(declaredDevDependencies()).filter(
      (name) => typedPackageCandidates(name) !== null,
    );
    expect(inDev, "no @types package declared at all").not.toEqual([]);

    const inRuntime = Object.keys(declaredDependencies())
      .filter((name) => typedPackageCandidates(name) !== null)
      .sort();

    expect(
      inRuntime,
      "a @types package is erased before a demo runs, so it belongs in devDependencies",
    ).toEqual([]);
  });

  it("declares the required peers of the packages it imports", () => {
    const declared = new Set(Object.keys(declaredEverywhere()));
    const scans = [scanImports(runtimeFiles()), scanImports(testFiles())];
    const named = new Set(
      scans.flatMap((scan) => [...scan.values, ...scan.types]),
    );

    const peers = requiredPeersOf(
      [...named].filter((name) => declared.has(name)),
    );
    expect([...peers].sort()).toEqual(
      expect.arrayContaining(REQUIRED_PEER_FLOOR),
    );

    const missing = [...peers].filter((name) => !declared.has(name)).sort();

    expect(
      missing,
      "a required peer of something the examples import, declared nowhere",
    ).toEqual([]);
  });

  it("declares the binary every package script runs", () => {
    const provided = installedBinaries();
    const binaries = [...scriptBinaries()]
      // `node` is the runtime itself; every other binary a script names comes
      // out of node_modules/.bin, which only a declared package fills.
      .filter((binary) => binary !== "node")
      .sort();
    expect(binaries, "no script runs a binary out of node_modules").not.toEqual(
      [],
    );
    expect(
      [...provided.keys()],
      "no declared package installs a binary, so the check below cannot bite",
    ).not.toEqual([]);

    const undeclared = binaries.filter((binary) => !provided.has(binary));

    expect(
      undeclared,
      "run by a package script, so a demo cannot start without it, but declared nowhere",
    ).toEqual([]);
  });

  it("points every package script at a file that is there", () => {
    const targets = new Map<string, string>();

    for (const { name, tokens } of scriptCommands()) {
      for (const token of tokens.slice(1)) {
        if (token.startsWith("-") || !SCRIPT_SOURCE_ARGUMENT.test(token)) {
          continue;
        }
        targets.set(token, name);
      }
    }

    expect(
      targets.size,
      "no script names a source file to run",
    ).toBeGreaterThan(0);

    const missing = [...targets]
      .filter(([target]) => !fs.existsSync(path.join(PACKAGE_ROOT, target)))
      .map(([target, script]) => `${script}: ${target}`)
      .sort();

    expect(missing, "named by a package script, and not there").toEqual([]);
  });

  it("imports or justifies every dependency it declares", () => {
    const runtime = scanImports(runtimeFiles());
    const tests = scanImports(testFiles());
    const named = new Set([
      ...runtime.values,
      ...runtime.types,
      ...tests.values,
      ...tests.types,
    ]);
    const declared = Object.keys(declaredEverywhere());
    expect(declared, "the manifest declares nothing to justify").not.toEqual(
      [],
    );

    const peers = requiredPeersOf(
      [...named].filter((name) => declared.includes(name)),
    );
    const clients = providerClients();
    const binaries = scriptBinaries();
    const anyBuiltin = runtime.builtins || tests.builtins;

    const justified = (name: string): boolean => {
      const typedCandidates = typedPackageCandidates(name);
      if (typedCandidates) {
        // `@types/node` types the builtins, which no manifest declares.
        return typedCandidates.some((typed) =>
          typed === "node" ? anyBuiltin : named.has(typed),
        );
      }

      return (
        named.has(name) ||
        peers.has(name) ||
        clients.has(name) ||
        // A tool a package script runs, `tsx` here, is imported by nothing and
        // still has to be installed.
        binaries.has(name)
      );
    };

    const unjustified = declared.filter((name) => !justified(name)).sort();

    expect(
      unjustified,
      "declared in dependencies or devDependencies, and neither named by anything under server/, nor a provider client, nor a required peer of something imported, nor run by a script",
    ).toEqual([]);
  });
});
