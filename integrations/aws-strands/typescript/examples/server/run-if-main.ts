/**
 * Run a server entry point only when its module is the process entry.
 *
 * A demo under `server/api/` that is BOTH a standalone server (`pnpm run
 * <demo>`) and a factory `server.ts` imports would open a second, stray port
 * per import if it called `listen()` at import time, so the standalone path is
 * gated on this check.
 *
 * Every demo with a `pnpm run <demo>` script uses it, as does `server.ts`
 * itself. The multi-agent and a2ui demos export a factory and have no
 * standalone script, so they need no guard.
 */

import { realpathSync } from "node:fs";
import type { Server } from "node:http";
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
 *
 * An unset or blank `PORT` falls back to `fallback`. Anything else that is not
 * an integer in 1..65535 THROWS rather than falling back, because a value the
 * operator actually typed and got wrong should not be quietly replaced with a
 * different port. Note `Number` still accepts `"0x1f"` and `"1e4"` as 31 and
 * 10000.
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

/**
 * The host to bind. Blank is treated as unset, the way {@link demoPort} treats a
 * blank `PORT`: `??` alone keeps an empty string, which binds every interface
 * and then announces a URL with no host in it.
 */
function hostFromEnv(): string {
  const raw = process.env.HOST;
  return raw === undefined || raw.trim() === "" ? "0.0.0.0" : raw;
}

/**
 * Start listening, or say why not and exit non-zero.
 *
 * Not the same as passing a callback to `listen` and leaving it there. These
 * demos listen through express, and on a taken port express's `app.listen` runs
 * the callback anyway, with the error as its argument, then emits `error` on the
 * server; `server.listening` stays false. Express types that callback as
 * `() => void`, which hides the argument, so a demo logging from it announces a
 * port it never got, and with no `error` listener the process keeps running and
 * exits 0 having bound nothing reachable. Raw `http.Server.listen` behaves
 * differently, skipping the callback and emitting an `error` that becomes an
 * uncaught exception when nobody is listening for it, so this is about the
 * express path specifically.
 */
export function listenOrExit(
  app: {
    listen(port: number, host: string, callback: () => void): Server;
  },
  demo: string,
  port: number = demoPort(),
  host: string = hostFromEnv(),
): void {
  const announce = (error?: Error) => {
    // Checked, because this same callback runs on failure. The `error` listener
    // below is what reports that case.
    if (error) return;
    console.log(`${demo} demo listening on http://${host}:${port}`);
  };
  const server = app.listen(port, host, announce as () => void);
  server.on("error", (error: NodeJS.ErrnoException) => {
    // Only a pre-listening error means the demo never started. Once it is
    // listening, this is some later server error, and taking the server down
    // over a transient one would drop every open stream with it.
    if (server.listening) {
      console.error(
        `${demo} demo hit a server error on ${host}:${port} (${error.code ?? error.message}); still serving`,
      );
      return;
    }
    console.error(
      `${demo} demo could not listen on ${host}:${port} (${error.code ?? error.message}); nothing is serving`,
    );
    // `exitCode` and a close rather than `process.exit`, which can abandon a
    // buffered write to a pipe and lose the line above. With nothing listening
    // the loop empties on its own and the status still lands.
    process.exitCode = 1;
    server.close();
  });
}

export function runIfMain(moduleUrl: string, main: () => Promise<void>): void {
  // No script path at all means this was not launched as a program (a REPL, an
  // embedding host), so there is no entry point for it to be, and returning is
  // the correct answer rather than a silent failure.
  const entry = process.argv[1];
  if (!entry) return;

  // Left to throw: a module url this cannot parse means the caller passed
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
  // unhandled rejection. This cannot see a bind failure, which arrives as an
  // `error` event on the server rather than a rejection; `listenOrExit` above
  // is what handles those.
  main().catch((error) => {
    console.error(`Failed to start ${basename(modulePath)}:`, error);
    // `exitCode` alone would not be enough: if the failure happened after
    // something started listening, the open handle keeps the process alive and
    // the non-zero status never lands.
    process.exit(1);
  });
}
