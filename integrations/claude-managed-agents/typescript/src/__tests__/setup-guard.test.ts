/**
 * The provisioning script must do nothing when it is merely imported.
 *
 * This lives in its own file on purpose. `example-server.test.ts` statically
 * imports `examples/server`, which statically imports `examples/setup`, so by
 * the time any test body there runs the module has already been evaluated — a
 * dynamic import would hit the module cache and observe nothing at all. Vitest
 * isolates the module registry per file, so the import below is the first one.
 */

import http from "node:http";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("importing the setup module provisions nothing", async () => {
  // Regression: setup.ts called main() at module scope, so importing IDS_PATH
  // from the server created a real environment and one agent per Dojo feature —
  // billable resources — and killed the process with exit(1) on the first API
  // failure. Pointing the SDK at a server we own turns "provisioned something"
  // into a directly observable fact rather than a guess about timing.
  const requests: string[] = [];
  const api = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const { port } = api.address() as AddressInfo;

  const saved = { ...process.env };
  process.env.ANTHROPIC_API_KEY = "sk-ant-unused";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    const setup = await import("../../examples/setup");
    expect(typeof setup.IDS_PATH).toBe("string");
    // Long enough for a stray main() to get its first request out.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toEqual([]);
  } finally {
    process.env = saved;
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

it("treats a symlinked entry path as the entry point", async () => {
  // path.resolve preserves symlinks while Node's ESM loader canonicalises
  // import.meta.url, so comparing the two made the guard false for any checkout
  // reached through a link — the script then exited 0 having printed nothing.
  const { isEntry } = await import("../../examples/entry");
  const real = fileURLToPath(new URL("../../examples/entry.ts", import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), "agui-entry-"));
  const link = path.join(dir, "entry.ts");
  await symlink(real, link);

  const saved = process.argv[1];
  try {
    process.argv[1] = link;
    expect(isEntry(new URL("../../examples/entry.ts", import.meta.url).href)).toBe(true);
    process.argv[1] = path.join(dir, "not-the-entry.ts");
    expect(isEntry(new URL("../../examples/entry.ts", import.meta.url).href)).toBe(false);
  } finally {
    process.argv[1] = saved as string;
    await rm(dir, { recursive: true, force: true });
  }
});
