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
import { dirname, join, resolve } from "node:path";
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
  const tarball = execFileSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();

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
              zod: zodVersion,
            },
            // Forces the package's own zod dependency onto this major too, so
            // exactly one zod exists in the tree — the one under test.
            overrides: { zod: zodVersion },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(consumer, "check.cjs"), SMOKE);
      writeFileSync(join(consumer, "smoke.cjs"), SMOKE_CJS);
      writeFileSync(join(consumer, "smoke.mjs"), SMOKE_MJS);
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
  console.log("\nzod matrix: every supported zod passes in both module formats, and the main entry needs none");
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
