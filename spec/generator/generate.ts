/**
 * The entry point: schema in, committed source files out, deterministically.
 *
 * `generateFiles` is the pure pipeline (read → model → emit → format), used by
 * the suite to regenerate in memory and diff against what is committed — that
 * test is the CI gate, so this file needs no --check mode. Running it directly
 * writes the files.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { buildModel } from "./ir";
import { emitTypeScript, type GeneratedFile } from "./typescript";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export const SCHEMA_PATH = join(HERE, "..", "draft", "schema.json");

export const OUTPUT_DIR = join(
  HERE,
  "..",
  "..",
  "sdks",
  "typescript",
  "packages",
  "core",
  "src",
  "generated",
);

export async function generateFiles(): Promise<GeneratedFile[]> {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  const model = buildModel(schema);
  const files = emitTypeScript(model);
  // Formatted with the repo's own prettier config, resolved against the output
  // location, so the generated files pass the same format check as everything
  // else and the bytes are stable across machines (the version is pinned by
  // the lockfile).
  const config = (await resolveConfig(join(OUTPUT_DIR, "x.ts"))) ?? {};
  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      content: await format(file.content, { ...config, parser: "typescript" }),
    })),
  );
}

async function main(): Promise<void> {
  const files = await generateFiles();
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const file of files) {
    writeFileSync(join(OUTPUT_DIR, file.name), file.content);
  }
  console.log(
    `Wrote ${files.map((file) => file.name).join(", ")} to ${OUTPUT_DIR}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
