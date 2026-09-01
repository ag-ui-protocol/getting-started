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
import { emitDotnet } from "./dotnet";
import { emitDotnetModels } from "./dotnet-models";
import { buildWireModel, emitFreeze, emitProtoFiles } from "./protobuf";
import { emitPython } from "./python";
import { emitSchemaReference } from "./schema-reference";
import { emitProtoTranslation } from "./proto-translation";
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

export const PROTO_PACKAGE_DIR = join(
  REPO_ROOT,
  "sdks",
  "typescript",
  "packages",
  "proto",
);

export const PROTO_OUTPUT_DIR = join(PROTO_PACKAGE_DIR, "src", "proto");

export const FREEZE_PATH = join(HERE, "..", "draft", "proto-freeze.txt");

export const DOTNET_MODELS_OUTPUT_DIR = join(
  HERE,
  "..",
  "..",
  "sdks",
  "dotnet",
  "src",
  "AGUI.Abstractions",
  "Generated",
);

/**
 * Where the schema is published on the web. Every schema file states its own
 * address in `$id`, and tools fetch that address to resolve it, so the file the
 * docs site serves has to be the same bytes as the file the SDKs are generated
 * from. Emitting it as an output puts it under the drift gate: a schema edit
 * without a regeneration fails there rather than silently publishing a stale
 * contract.
 */
export const DOCS_SPEC_OUTPUT_DIR = join(REPO_ROOT, "docs", "spec", "draft");

export const DOTNET_OUTPUT_DIR = join(
  REPO_ROOT,
  "sdks",
  "dotnet",
  "src",
  "AGUI.Protobuf",
  "Generated",
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

  // The wire freeze is both input and output: frozen slots keep their
  // numbers, new slots are appended, and the diff gate reviews the result.
  const wire = buildWireModel(model, readFileSync(FREEZE_PATH, "utf8"));
  const protoFiles = emitProtoFiles(wire).map((file) => ({
    path: join(PROTO_OUTPUT_DIR, file.name),
    content: file.content,
  }));
  const translation = {
    path: join(PROTO_PACKAGE_DIR, "src", "proto.ts"),
    content: await format(emitProtoTranslation(wire), {
      ...config,
      parser: "typescript",
    }),
  };
  const freeze = { path: FREEZE_PATH, content: emitFreeze(wire) };

  // Byte-identical to spec/draft/schema.json: the published copy is the source,
  // not a re-serialisation of it, so `$id` and the address it is fetched from
  // cannot drift apart and no formatting difference can creep in.
  const published = {
    path: join(DOCS_SPEC_OUTPUT_DIR, "schema.json"),
    content: readFileSync(SCHEMA_PATH, "utf8"),
  };

  // The one generated page among the hand-written ones: the reference the
  // prose links into instead of restating shapes. Emitted in final form —
  // no prettier pass, so the bytes cannot depend on a formatter's opinion
  // of prose.
  const schemaReference = {
    path: join(DOCS_SPEC_OUTPUT_DIR, "schema.mdx"),
    content: emitSchemaReference(model),
  };

  const dotnet = emitDotnet(wire).map((file) => ({
    path: join(DOTNET_OUTPUT_DIR, file.name),
    content: file.content,
  }));
  const dotnetModels = emitDotnetModels(model).map((file) => ({
    path: join(DOTNET_MODELS_OUTPUT_DIR, file.name),
    content: file.content,
  }));

  return [
    ...typescript,
    ...python,
    ...protoFiles,
    ...dotnetModels,
    translation,
    freeze,
    published,
    schemaReference,
    ...dotnet,
  ];
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
