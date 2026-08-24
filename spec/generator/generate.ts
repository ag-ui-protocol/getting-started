/**
 * The entry point: schema in, committed source files out, deterministically.
 *
 * `generateFiles` is the pure pipeline (read → model → emit → format), used by
 * the suite to regenerate in memory and diff against what is committed — that
 * test is the CI gate, so this file needs no --check mode. Running it directly
 * writes the files.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { buildModel } from "./ir";
import { emitPython } from "./python";
import { emitTypeScript } from "./typescript";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

export const SCHEMA_PATH = join(HERE, "..", "draft", "schema.json");

export const TS_OUTPUT_DIR = join(
  REPO_ROOT,
  "sdks",
  "typescript",
  "packages",
  "core",
  "src",
  "generated",
);

export const PY_OUTPUT_DIR = join(
  REPO_ROOT,
  "sdks",
  "python",
  "ag_ui",
  "_generated",
);

export interface GeneratedOutput {
  /** Absolute path the file is committed at. */
  path: string;
  content: string;
}

export async function generateFiles(): Promise<GeneratedOutput[]> {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  const model = buildModel(schema);

  // TypeScript is formatted with the repo's own prettier config, resolved
  // against the output location, so the generated files pass the same format
  // check as everything else and the bytes are stable across machines (the
  // version is pinned by the lockfile). Python is emitted in final form.
  const config = (await resolveConfig(join(TS_OUTPUT_DIR, "x.ts"))) ?? {};
  const typescript = await Promise.all(
    emitTypeScript(model).map(async (file) => ({
      path: join(TS_OUTPUT_DIR, file.name),
      content: await format(file.content, { ...config, parser: "typescript" }),
    })),
  );

  const python = emitPython(model).map((file) => ({
    path: join(PY_OUTPUT_DIR, file.name),
    content: file.content,
  }));

  return [...typescript, ...python];
}

async function main(): Promise<void> {
  const files = await generateFiles();
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }
  console.log(`Wrote ${files.length} files:`);
  for (const file of files) console.log(`  ${file.path}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
