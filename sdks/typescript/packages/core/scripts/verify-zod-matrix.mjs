// Proves the built package works under both supported zod majors, in both
// module formats. The package declares zod ^3.25.76 (unchanged until
// activation), but all runtime code uses the `zod/v4` subpath API, which zod
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
const ZOD_VERSIONS = ["3.25.76", "4"];

const SMOKE = `
const check = (core, schemas, label) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(label + ": " + message);
  };
  assert(core.EventType.TEXT_MESSAGE_START === "TEXT_MESSAGE_START", "EventType constant");
  assert(typeof core.EventSchemas.parse === "function", "main entry serves EventSchemas");
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
  console.log("\nzod matrix: both majors pass in both module formats");
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
