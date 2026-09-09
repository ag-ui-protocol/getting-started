// Proves the built package works under both supported zod majors, in both
// module formats, and that the main entry works with NO zod installed. zod is
// an optional peer; all runtime code uses the `zod/v4` subpath API, which zod
// ships in 3.25+ and in 4.x — so a consumer forcing either major must get a
// working package. Each matrix cell installs the packed tarball next to a
// pinned zod (an npm override forces the package's own dependency onto that
// major) and runs the same smoke through require() and import.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The declared peer range is ^3.25.18 || ^4.0.0: its floor, the workspace pin, and current 4.x.
const ZOD_VERSIONS = ["3.25.18", "3.25.76", "4"];

const SMOKE = `
const check = (core, schemas, label) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(label + ": " + message);
  };
  assert(core.EventType.TEXT_MESSAGE_START === "TEXT_MESSAGE_START", "EventType constant");
  assert(core.EventSchemas === undefined, "main entry must not serve validators (zod is optional)");
  assert(typeof schemas.EventSchemas.parse === "function", "subpath serves EventSchemas under its historic name");
  const parsed = schemas.EventSchema.parse({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "m1",
    delta: "hi",
    xUnknownKey: 1,
  });
  assert(parsed.xUnknownKey === 1, "unknown keys survive the parse");
  const rejected = schemas.EventSchema.safeParse({ type: "NOT_AN_EVENT" });
  assert(rejected.success === false, "the union rejects a non-event");
  assert(typeof schemas.PROTOCOL_VERSION === "string", "subpath serves the version");
  console.log(label + ": ok");
};
module.exports = { check };
`;

// Drives the client's full pipeline — enforce → strip → verify → apply — through a real
// AbstractAgent: an unknown member must be stripped with a warning, a malformed known value
// must be fatal. Both depend on the per-type validator map the client builds from core's
// schemas, which is exactly what breaks when the two packages hold different zod copies.
const CLIENT_SMOKE = `
import { AbstractAgent, EventType } from "@ag-ui/client";
import { of } from "rxjs";
const fail = (m) => { throw new Error("client: " + m); };
const agent = (mutate) => new (class extends AbstractAgent {
  run(input) {
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
      mutate({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hi" }),
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" },
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
    );
  }
})({ threadId: "t" });
const warns = []; const warn = console.warn; console.warn = (...a) => warns.push(a.join(" "));
const ok = await agent((e) => ({ ...e, xUnknownKey: 1 })).runAgent({}, {});
console.warn = warn;
if (ok.newMessages?.[0]?.content !== "hi") fail("pipeline lost the message");
if (!warns.some((w) => /xUnknownKey/.test(w))) fail("unknown member not stripped with a warning");
// The client logs the failure it is about to throw; that is the expected outcome here, so keep it out of the CI log.
const error = console.error; console.error = () => {};
let fatal = false; try { await agent((e) => ({ ...e, delta: 123 })).runAgent({}, {}); } catch { fatal = true; } finally { console.error = error; }
if (!fatal) fail("malformed known value was not fatal");
console.log("client pipeline: ok (unknown stripped + warned, malformed fatal)");
`;

const SMOKE_CJS = `
const { check } = require("./check.cjs");
check(require("@ag-ui/core"), require("@ag-ui/core/schemas"), "require");
`;

const SMOKE_MJS = `
import { createRequire } from "node:module";
import * as core from "@ag-ui/core";
import * as schemas from "@ag-ui/core/schemas";
const { check } = createRequire(import.meta.url)("./check.cjs");
check(core, schemas, "import");
`;

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

