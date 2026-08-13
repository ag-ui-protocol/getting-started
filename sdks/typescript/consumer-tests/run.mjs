#!/usr/bin/env node
/**
 * Packaged-consumer compatibility harness for the supported zod range.
 *
 * Builds real tarballs of @ag-ui/core, @ag-ui/encoder, @ag-ui/proto and
 * @ag-ui/client, installs them into a throwaway project alongside one specific
 * zod version, then runs three gates:
 *
 *   1. typecheck  - tsc --noEmit, strict, NodeNext, skipLibCheck:false over files
 *                   importing @ag-ui/core/schemas and @ag-ui/client. This is what
 *                   catches zod-major-specific declaration shapes leaking into the
 *                   published .d.ts (ZodEnum<[...]>, five-parameter ZodObject,
 *                   ZodEffects, ...).
 *   2. conformance - runs the shared event corpus through EventSchemas and asserts
 *                   the accept/reject verdict and post-parse normalization. Any
 *                   engine-level behavior change shows up as a red leg here
 *                   rather than as a protocol change under consumers.
 *   3. no-zod     - imports @ag-ui/core with zod absent entirely, proving the main
 *                   entry really is dependency-free.
 *
 * Usage:
 *   node run.mjs                 # the default legs (see DEFAULT_LEGS below)
 *   node run.mjs 4.4.3           # one version
 *   node run.mjs 3.25.76 4 none  # explicit legs ("none" = the no-zod gate)
 *   node run.mjs --list          # print the default legs and exit
 *
 * Any version can be passed ad hoc, so spot-checking a release that is not in the
 * default list needs no code change: `node run.mjs 4.5.0`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(HERE, "..");
const PACKAGES = ["core", "encoder", "proto", "client"];
const CORPUS = resolve(
  SDK_ROOT,
  "packages/core/src/__tests__/fixtures/event-corpus.ts",
);

// Deliberately a short, hand-maintained list rather than something resolved from
// the registry: an explicit matrix is easier to reason about, and a CI job that
// silently changes shape when a dependency publishes is worse than one that needs
// a one-line edit. Add versions here when there is a reason to.
//
//   3.25.18 - the advertised floor, established by bisection. zod 3.24.x has no
//             `zod/v4` subpath at all; 3.25.0 is a broken publish with no dist/;
//             and 3.25.1-3.25.17 ship `zod/v4` declarations that fail TS variance
//             checks under skipLibCheck:false. 3.25.18 is the first clean one.
//   4.0.0  - the zod 4 floor.
//   4.4.3  - latest zod 4 at time of writing.
//   none   - no zod installed, proving the main @ag-ui/core entry is dep-free.
const DEFAULT_LEGS = ["3.25.18", "4.0.0", "4.4.3", "none"];

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(cmd, args, cwd, opts = {}) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : "pipe",
    // Only .cmd shims need a shell. Routing process.execPath through cmd.exe
    // breaks on the unquoted space in "C:\Program Files\nodejs".
    shell: /\.cmd$/i.test(cmd),
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** node_modules/.bin/<name>, with the Windows shim extension when needed. */
const binPath = (dir, name) =>
  join(dir, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

/** `pnpm pack` (not npm) so `workspace:*` deps are rewritten to real versions. */
function packAll(outDir) {
  mkdirSync(outDir, { recursive: true });
  const tarballs = {};
  for (const name of PACKAGES) {
    const pkgDir = join(SDK_ROOT, "packages", name);
    const out = run(pnpmCmd, ["pack", "--pack-destination", outDir], pkgDir).trim();
    // pnpm prints the tarball path on the last line; it may be absolute or bare.
    const tgz = out.split(/\r?\n/).filter(Boolean).pop();
    const tarball = resolve(outDir, tgz);
    if (!existsSync(tarball)) throw new Error(`pnpm pack did not produce ${tarball}`);
    tarballs[`@ag-ui/${name}`] = tarball;
  }
  return tarballs;
}

const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    // The whole point: library declarations are CHECKED, not skipped.
    skipLibCheck: false,
    noEmit: true,
    types: [],
  },
  include: ["*.ts"],
};

