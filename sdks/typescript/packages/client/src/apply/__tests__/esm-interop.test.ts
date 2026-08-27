import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pkgDir = path.resolve(__dirname, "../../..");
const distEsm = path.join(pkgDir, "dist", "index.mjs");
// Node's ESM loader only accepts file:/// URLs for absolute specifiers. A raw
// Windows path ("C:\...") is read as a "c:" protocol and rejected with
// ERR_UNSUPPORTED_ESM_URL_SCHEME, so the specifier has to be a URL, not a path.
const distEsmUrl = pathToFileURL(distEsm).href;

describe("ESM consumers under Node's native loader (regression #1577)", () => {
  beforeAll(() => {
    if (!existsSync(distEsm)) {
      const build = spawnSync("pnpm", ["build"], { cwd: pkgDir, stdio: "inherit" });
      if (build.status !== 0) {
        throw new Error("client build failed; cannot run ESM interop test");
      }
    }
  }, 120_000);

  // Vitest's Vite-based resolver adds CJS interop automatically, so unit tests
  // that import "fast-json-patch" through the source tree never surfaced the bug.
  // This test escapes vitest and runs the built ESM bundle under `node --input-type=module`
  // (the same loader used by tsx, Node with `"type":"module"`, Vite SSR, etc.).
  it("applies STATE_DELTA through the built ESM bundle without 'applyPatch is not a function'", () => {
    const script = `
      import { defaultApplyEvents } from ${JSON.stringify(distEsmUrl)};
      import { EventType } from "@ag-ui/core";
      import { of, firstValueFrom } from "rxjs";

      const initial = {
        messages: [],
        state: { count: 0 },
        threadId: "t",
        runId: "r",
        tools: [],
        context: [],
      };
      const delta = {
        type: EventType.STATE_DELTA,
        delta: [{ op: "replace", path: "/count", value: 1 }],
      };
      const agent = { messages: [], state: {} };

      const result = await firstValueFrom(
        defaultApplyEvents(initial, of(delta), agent, []),
      );
      process.stdout.write(JSON.stringify(result.state));
    `;

    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      cwd: pkgDir,
      encoding: "utf8",
    });

    const combined = `stdout: ${result.stdout}\nstderr: ${result.stderr}`;
    expect(result.stderr, combined).not.toContain("applyPatch is not a function");
    expect(result.status, combined).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ count: 1 });
  }, 60_000);
});