const packDir = mkdtempSync(join(tmpdir(), "agui-zod-matrix-"));
try {
  // pnpm, not npm: the siblings depend on each other as `workspace:*`, which only
  // pnpm rewrites to the concrete version when packing. npm would ship the
  // literal `workspace:*` and the consumer install would refuse it.
  // pnpm prints the tarball's absolute path as its last line (npm printed a bare
  // filename); basename() makes the join below correct for either.
  const pack = (dir) =>
    basename(
      execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: dir, encoding: "utf8" })
        .trim()
        .split("\n")
        .pop(),
    );
  const tarball = pack(PACKAGE_DIR);
  // The client cell: core is an optional peer, but @ag-ui/client pins its own zod, so an
  // application on a different zod holds TWO copies — client's enforcement then introspects
  // schemas built by the copy it did not resolve. That is where a core-only matrix is blind
  // (zod@3.25.18 next to client's 3.25.76 once keyed every event schema under "undefined").
  const SIBLINGS = ["proto", "encoder", "client"];
  const siblingTarballs = Object.fromEntries(
    SIBLINGS.map((name) => [name, pack(join(PACKAGE_DIR, "..", name))]),
  );

  for (const zodVersion of ZOD_VERSIONS) {
    const consumer = mkdtempSync(join(tmpdir(), `agui-zod-${zodVersion.replace(/[^0-9]/g, "")}-`));
    try {
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify(
          {
            name: "agui-zod-matrix-consumer",
            private: true,
            dependencies: {
              "@ag-ui/core": `file:${join(packDir, tarball)}`,
              ...Object.fromEntries(
                SIBLINGS.map((name) => [`@ag-ui/${name}`, `file:${join(packDir, siblingTarballs[name])}`]),
              ),
              rxjs: "7.8.1",
              zod: zodVersion,
            },
            // No override: the point of the cell is the layout npm actually
            // produces — client's pinned zod nested beside the consumer's — so
            // two copies coexist whenever they differ.
          },
          null,
          2,
        ),
      );
      writeFileSync(join(consumer, "check.cjs"), SMOKE);
      writeFileSync(join(consumer, "smoke.cjs"), SMOKE_CJS);
      writeFileSync(join(consumer, "smoke.mjs"), SMOKE_MJS);
      writeFileSync(join(consumer, "client-smoke.mjs"), CLIENT_SMOKE);
      run("npm", ["install", "--no-audit", "--no-fund", "--silent"], consumer);
      const installed = execFileSync("node", ["-p", "require('zod/package.json').version"], {
        cwd: consumer,
        encoding: "utf8",
      }).trim();
      if (!installed.startsWith(zodVersion.replace(/[^0-9.].*$/, ""))) {
        throw new Error(`expected zod ${zodVersion}, got ${installed}`);
      }
      console.log(`\n== zod@${installed} ==`);
      run("node", ["smoke.cjs"], consumer);
      run("node", ["smoke.mjs"], consumer);
      run("node", ["client-smoke.mjs"], consumer);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  }
  // The optional-peer guarantee itself: with no zod in the tree, the main entry
  // still imports and serves its constants, and only the subpath is unavailable.
  const bare = mkdtempSync(join(tmpdir(), "agui-zod-none-"));
  try {
    writeFileSync(
      join(bare, "package.json"),
      JSON.stringify(
        { name: "agui-zod-none-consumer", private: true, dependencies: { "@ag-ui/core": `file:${join(packDir, tarball)}` } },
        null,
        2,
      ),
    );
    writeFileSync(
      join(bare, "smoke.cjs"),
      `const core = require("@ag-ui/core");
if (core.EventType.TEXT_MESSAGE_START !== "TEXT_MESSAGE_START") throw new Error("no zod: EventType constant");
if (core.EventSchemas !== undefined) throw new Error("no zod: main entry served a validator");
let threw = false; try { require("@ag-ui/core/schemas"); } catch { threw = true; }
if (!threw) throw new Error("no zod: the schemas subpath should fail without zod");
console.log("no zod: main entry ok, subpath unavailable as expected");`,
    );
    run("npm", ["install", "--no-audit", "--no-fund", "--silent"], bare);
    const zodPresent = execFileSync("node", ["-e", "try{require.resolve('zod');process.stdout.write('yes')}catch{process.stdout.write('no')}"], { cwd: bare, encoding: "utf8" });
    if (zodPresent !== "no") throw new Error("no-zod cell: zod was installed anyway (optional peer not honoured?)");
    console.log("\n== no zod ==");
    run("node", ["smoke.cjs"], bare);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
  console.log("\nzod matrix: every supported zod passes in both module formats, the client pipeline runs on each, and the main entry needs none");
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
