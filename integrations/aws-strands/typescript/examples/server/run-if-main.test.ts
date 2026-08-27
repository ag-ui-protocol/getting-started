/**
 * The launch guard and listen helper the demo files depend on.
 *
 * Every demo under `server/api/` is imported by `server.ts` for its factory AND
 * runnable on its own, so the guard is what keeps an import from opening a
 * stray port, and the helper is what keeps a failed bind from looking like a
 * clean start. Nothing tested either before.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { demoPort, runIfMain } from "./run-if-main";

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
/** Resolved rather than hardcoded, so a tsx layout change fails loudly here. */
const tsx = createRequire(import.meta.url).resolve("tsx/cli");

describe("demoPort", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("falls back when PORT is absent or blank", () => {
    const previous = process.env.PORT;
    try {
      delete process.env.PORT;
      expect(demoPort(8022)).toBe(8022);
      expect(demoPort()).toBe(8000);
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
    for (const blank of ["", "   ", "\t"]) {
      vi.stubEnv("PORT", blank);
      expect(demoPort(8022), JSON.stringify(blank)).toBe(8022);
    }
  });

  it("uses a valid PORT", () => {
    vi.stubEnv("PORT", "8100");
    expect(demoPort(8022)).toBe(8100);
  });

  it("throws rather than falling back on a value the operator got wrong", () => {
    // Falling back would start a working server on a port nobody asked for,
    // which is harder to notice than a failure to start.
    for (const bad of ["abc", "0", "-1", "65536", "80.5", "8000abc"]) {
      vi.stubEnv("PORT", bad);
      expect(() => demoPort(8022), bad).toThrow(/PORT must be an integer/);
    }
  });

  it("accepts the numeric spellings Number accepts", () => {
    // Recorded, not endorsed: `Number` reads these as 31 and 10000, so they
    // pass the integer-and-range check. Pinned so the quirk the doc comment
    // mentions cannot drift away from what the code does.
    vi.stubEnv("PORT", "0x1f");
    expect(demoPort(8022)).toBe(31);
    vi.stubEnv("PORT", "1e4");
    expect(demoPort(8022)).toBe(10000);
  });
});

describe("runIfMain", () => {
  it("does not run main when the module is not the process entry", async () => {
    const main = vi.fn(async () => {});
    // This test file is not the entry point; vitest is.
    runIfMain(import.meta.url, main);
    await Promise.resolve();
    expect(main).not.toHaveBeenCalled();
  });

  it("does not run main when there is no entry point at all", async () => {
    const argv = process.argv[1];
    const main = vi.fn(async () => {});
    try {
      // The shape a REPL or an embedding host has: no script path at all.
      delete process.argv[1];
      runIfMain(import.meta.url, main);
      await Promise.resolve();
      expect(main).not.toHaveBeenCalled();
    } finally {
      process.argv[1] = argv!;
    }
  });

  it("runs main, and exits non-zero when it rejects", async () => {
    // The positive path only exists when the file IS the entry, so it needs a
    // child process; the two checks above can only prove the negative.
    const outcome = await childRun("main-rejects-entry.ts", {});

    expect(outcome.code).toBe(1);
    expect(outcome.stdout).toContain("MAIN RAN");
    expect(outcome.stderr).toContain("main-rejects-entry.ts");
    expect(outcome.stderr).toContain("no API key for you");
  }, 60_000);
});

describe("listenOrExit", () => {
  it("exits non-zero when the port is already taken", async () => {
    const holder = createServer(() => {});
    await new Promise<void>((done) => holder.listen(0, "127.0.0.1", done));
    const { port } = holder.address() as AddressInfo;

    try {
      const outcome = await childRun("listen-or-exit-entry.ts", {
        PORT: String(port),
        HOST: "127.0.0.1",
      });

      // On the message, not just the exit code: a missing fixture or a type
      // error also exits 1, so a code-only check would pass without ever
      // reaching the bind.
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain("could not listen on 127.0.0.1");
      expect(outcome.stderr).toContain("EADDRINUSE");
      // Express runs the success callback on a failed bind too, so the absence
      // of this line is the other half of the fix.
      expect(outcome.stdout).not.toContain("listening on");
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
    }
  }, 60_000);

  it("actually serves on the port it announces", async () => {
    // A port the OS just handed back and released, rather than 0, which
    // demoPort rejects as out of range. The fixture requests its own port and
    // prints the status, so this proves it listened rather than proving that
    // the helper can echo its own argument.
    const port = await freePort();
    const outcome = await childRun("listen-or-exit-entry.ts", {
      PORT: String(port),
      HOST: "127.0.0.1",
      EXIT_ONCE_LISTENING: "1",
    });

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain(`listening on http://127.0.0.1:${port}`);
    expect(outcome.stdout).toContain("SELF REQUEST STATUS 200");
    expect(outcome.stderr).not.toContain("could not listen");
  }, 60_000);
});

/** A port the OS says is free right now, released before returning it. */
async function freePort(): Promise<number> {
  const probe = createServer(() => {});
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** Run one fixture entry point as its own process and collect what it said. */
async function childRun(
  fixture: string,
  env: Record<string, string>,
): Promise<{ code?: number; stdout: string; stderr: string }> {
  return run(process.execPath, [tsx, resolve(here, "__fixtures__", fixture)], {
    env: { ...process.env, ...env },
    // Bounded: a child that keeps listening would otherwise sit here until the
    // test timeout and outlive it.
    timeout: 20_000,
  }).then(
    (ok) => ({ code: 0, stdout: ok.stdout, stderr: ok.stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
}