function writeConsumer(dir, { tarballs, zod }) {
  mkdirSync(dir, { recursive: true });

  const dependencies = {};
  const overrides = {};
  const wanted = zod === "none" ? ["@ag-ui/core"] : PACKAGES.map((p) => `@ag-ui/${p}`);
  for (const name of wanted) dependencies[name] = `file:${tarballs[name]}`;
  // Force @ag-ui/* transitive deps onto the local tarballs — their versions are
  // unpublished, so registry resolution would fail.
  for (const [name, tgz] of Object.entries(tarballs)) overrides[name] = `file:${tgz}`;
  if (zod !== "none") dependencies.zod = zod;
  dependencies.typescript = "5.8.3";

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "agui-consumer", private: true, dependencies, overrides }, null, 2),
  );
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2));
  cpSync(CORPUS, join(dir, "event-corpus.ts"));

  if (zod === "none") {
    // Types, the EventType enum and AGUIError must all work with zod absent.
    writeFileSync(
      join(dir, "core-only.ts"),
      `import { EventType, AGUIError } from "@ag-ui/core";
import type { Message, RunAgentInput, TextMessageContentEvent, Tool } from "@ag-ui/core";

const event: TextMessageContentEvent = {
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "m1",
  delta: "hi",
};
const tool: Tool = { name: "search", description: "searches" };
const input: RunAgentInput = {
  threadId: "t1", runId: "r1", messages: [] as Message[], tools: [tool], context: [],
};
if (event.type !== EventType.TEXT_MESSAGE_CONTENT) throw new AGUIError("unreachable");
if (input.state !== undefined) throw new AGUIError("unreachable");
console.log("core-only ok");
`,
    );
    return;
  }

  // Gate 1 fixtures: importing these must not surface a single library error.
  writeFileSync(
    join(dir, "schemas-consumer.ts"),
    `import {
  EventSchemas,
  MessageSchema,
  RunAgentInputSchema,
  ToolSchema,
  UserMessageSchema,
  createTextMessageContentEvent,
  createRunStartedEvent,
} from "@ag-ui/core/schemas";
import { EventType } from "@ag-ui/core";
import type { TextMessageContentEvent } from "@ag-ui/core";

const parsed = EventSchemas.parse({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hi" });
const user = UserMessageSchema.parse({ id: "1", role: "user", content: "hi" });
const message = MessageSchema.parse({ id: "1", role: "system", content: "s" });
const tool = ToolSchema.parse({ name: "s", description: "d" });
const input = RunAgentInputSchema.parse({
  threadId: "t", runId: "r", messages: [], tools: [], context: [],
});
const built: TextMessageContentEvent = createTextMessageContentEvent({ messageId: "m", delta: "d" });
const started = createRunStartedEvent({ threadId: "t", runId: "r" });
if (started.type !== EventType.RUN_STARTED) throw new Error("unreachable");
console.log("schemas-consumer ok", parsed.type, user.role, message.role, tool.name, input.runId, built.delta);
`,
  );

  writeFileSync(
    join(dir, "client-consumer.ts"),
    `// @ag-ui/client re-exports @ag-ui/core and @ag-ui/core/schemas, and declares its
// own zod schemas in src/legacy/types.ts — all of it has to type-check too.
//
// The factory import is the load-bearing one: the 0.1.0 migration guide promises
// that consumers importing from @ag-ui/client need no migration even though the
// create*Event factories left the main @ag-ui/core entry. That promise rests on
// client's \`export * from "@ag-ui/core/schemas"\`, so it is asserted here rather
// than assumed.
import {
  AbstractAgent,
  HttpAgent,
  EventSchemas,
  EventType,
  createTextMessageContentEvent,
  createRunFinishedInterruptEvent,
} from "@ag-ui/client";
import type { BaseEvent, Message, TextMessageContentEvent } from "@ag-ui/client";

const parsed: BaseEvent = EventSchemas.parse({
  type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hi",
}) as BaseEvent;
const built: TextMessageContentEvent = createTextMessageContentEvent({
  messageId: "m", delta: "hi",
});
const finished = createRunFinishedInterruptEvent({
  threadId: "t", runId: "r", interrupts: [{ id: "i1", reason: "tool_call" }],
});
const messages: Message[] = [];
declare const agent: AbstractAgent;
declare const http: HttpAgent;
if (parsed.type !== EventType.TEXT_MESSAGE_CONTENT) throw new Error("unreachable");
if (finished.type !== EventType.RUN_FINISHED) throw new Error("unreachable");
console.log("client-consumer ok", messages.length, typeof agent, typeof http, built.delta);
`,
  );

  // Gate 2: same corpus, arbitrary zod version.
  writeFileSync(
    join(dir, "conformance.ts"),
    `import { EventSchemas } from "@ag-ui/core/schemas";
import { ACCEPT, REJECT } from "./event-corpus";

let failures = 0;
const fail = (msg: string) => { console.error("  FAIL " + msg); failures++; };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

for (const testCase of ACCEPT) {
  const result = EventSchemas.safeParse(testCase.payload);
  if (!result.success) {
    fail("expected ACCEPT: " + testCase.name + " -> " + JSON.stringify(result.error.issues));
    continue;
  }
  for (const [key, value] of Object.entries(testCase.expect ?? {})) {
    const actual = (result.data as Record<string, unknown>)[key];
    if (!same(actual, value)) {
      fail(testCase.name + ": expected " + key + "=" + JSON.stringify(value) +
           " but got " + JSON.stringify(actual));
    }
  }
}
for (const testCase of REJECT) {
  if (EventSchemas.safeParse(testCase.payload).success) {
    fail("expected REJECT: " + testCase.name);
  }
}

console.log("  corpus: " + ACCEPT.length + " accept + " + REJECT.length + " reject");
// Throwing (rather than process.exit) keeps this fixture free of @types/node, so
// the typecheck gate runs with types:[] and only library declarations are in play.
if (failures > 0) throw new Error("  " + failures + " conformance failure(s)");
console.log("  conformance ok");
`,
  );
}

