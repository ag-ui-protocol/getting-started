import { describe, expect, it } from "vitest";
import { build } from "esbuild";

/**
 * The main entry of this package must pull no zod at runtime.
 *
 * That is the whole reason zod is an OPTIONAL peer dependency: an application
 * that only wants the protocol TYPES (erased at compile time) and the
 * zod-free helpers must be able to install `@ag-ui/core` without installing
 * zod at all. One `export * from "./generated/schemas"` anywhere reachable
 * from src/index.ts silently breaks that, and nothing else in the suite would
 * notice — the tests all run in a workspace where zod resolves fine.
 *
 * This is checked structurally rather than by grepping the source: the module
 * graph is what decides, and a re-export three files deep is exactly the case
 * a grep of index.ts would miss. Bundling with zod marked external means an
 * import that survives to the output is a REAL runtime edge, and one that got
 * tree-shaken away was never one.
 */

// Resolved off this file rather than off process.cwd(), so the test does not
// depend on where the runner was started. `node:path`/`node:url` are avoided
// on purpose: this package's tsconfig carries no @types/node.
const srcFile = (name: string) =>
  decodeURIComponent(new URL(`../${name}`, import.meta.url).pathname);

/** Bundles one entry, zod external, and returns the emitted ESM. */
async function bundleWithZodExternal(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [srcFile(entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    // Marked external so a surviving reference shows up as a bare `zod`
    // import in the output instead of being inlined and made unfindable.
    external: ["zod", "zod/*"],
    logLevel: "silent",
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

/** Every way a bundled module can name zod at runtime. */
function referencesZod(bundle: string): boolean {
  return /(?:from\s*|require\(\s*|import\(\s*)["'`]zod(?:\/[^"'`]*)?["'`]/.test(bundle);
}

describe("the main entry is zod-free", () => {
  it("src/index.ts bundles without a single zod import", async () => {
    const bundle = await bundleWithZodExternal("index.ts");
    expect(referencesZod(bundle)).toBe(false);
    // Belt and braces: not even a stray mention of the specifier.
    expect(bundle).not.toMatch(/["'`]zod(?:\/v[34])?["'`]/);
  });

  it("src/schemas.ts DOES import zod, so the check above cannot pass vacuously", async () => {
    const bundle = await bundleWithZodExternal("schemas.ts");
    expect(referencesZod(bundle)).toBe(true);
  });

  it("the detector recognises a zod import when there is one", async () => {
    // The negative assertion is only worth anything if the matcher can fail.
    expect(referencesZod('import { z } from "zod/v4";')).toBe(true);
    expect(referencesZod('const { z } = require("zod");')).toBe(true);
    expect(referencesZod('const m = await import("zod/v4");')).toBe(true);
    expect(referencesZod('const notZod = "zodiac";')).toBe(false);
  });

  it("the capability TYPES still reach consumers from the main entry", async () => {
    // Types are erased, so this is a compile-time assertion: it fails the
    // `tsc --noEmit` gate, not this run. It lives here because moving the
    // validators off the main entry is exactly what could take the types
    // with them.
    const entry = await import("../index");
    type _Capabilities = import("../index").AgentCapabilities;
    type _Subagent = import("../index").SubagentInfo;
    const subagent: _Subagent = { name: "researcher" };
    const caps: _Capabilities = { multiAgent: { subagents: [subagent] } };
    expect(caps.multiAgent?.subagents?.[0].name).toBe("researcher");
    // And the zero runtime value the entry is allowed to carry is still there.
    expect(typeof entry.PROTOCOL_VERSION).toBe("string");
    expect(entry).not.toHaveProperty("AgentCapabilitiesSchema");
    expect(entry).not.toHaveProperty("EventSchemas");
    expect(entry).not.toHaveProperty("OptionalMetadataSchema");
  });
});
