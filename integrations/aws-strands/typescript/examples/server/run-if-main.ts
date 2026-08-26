/**
 * Run a server entry point only when its module is the process entry.
 *
 * A demo under `server/api/` that is BOTH a standalone server (`pnpm run
 * <demo>`) and a factory `server.ts` imports would open a second, stray port
 * per import if it called `listen()` at import time, so the standalone path is
 * gated on this check.
 *
 * The demos this change adds use it. The older ones still call `void main()`
 * unguarded and are safe only because `server.ts` does not import them; the
 * a2ui ones export a factory and have no standalone script at all. Converting
 * those is its own change.
 */

import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a path through symlinks so the comparison below comes out the same
 * whichever route the launcher took.
 *
 * A missing path falls back to the path as given, which lets the comparison fail
 * cleanly for an entry that is not on disk. Any other failure (a permission
 * problem, a symlink loop) also falls back, but says so first: this runs at
 * import time, so throwing here would take down the dojo server that imports
 * this module for its factory, which is a worse outcome than one demo's
 * standalone launch comparing unresolved paths.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(`Could not resolve ${path} through symlinks:`, error);
    }
    return path;
  }
}

/**
 * The port a standalone demo should listen on.
 *
 * `Number(process.env.PORT)` is not enough: an empty or malformed value yields
 * 0 or NaN, and `listen(0)` silently binds an arbitrary free port, so the demo
 * appears to start while nothing can reach it.
 */
export function demoPort(fallback = 8000): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

export function runIfMain(moduleUrl: string, main: () => Promise<void>): void {
  // No script path at all means this was not launched as a program (a REPL, an
  // embedding host), so there is no entry point for it to be, and returning is
  // the correct answer rather than a silent failure.
  const entry = process.argv[1];
  if (!entry) return;

  // Not swallowed: a module url this cannot parse means the caller passed
  // something other than `import.meta.url`, and returning quietly would exit 0
  // having started no server.
  const modulePath = fileURLToPath(moduleUrl);

  // Comparing real paths rather than the URLs as given: a launcher that reaches
  // the file through a symlink (pnpm's bin shims, a linked checkout) would
  // otherwise fail the comparison, and the server would never start while still
  // exiting 0, which looks like success.
  if (canonical(entry) !== canonical(modulePath)) return;

  // Surfaced rather than discarded: a rejection here (a missing API key, a
  // model factory that threw) is the whole outcome of running this file, so it
  // names the demo and exits non-zero instead of producing an anonymous
  // unhandled rejection. Note this cannot see a bind failure: `listen` reports
  // those as an `error` event on the server it returns, not as a rejection.
  main().catch((error) => {
    console.error(`Failed to start ${basename(modulePath)}:`, error);
    // `exitCode` alone would not be enough: if the failure happened after
    // something started listening, the open handle keeps the process alive and
    // the non-zero status never lands.
    process.exit(1);
  });
}