function runLeg(zod, tarballs) {
  const dir = mkdtempSync(join(tmpdir(), `agui-consumer-${zod.replace(/\./g, "_")}-`));
  const label = zod === "none" ? "no zod installed" : `zod ${zod}`;
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    writeConsumer(dir, { tarballs, zod });
    run(npmCmd, ["install", "--no-audit", "--no-fund", "--silent"], dir);

    if (zod !== "none") {
      const installed = JSON.parse(
        run(process.execPath, ["-p", "JSON.stringify(require('zod/package.json').version)"], dir),
      );
      const engine = run(
        process.execPath,
        ["-p", "JSON.stringify(require('zod/v4/core').version)"],
        dir,
      ).trim();
      console.log(`  zod ${installed}, zod/v4 engine ${engine}`);
    } else if (existsSync(join(dir, "node_modules", "zod"))) {
      throw new Error("zod was installed in the no-zod leg");
    }

    // Gate 1 / 3: typecheck with library declarations CHECKED.
    const tsc = binPath(dir, "tsc");
    try {
      run(tsc, ["-p", "tsconfig.json", "--pretty", "false"], dir);
      console.log("  typecheck ok (strict, NodeNext, skipLibCheck:false)");
    } catch (err) {
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      const count = (out.match(/error TS/g) ?? []).length;
      console.error(`  typecheck FAILED with ${count} error(s):`);
      console.error(
        out
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(0, 15)
          .map((l) => `    ${l}`)
          .join("\n"),
      );
      return false;
    }

    // Gate 2 / 3: actually execute.
    const entry = zod === "none" ? "core-only.ts" : "conformance.ts";
    run(tsc, [entry, "--target", "ES2022", "--module", "commonjs", "--moduleResolution", "node",
              "--outDir", "out", "--skipLibCheck", "--pretty", "false"], dir);
    run(process.execPath, [join("out", entry.replace(/\.ts$/, ".js"))], dir, { inherit: true });
    return true;
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    if (err.stdout) console.error(String(err.stdout).split(/\r?\n/).slice(0, 20).join("\n"));
    if (err.stderr) console.error(String(err.stderr).split(/\r?\n/).slice(0, 20).join("\n"));
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
if (argv[0] === "--list") {
  console.log(DEFAULT_LEGS.join("\n"));
  process.exit(0);
}

const legs = argv.length > 0 ? argv : DEFAULT_LEGS;
console.log(`Supported range: ^3.25.18 || ^4.0.0 (via the zod/v4 subpath)`);
console.log(`Legs: ${legs.join(", ")}`);

const staging = mkdtempSync(join(tmpdir(), "agui-tarballs-"));
let ok = true;
try {
  const tarballs = packAll(staging);
  for (const leg of legs) ok = runLeg(leg, tarballs) && ok;
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log(ok ? "\nAll legs passed." : "\nFAILED");
process.exit(ok ? 0 : 1);
