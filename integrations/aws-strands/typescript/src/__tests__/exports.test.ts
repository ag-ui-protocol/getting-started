/** Every public helper must be reachable from its package entry point. */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pkg from "../index";
import * as serverPkg from "../server";

describe("public export surface", () => {
  it("main entry exposes the adapter, proxy helpers, content helpers, and context helper", () => {
    const expected = [
      "StrandsAgent",
      "AWSStrandsAgent",
      "buildSnapshotMessages",
      "buildStrandsSeed",
      "convertMessagesForStrandsSeed",
      "INTERRUPT_CANCELLED",
      "buildContextExtras",
      "convertAguiContentToStrands",
      "flattenContentToText",
      "createProxyTool",
      "syncProxyTools",
      "isProxyTool",
      "DEFAULT_URL_FETCH_POLICY",
      "UrlFetchPolicyError",
    ];
    for (const name of expected) {
      expect(pkg).toHaveProperty(name);
      expect((pkg as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("server subpath exposes the Express transport helpers", () => {
    const expected = [
      "createStrandsApp",
      "addStrandsExpressEndpoint",
      "addPing",
      "addCapabilities",
      "capabilitiesFor",
      "DEFAULT_CAPABILITIES",
    ];
    for (const name of expected) {
      expect(serverPkg).toHaveProperty(name);
      expect((serverPkg as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("main entry does NOT expose server-side helpers (bundler safety)", () => {
    // Keeping these off the main entry lets client bundlers (Next.js, Vite)
    // trace this package without pulling in Express / cors.
    const serverOnly = [
      "createStrandsApp",
      "addStrandsExpressEndpoint",
      "addPing",
      "addCapabilities",
    ];
    for (const name of serverOnly) {
      expect(pkg).not.toHaveProperty(name);
    }
  });

  it("keeps the internal URL-fetch error off the public surface", () => {
    // The public class is the refusal a host can act on. Its counterpart,
    // UrlFetchUnavailableError, separates "could not reach a verdict" from
    // "refused" inside the fetch, and both are already turned into a logged
    // `null` before any caller sees either. The Python package exports no
    // equivalent, so exporting one here would be a surface the two adapters
    // do not share.
    expect(pkg).toHaveProperty("UrlFetchPolicyError");
    expect(pkg).not.toHaveProperty("UrlFetchUnavailableError");
  });

  it("exports the cancellation sentinel with the same shape as the Python package", () => {
    // A tool checks `.cancelled` on what it receives, so the value is part of
    // the contract, not just the name.
    expect(pkg.INTERRUPT_CANCELLED).toEqual({ cancelled: true });
  });

  it("exports the cancellation sentinel frozen", () => {
    // Frozen so a consumer cannot mutate the exported shape others match
    // against. Python keeps its own export a plain dict, because callers
    // serialize it, and builds each emitted answer fresh instead.
    expect(Object.isFrozen(pkg.INTERRUPT_CANCELLED)).toBe(true);
    expect(() => {
      (
        pkg.INTERRUPT_CANCELLED as unknown as Record<string, unknown>
      ).cancelled = false;
    }).toThrow();
    expect(pkg.INTERRUPT_CANCELLED).toEqual({ cancelled: true });
  });
});

/**
 * The documentation half of the same contract. A claim about what a package
 * exports, or about which peers a reader has to install, drifts the moment
 * nothing reads it: `UrlFetchPolicy` and `DEFAULT_URL_FETCH_POLICY` were
 * documented as exports of this package while neither entry re-exported them.
 *
 * Every expectation below is derived: from the README by parsing it, and
 * from the real manifests and the namespace objects imported above. Nothing
 * here restates a package list or a count as a literal, because a literal
 * drifts in exactly the same way the prose does.
 *
 * Each assertion is also scoped to a structured region: a fenced block, a
 * single import statement, an anchored comment line. A looser rule ("every
 * backticked token must exist") is cheapest to satisfy by un-backticking the
 * token, which makes the README vaguer while CI goes green; deleting a
 * fence or an anchored line is visible in review.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const README_PATH = join(PACKAGE_ROOT, "README.md");

/** The one document that carries `ts` fences naming this package's entries. */
const SCANNED_DOCS = [{ label: "typescript/README.md", path: README_PATH }];

const ENTRY_NAMESPACES: Record<string, object> = {
  "@ag-ui/aws-strands": pkg,
  "@ag-ui/aws-strands/server": serverPkg,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

type Fence = { lang: string; body: string; startLine: number };

function fencedBlocks(source: string): Fence[] {
  const blocks: Fence[] = [];
  let open: { lang: string; startLine: number; lines: string[] } | null = null;
  source.split("\n").forEach((line, index) => {
    const marker = /^```(\S*)\s*$/.exec(line);
    if (marker) {
      if (open) {
        blocks.push({
          lang: open.lang,
          body: open.lines.join("\n"),
          startLine: open.startLine,
        });
        open = null;
      } else {
        open = { lang: marker[1], startLine: index + 1, lines: [] };
      }
      return;
    }
    open?.lines.push(line);
  });
  return blocks;
}

type DocImport = {
  module: string;
  names: string[];
  doc: string;
  statement: string;
};

/**
 * Anchoring at a line start and stopping at the FIRST `from "..."` is what keeps
 * each match to one statement: a lazy scan for the target module alone would
 * swallow a preceding `import express from "express";` and read its specifiers
 * as ours.
 */
function documentedEntryImports(doc: {
  label: string;
  path: string;
}): DocImport[] {
  const found: DocImport[] = [];
  for (const fence of fencedBlocks(readFileSync(doc.path, "utf8"))) {
    if (fence.lang !== "ts") continue;
    const statements = fence.body.matchAll(
      /^import\b([\s\S]*?)\bfrom\s+["']([^"']+)["']/gm,
    );
    for (const [statement, clause, module] of statements) {
      if (!(module in ENTRY_NAMESPACES)) continue;
      // A whole `import type { ... } from` statement contributes no runtime keys.
      if (/^\s*type\b/.test(clause)) {
        found.push({ module, names: [], doc: doc.label, statement });
        continue;
      }
      const braced = /\{([\s\S]*)\}/.exec(clause);
      const names = (braced?.[1] ?? "")
        .split(",")
        .map((specifier) => specifier.trim())
        .filter((specifier) => specifier.length > 0)
        // `type X` inside a value import is a type too, and `A as B` is only a
        // local rename, so the original name is what has to be a namespace key.
        .filter((specifier) => !/^type\b/.test(specifier))
        .map((specifier) => specifier.split(/\s+as\s+/)[0].trim());
      found.push({ module, names, doc: doc.label, statement });
    }
  }
  return found;
}

function nonOptionalPeers(manifest: {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}): string[] {
  const meta = manifest.peerDependenciesMeta ?? {};
  return Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) => meta[name]?.optional !== true,
  );
}

/**
 * `require("@strands-agents/sdk/package.json")` throws, because the subpath is
 * not in the SDK's `exports` map, so the installed manifest is read off disk.
 * A miss
 * fails loudly rather than skipping: half a lever asserts nothing.
 */
function installedSdkManifestPath(): string {
  for (let dir = HERE; ; dir = dirname(dir)) {
    const candidate = join(
      dir,
      "node_modules",
      "@strands-agents",
      "sdk",
      "package.json",
    );
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  throw new Error(
    "could not find an installed node_modules/@strands-agents/sdk/package.json above " +
      HERE +
      "; run pnpm install, since the install-fence assertions derive the SDK's own peers from it",
  );
}

function installFence(readme: string): Fence {
  const heading = /^## Install$/m.exec(readme);
  expect(
    heading,
    "README.md no longer has an `## Install` heading; the install-fence assertions anchor on it",
  ).not.toBeNull();
  const fence = fencedBlocks(readme.slice(heading!.index)).find(
    (f) => f.lang === "bash",
  );
  expect(
    fence,
    "no ```bash fence follows README.md's `## Install` heading; the install manifest is derived from it",
  ).toBeDefined();
  expect(
    fence!.body,
    "the first bash fence under `## Install` no longer installs this package; the anchor has moved",
  ).toContain("pnpm add @ag-ui/aws-strands");
  return fence!;
}

/** Package names on `pnpm add` lines, with flags dropped and `\` continuations joined. */
function pnpmAddPackages(fenceBody: string): string[] {
  const commands: string[] = [];
  let pending = "";
  for (const raw of fenceBody.split("\n")) {
    const line = raw.trimEnd();
    const joined = pending + line.replace(/\\$/, " ");
    if (/\\$/.test(line)) {
      pending = joined;
      continue;
    }
    pending = "";
    commands.push(joined);
  }
  if (pending) commands.push(pending);

  return commands.flatMap((command) => {
    const trimmed = command.trim();
    if (!/^pnpm add\b/.test(trimmed)) return [];
    return trimmed
      .replace(/^pnpm add\b/, "")
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0 && !token.startsWith("-"));
  });
}

describe("documented export and install surface", () => {
  it("resolves every named import in the README's ts fences against the real entry namespaces", () => {
    const imports = SCANNED_DOCS.flatMap(documentedEntryImports);
    // A regex that silently matches nothing is a test that asserts nothing.
    expect(
      imports.length,
      "found no `@ag-ui/aws-strands` import statements in any ```ts fence; the extraction, not the documentation, is what broke",
    ).toBeGreaterThan(0);

    for (const entry of imports) {
      const namespace = ENTRY_NAMESPACES[entry.module] as Record<
        string,
        unknown
      >;
      for (const name of entry.names) {
        expect(
          Object.keys(namespace),
          `${entry.doc} documents \`${name}\` as a value import from "${entry.module}", but that entry does not export it: ${entry.statement.replace(/\s+/g, " ")}`,
        ).toContain(name);
      }
    }
  });

  it("lists every non-optional peer of this package on a pnpm add line", () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    );
    const fence = installFence(readFileSync(README_PATH, "utf8"));
    const installed = pnpmAddPackages(fence.body);

    for (const peer of nonOptionalPeers(manifest)) {
      expect(
        installed,
        `\`${peer}\` is a non-optional peer of this package but no \`pnpm add\` line in README.md's install fence installs it`,
      ).toContain(peer);
    }
  });

  it("names every non-optional peer of the installed Strands SDK somewhere in the install fence", () => {
    const sdkManifest = JSON.parse(
      readFileSync(installedSdkManifestPath(), "utf8"),
    );
    const fence = installFence(readFileSync(README_PATH, "utf8"));

    // "Somewhere in the fence", comments included, is the right bar for this
    // half: the reader's package manager asks for these on the SDK's behalf, so
    // the documentation owes them a mention, not an install line of their own.
    for (const peer of nonOptionalPeers(sdkManifest)) {
      const mentioned = new RegExp(
        `(^|[^\\w@/.-])${peer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w/.-]|$)`,
        "m",
      ).test(fence.body);
      expect(
        mentioned,
        `\`${peer}\` is a non-optional peer of the installed @strands-agents/sdk but README.md's install fence never mentions it, so a reader will be surprised by the request for it`,
      ).toBe(true);
    }
  });

  it("keeps the install fence's @ag-ui peer count equal to the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    );
    const fence = installFence(readFileSync(README_PATH, "utf8"));
    const claim = /^#\s*All (\w+) @ag-ui peers are non-optional\b/m.exec(
      fence.body,
    );
    expect(
      claim,
      "the install fence no longer carries an `# All <n> @ag-ui peers are non-optional` comment; a reworded anchor must fail here rather than quietly stop counting",
    ).not.toBeNull();

    const word = claim![1].toLowerCase();
    expect(
      NUMBER_WORDS,
      `the install fence counts @ag-ui peers as "${word}", which is not a number word this test can read`,
    ).toHaveProperty(word);
    expect(
      NUMBER_WORDS[word],
      "the install fence's @ag-ui peer count disagrees with package.json",
    ).toBe(
      nonOptionalPeers(manifest).filter((n) => n.startsWith("@ag-ui/")).length,
    );
  });

  it("keeps the install fence's Strands SDK peer count equal to the SDK's manifest", () => {
    const sdkManifest = JSON.parse(
      readFileSync(installedSdkManifestPath(), "utf8"),
    );
    const fence = installFence(readFileSync(README_PATH, "utf8"));
    const claim =
      /^#\s*@strands-agents\/sdk carries (\w+) non-optional peers of its own\b/m.exec(
        fence.body,
      );
    expect(
      claim,
      "the install fence no longer carries an `# @strands-agents/sdk carries <n> non-optional peers of its own` comment; a reworded anchor must fail here rather than quietly stop counting",
    ).not.toBeNull();

    const word = claim![1].toLowerCase();
    expect(
      NUMBER_WORDS,
      `the install fence counts the SDK's peers as "${word}", which is not a number word this test can read`,
    ).toHaveProperty(word);
    expect(
      NUMBER_WORDS[word],
      "the install fence's count of @strands-agents/sdk's own non-optional peers disagrees with the installed SDK manifest",
    ).toBe(nonOptionalPeers(sdkManifest).length);
  });
});
