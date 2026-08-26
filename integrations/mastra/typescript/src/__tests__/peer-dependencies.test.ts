import pkg from "../../package.json";

/**
 * Regression guard for #2418.
 *
 * In the workspace, `@ag-ui/core` and `@ag-ui/client` resolve through
 * `workspace:*` devDependencies, so CI never exercises the floor declared in
 * `peerDependencies`. A consumer installing `@ag-ui/mastra` from npm resolves
 * that floor instead — if it is lower than the version that actually exports
 * the symbols `src/` imports, the package fails to load at require time.
 *
 * `tokenUsageFromAiSdkUsage` (imported by src/mastra.ts) first ships in
 * `@ag-ui/core@0.0.58`, so the declared floors must not admit anything older.
 */
const MIN_CORE = "0.0.58";
const MIN_CLIENT = "0.0.58";

/** Minimum version admitted by a `>=x.y.z` range. */
function floorOf(range: string): string {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  if (!match) {
    throw new Error(
      `Expected a ">=x.y.z" peer range so the floor can be checked, got "${range}"`,
    );
  }
  return match[1];
}

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

describe("peer dependency floors (#2418)", () => {
  it("declares an @ag-ui/core floor that exports every symbol src/ imports", () => {
    const range = pkg.peerDependencies["@ag-ui/core"];
    expect(compare(floorOf(range), MIN_CORE)).toBeGreaterThanOrEqual(0);
  });

  it("declares an @ag-ui/client floor that exports every symbol src/ imports", () => {
    const range = pkg.peerDependencies["@ag-ui/client"];
    expect(compare(floorOf(range), MIN_CLIENT)).toBeGreaterThanOrEqual(0);
  });

  it("does not declare a floor above the workspace version under test", () => {
    // The floors must stay reachable: a floor newer than what the workspace
    // builds and tests against would be untested by CI.
    const coreVersion = require("@ag-ui/core/package.json").version;
    const clientVersion = require("@ag-ui/client/package.json").version;
    expect(
      compare(floorOf(pkg.peerDependencies["@ag-ui/core"]), coreVersion),
    ).toBeLessThanOrEqual(0);
    expect(
      compare(floorOf(pkg.peerDependencies["@ag-ui/client"]), clientVersion),
    ).toBeLessThanOrEqual(0);
  });
});
