import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildModel } from "../generator/ir";
import { generateFiles, OUTPUT_DIR, SCHEMA_PATH } from "../generator/generate";
import { schema } from "./validator";
import * as generatedSchemas from "../../sdks/typescript/packages/core/src/generated/schemas";

const files = await generateFiles();
const model = buildModel(schema);

describe("the generator", () => {
  it("is deterministic: generating twice produces identical output", async () => {
    expect(await generateFiles()).toEqual(files);
  });

  it("matches the committed output, byte for byte", () => {
    // This is the CI gate: a schema or generator change without a matching
    // regeneration fails here, and so does a hand edit to a generated file.
    const committed = readdirSync(OUTPUT_DIR).sort();
    expect(committed).toEqual(files.map((file) => file.name).sort());
    for (const file of files) {
      expect(
        readFileSync(join(OUTPUT_DIR, file.name), "utf8"),
        `${file.name} is stale — run: pnpm --filter @ag-ui/spec generate`,
      ).toBe(file.content);
    }
  });

  it("emits exactly 31 events", () => {
    const eventType = model.definitions.find(
      (definition) => definition.name === "EventType",
    );
    const eventUnion = model.definitions.find(
      (definition) => definition.name === "Event",
    );
    expect(eventType?.kind).toBe("enum");
    expect(eventUnion?.kind).toBe("union");
    if (eventType?.kind !== "enum" || eventUnion?.kind !== "union") return;
    expect(eventType.values).toHaveLength(31);
    expect(eventUnion.members).toHaveLength(31);
  });

  it("derives the version constant from the schema's own address", () => {
    // The constant is never typed by a human: it is the version segment of the
    // $id, which is also the directory the schema lives in.
    const directory = basename(dirname(SCHEMA_PATH));
    expect(model.version).toBe(directory);
    const version = files.find((file) => file.name === "version.ts");
    expect(version?.content).toContain(
      `export const PROTOCOL_VERSION = ${JSON.stringify(model.version)};`,
    );
  });

  it("marks every emitted file as generated", () => {
    for (const file of files) {
      expect(
        file.content.startsWith("// @generated"),
        `${file.name} has no @generated banner`,
      ).toBe(true);
      expect(file.content).toContain("DO NOT EDIT");
      expect(file.content).toContain(model.schemaId);
    }
  });

  it("accounts for every schema definition: emitted, or flattened as a mixin", () => {
    // A definition the reader silently dropped would vanish from every
    // generated SDK. Emitted definitions and mixins must partition $defs.
    const defs = Object.keys(schema.$defs as Record<string, unknown>).sort();
    const emitted = model.definitions.map((definition) => definition.name);
    const covered = [...emitted, ...model.mixins].sort();
    expect(covered).toEqual(defs);
    expect(model.mixins).toEqual(["Attributable", "BaseEvent", "BaseMessage"]);
  });

  it("mentions the generated directory nowhere in the package manifest", () => {
    // The import-graph test below proves nothing reachable from index.ts
    // touches generated/; this closes the other door — a package.json entry
    // (exports, files, main) pointing into it directly.
    const manifest = readFileSync(
      join(OUTPUT_DIR, "..", "..", "package.json"),
      "utf8",
    );
    expect(manifest).not.toContain("generated");
  });

  it("keeps the generated directory out of the package's reachable surface", () => {
    // index.ts is the only entry, so nothing outside generated/ importing from
    // it means nothing exports it. The existing types keep their import paths.
    const srcDir = join(OUTPUT_DIR, "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (path !== OUTPUT_DIR) walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx"))
          continue;
        const source = readFileSync(path, "utf8");
        // Not by import syntax — by path. Every route to a module (from,
        // import(), import-type queries, side-effect imports, require,
        // template literals) has to name the module's path, so the scan flags
        // any reference to the generated directory instead of enumerating
        // syntaxes.
        if (/(\.\/|\.\.\/|src\/|@\/)generated\b/.test(source)) {
          offenders.push(relative(srcDir, path));
        }
      }
    };
    expect(existsSync(srcDir)).toBe(true);
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe("the generated zod schemas against the fixture corpus", () => {
  // The fixtures are the behavioural contract, so the generated validators
  // must agree with them wherever the semantics are meant to coincide. The one
  // deliberate divergence is closure: the spec is strict and the generated zod
  // is loose (unknown keys survive for the strip-and-warn middleware), so a
  // fixture rejected only by unevaluatedProperties is expected to parse.
  const FIXTURES_DIR = join(dirname(SCHEMA_PATH), "fixtures");
  const schemas = generatedSchemas as unknown as Record<
    string,
    { safeParse: (value: unknown) => { success: boolean } }
  >;

  const collect = (
    kind: "valid" | "invalid",
  ): Array<[string, string, string]> => {
    const entries: Array<[string, string, string]> = [];
    for (const anchor of readdirSync(FIXTURES_DIR).sort()) {
      const dir = join(FIXTURES_DIR, anchor, kind);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith(".json") || file.endsWith(".expect.json")) continue;
        entries.push([`${anchor}/${kind}/${file}`, anchor, join(dir, file)]);
      }
    }
    return entries;
  };

  it.each(collect("valid"))("%s parses", (_name, anchor, path) => {
    const validator = schemas[`${anchor}Schema`];
    expect(validator, `no generated schema for ${anchor}`).toBeDefined();
    const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(validator.safeParse(document).success).toBe(true);
  });

  const rejected = collect("invalid").filter(([, , path]) => {
    const expectation = JSON.parse(
      readFileSync(path.replace(/\.json$/, ".expect.json"), "utf8"),
    ) as { keyword: string };
    return expectation.keyword !== "unevaluatedProperties";
  });

  it.each(rejected)("%s fails to parse", (_name, anchor, path) => {
    const validator = schemas[`${anchor}Schema`];
    expect(validator, `no generated schema for ${anchor}`).toBeDefined();
    const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(validator.safeParse(document).success).toBe(false);
  });

  // The tolerant layer's whole promise is that unknown keys SURVIVE the parse
  // — the strip-and-warn middleware needs to see them, and a re-serialising
  // intermediary must not lose them. A silent switch from looseObject to a
  // stripping z.object would pass every assertion above; this is what fails.
  const objectAnchors = new Set(
    model.definitions
      .filter((definition) => definition.kind === "object")
      .map((definition) => definition.name),
  );
  const probeable = collect("valid").filter(([, anchor]) =>
    objectAnchors.has(anchor),
  );

  // The union schemas never run above — every fixture anchor is an object
  // definition — so a broken union (a discriminated union on the wrong key
  // throws at parse time) would pass the whole suite. Every valid fixture of
  // a union member also parses against the union it belongs to.
  const unions = model.definitions.filter(
    (definition) => definition.kind === "union",
  );
  const unionCases: Array<[string, string, string]> = unions.flatMap((union) =>
    union.kind === "union"
      ? collect("valid")
          .filter(([, anchor]) => union.members.includes(anchor))
          .map(
            ([name, , path]) =>
              [`${name} against ${union.name}Schema`, union.name, path] as [
                string,
                string,
                string,
              ],
          )
      : [],
  );

  it("has union member fixtures to run", () => {
    expect(unionCases.length).toBeGreaterThan(0);
  });

  it.each(unionCases)("%s parses", (_name, unionName, path) => {
    const validator = schemas[`${unionName}Schema`];
    const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(validator.safeParse(document).success).toBe(true);
  });

  it("rejects a document that is not an event, through the union", () => {
    expect(
      schemas.EventSchema.safeParse({ type: "NOT_AN_EVENT" }).success,
    ).toBe(false);
  });

  it.each(probeable)(
    "%s keeps an unknown key through the parse",
    (_name, anchor, path) => {
      const validator = schemas[`${anchor}Schema`] as {
        safeParse: (value: unknown) => {
          success: boolean;
          data?: Record<string, unknown>;
        };
      };
      const document = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      const result = validator.safeParse({ ...document, xPassthroughProbe: 1 });
      expect(result.success).toBe(true);
      expect(result.data?.xPassthroughProbe).toBe(1);
    },
  );
});
