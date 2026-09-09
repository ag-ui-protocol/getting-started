import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { stripUnknown } from "../strip";

/**
 * Two zod copies in one process is the normal case, not the exotic one: an
 * application installs its own zod, `@ag-ui/core` declares zod as an optional
 * peer, and any hoisting accident or version skew lands a second copy in
 * node_modules. `stripUnknown` narrows entirely by `instanceof z.ZodObject` /
 * `z.ZodArray` / `z.ZodUnion`, so if `instanceof` were copy-local it would
 * silently strip nothing at all against a foreign schema — a no-op with no
 * error, which is the worst failure mode this layer can have.
 *
 * It is not copy-local: zod v4 builds every class through `$constructor`,
 * which installs a `Symbol.hasInstance` that tests a trait set carried on the
 * instance instead of walking the prototype chain. This test pins that, using
 * two real copies from the workspace store rather than a mock, because the
 * property being relied on belongs to zod and only zod can break it.
 *
 * It also pins the corollary that motivated hiding `stripUnknown` from the
 * public API: `stripUnknown(value, schema)` NAMES a zod type in its signature,
 * so exporting it makes zod part of this package's contract even though the
 * runtime behaviour survives a second copy just fine.
 */

/** The pnpm store directory, found via this package's own zod link. */
function pnpmStoreDir(): string | undefined {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let up = 0; up < 12; up++) {
    const link = path.join(dir, "node_modules", "zod");
    if (fs.existsSync(link)) {
      // .../.pnpm/zod@<version>/node_modules/zod -> up three is .pnpm
      const store = path.resolve(fs.realpathSync(link), "../../..");
      if (path.basename(store) === ".pnpm") return store;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Every distinct zod v4 entry point installed in the store. */
function zodV4Copies(): string[] {
  const store = pnpmStoreDir();
  if (store === undefined) return [];
  return fs
    .readdirSync(store)
    .filter((entry) => /^zod@\d/.test(entry))
    .map((entry) => path.join(store, entry, "node_modules", "zod", "v4", "index.js"))
    .filter((entry) => fs.existsSync(entry));
}

type ZodModule = { z: typeof z };

const copies = zodV4Copies();

describe("stripUnknown across two zod copies", () => {
  it("the workspace really does have two zod copies to test with", () => {
    // If this ever drops to one the tests below would pass vacuously, so the
    // precondition is asserted rather than silently skipped.
    expect(copies.length).toBeGreaterThanOrEqual(2);
  });

  it("a schema built by one copy is an instanceof the other copy's classes", async () => {
    const [first, second] = copies;
    const a = (await import(first)) as ZodModule;
    const b = (await import(second)) as ZodModule;

    // Genuinely two module instances, not one resolved twice.
    expect(a.z.ZodObject).not.toBe(b.z.ZodObject);

    const foreign = a.z.looseObject({ id: a.z.string() });
    expect(foreign instanceof b.z.ZodObject).toBe(true);
    expect(a.z.array(a.z.string()) instanceof b.z.ZodArray).toBe(true);
    expect(
      a.z.union([a.z.string(), a.z.array(a.z.string())]) instanceof b.z.ZodUnion,
    ).toBe(true);
  });

  it("strips against a schema this package did not build", async () => {
    // strip.ts imported `zod/v4` from this package, so the `z` in scope here
    // IS that copy. Any copy whose classes are not identical to it is foreign.
    let strippedSomething = false;
    for (const entry of copies) {
      const mod = (await import(entry)) as ZodModule;
      if (mod.z.ZodObject === z.ZodObject) continue; // this package's own copy
      const schema = mod.z.looseObject({
        id: mod.z.string(),
        parts: mod.z.array(mod.z.looseObject({ kind: mod.z.string() })),
      });
      const { value, stripped } = stripUnknown(
        {
          id: "m1",
          surprise: "from the future",
          parts: [{ kind: "text", alsoSurprise: 1 }],
        },
        schema as unknown as z.ZodType,
      );
      expect(stripped).toEqual(["/surprise", "/parts/0/alsoSurprise"]);
      expect(value).toEqual({ id: "m1", parts: [{ kind: "text" }] });
      strippedSomething = true;
    }
    // A foreign copy had to exist for the assertions above to have run.
    expect(strippedSomething).toBe(true);
  });
});
