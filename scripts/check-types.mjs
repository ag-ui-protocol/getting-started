#!/usr/bin/env node
// Runs the repository-wide TypeScript typecheck via Nx.
//
// `nx run-many` exits 0 when its target selection is empty ("No tasks were
// run"), which is how the root command stayed green for months while pointing
// at a target name no project had (PNI-299). This wrapper fails when zero
// projects expose `typecheck`, and prints the selected-project count so an
// empty selection can never pass silently.
//
// The command's contract is "typecheck every project". Selection flags such as
// --projects/--exclude are rejected rather than forwarded: they could narrow
// the run to zero tasks behind the guard's back, and re-implementing Nx's
// argument parsing here just to keep the count honest is a losing game. For a
// custom selection, call `pnpm nx run-many -t typecheck --projects=...`
// directly and own its empty-selection semantics.

import { spawnSync } from "node:child_process";

const useShell = process.platform === "win32";

// pnpm forwards the `--` separator itself (`pnpm run check-types -- --skip-nx-cache`
// yields argv ["--", "--skip-nx-cache"]), and nx would treat everything after `--`
// as task overrides and hand it to tsc. Strip it so forwarded flags reach nx.
const forwarded = process.argv.slice(2).filter((arg, index) => !(arg === "--" && index === 0));

// Selection-neutral flags only; anything else is refused with a pointer to nx.
const allowedFlags = new Set(["--skip-nx-cache", "--verbose"]);
const rejected = forwarded.filter((arg) => !allowedFlags.has(arg));
if (rejected.length > 0) {
  console.error(
    `check-types: unsupported argument(s): ${rejected.join(" ")}\n` +
      "check-types always typechecks every project. For a custom selection run\n" +
      "  pnpm nx run-many -t typecheck --projects=<projects>\n" +
      "directly (note: nx exits 0 when the selection is empty).",
  );
  process.exit(1);
}

const shown = spawnSync("nx", ["show", "projects", "--with-target", "typecheck", "--json"], {
  encoding: "utf8",
  shell: useShell,
});

if (shown.status !== 0) {
  process.stderr.write(shown.stdout ?? "");
  process.stderr.write(shown.stderr ?? "");
  console.error("check-types: failed to list projects with a typecheck target.");
  process.exit(shown.status ?? 1);
}

let projects;
try {
  projects = JSON.parse(shown.stdout);
} catch {
  console.error("check-types: could not parse `nx show projects` output:");
  console.error(shown.stdout);
  process.exit(1);
}

if (!Array.isArray(projects) || projects.length === 0) {
  console.error(
    "check-types: no projects expose a `typecheck` target; refusing to report success.",
  );
  process.exit(1);
}

console.log(`check-types: running the typecheck target for ${projects.length} projects`);

const run = spawnSync("nx", ["run-many", "-t", "typecheck", ...forwarded], {
  stdio: "inherit",
  shell: useShell,
});

process.exit(run.status ?? 1);
