import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildModel } from "../generator/ir";
import { buildWireModel, emitProtoFiles } from "../generator/protobuf";
import { FREEZE_PATH } from "../generator/generate";
import {
  DOCS_SPEC_OUTPUT_DIR,
  DOTNET_MODELS_OUTPUT_DIR,
  DOTNET_OUTPUT_DIR,
  generateFiles,
  PROTO_OUTPUT_DIR,
  PY_OUTPUT_DIR,
  SCHEMA_PATH,
  TS_OUTPUT_DIR,
} from "../generator/generate";
import { schema } from "./validator";
import {
  RECONCILIATION_PATH,
  render as renderReconciliation,
} from "../tools/reconcile";
import * as generatedSchemas from "../../sdks/typescript/packages/core/src/generated/schemas";

const files = await generateFiles();
const PUBLISHED_SCHEMA_PATH = join(DOCS_SPEC_OUTPUT_DIR, "schema.json");
const model = buildModel(schema);
/** Where the emitters live, for the two exemption sets neither of them exports. */
const GENERATOR_DIR = join(SCHEMA_PATH, "..", "..", "generator");

describe("the generator", () => {
  it("is deterministic: generating twice produces identical output", async () => {
    expect(await generateFiles()).toEqual(files);
  });

  it("matches the committed output, byte for byte", () => {
    // This is the CI gate: a schema or generator change without a matching
    // regeneration fails here, and so does a hand edit to a generated file.
    for (const dir of [
      TS_OUTPUT_DIR,
      PY_OUTPUT_DIR,
      PROTO_OUTPUT_DIR,
      DOTNET_OUTPUT_DIR,
      DOTNET_MODELS_OUTPUT_DIR,
      DOCS_SPEC_OUTPUT_DIR,
    ]) {
      const committed = readdirSync(dir)
        .filter((name) => name !== "__pycache__")
        // The published schema shares its folder with the specification pages,
        // by design: /spec/draft/schema.json is a file and /spec/draft/lifecycle
        // is a page. The pages are hand-written and not the generator's
        // business — except schema.mdx, the generated reference — so the
        // "nothing here the generator did not emit" rule applies to the
        // machine-readable half plus that one page.
        .filter(
          (name) =>
            dir !== DOCS_SPEC_OUTPUT_DIR ||
            name.endsWith(".json") ||
            name === "schema.mdx",
        )
        .sort();
      const emitted = files
        .filter((file) => dirname(file.path) === dir)
        .map((file) => basename(file.path))
        .sort();
      expect(committed, `${dir} has files the generator did not emit`).toEqual(
        emitted,
      );
    }
    for (const file of files) {
      expect(
        readFileSync(file.path, "utf8"),
        `${file.path} is stale — run: pnpm --filter @ag-ui/spec generate`,
      ).toBe(file.content);
    }
  });

  it("keeps RECONCILIATION.md in step with the SDK sources it reads", () => {
    // reconcile.ts is a separate script from generate.ts, so the gate above
    // never looked at its output and the committed report sat stale for weeks.
    // It reads the three SDKs' own sources, which means an SDK edit can make it
    // stale without anything in spec/ moving — hence a check rather than trust.
    //
    // This only means anything because importing reconcile.ts writes nothing:
    // its `main()` is behind an entry-point guard, so `render()` is a pure
    // read. Drop that guard and this assertion passes by rewriting its own
    // expectation.
    expect(
      readFileSync(RECONCILIATION_PATH, "utf8"),
      "spec/RECONCILIATION.md is stale — run: pnpm --filter @ag-ui/spec reconcile",
    ).toBe(renderReconciliation());
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
    for (const [path, declaration] of [
      [join(TS_OUTPUT_DIR, "version.ts"), "const PROTOCOL_VERSION ="],
      [join(PY_OUTPUT_DIR, "version.py"), "PROTOCOL_VERSION ="],
    ]) {
      const version = files.find((file) => file.path === path);
      expect(version, path).toBeDefined();
      expect(version?.content).toContain(
        `${declaration} ${JSON.stringify(model.version)}`,
      );
    }
  });

  it("marks every emitted file as generated", () => {
    for (const file of files) {
      // The published schema is the schema: the same bytes served at the
      // address its own $id names. JSON has no comment syntax to carry a
      // banner, and a banner would make the served file differ from the file
      // it is supposed to be. Its own gate is the byte comparison below.
      if (file.path === PUBLISHED_SCHEMA_PATH) continue;
      const comment =
        file.path.endsWith(".py") || file.path.endsWith(".txt") ? "#" : "//";
      // C# files lead with the <auto-generated /> marker Roslyn analyzers
      // recognise; the @generated banner is the line after it. MDX pages must
      // lead with their frontmatter, so the banner is an MDX comment directly
      // after it.
      const banner = file.path.endsWith(".cs")
        ? `// <auto-generated />\n${comment} @generated`
        : file.path.endsWith(".mdx")
          ? "---\n"
          : `${comment} @generated`;
      if (file.path.endsWith(".mdx")) {
        expect(
          file.content,
          `${file.path} has no @generated banner after its frontmatter`,
        ).toContain("{/* @generated");
      }
      expect(
        file.content.startsWith(banner),
        `${file.path} has no @generated banner`,
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

  it("keeps the generated Python as the only protocol source in ag_ui", () => {
    // The inverse gate since PNI-213 (mirroring the TypeScript one below):
    // the generated models are the internal source, the package must consume
    // them, and hand-written protocol declarations must not return. Scanned
    // by shape: a pydantic model declaring protocol semantics outside the
    // generated directory would subclass BaseModel or declare wire fields.
    const packageDir = join(PY_OUTPUT_DIR, "..", "core");
    const events = readFileSync(join(packageDir, "events.py"), "utf8");
    const types = readFileSync(join(packageDir, "types.py"), "utf8");
    const capabilities = readFileSync(join(packageDir, "capabilities.py"), "utf8");
    expect(events).toContain("from ag_ui._generated.models import");
    expect(types).toContain("from ag_ui._generated.models import");
    // capabilities.py became a re-export wrapper when AgentCapabilities moved
    // into the schema; a hand-written model returning there is the same
    // regression as one returning to events.py.
    expect(capabilities).toContain("from ag_ui._generated.models import");
    // No hand-written module may re-declare the protocol surface: an
    // EventType enum or a pydantic class outside generated/ is a duplicate.
    for (const [name, content] of [
      ["events.py", events],
      ["types.py", types],
      ["capabilities.py", capabilities],
    ] as const) {
      expect(
        /class\s+\w+\((BaseModel|ConfiguredBaseModel|MetadataMixin|BaseEvent|BaseMessage)\)/.test(
          content,
        ),
        `${name} re-declares protocol models that belong to the generated source`,
      ).toBe(false);
      expect(
        /class\s+EventType\b/.test(content),
        `${name} re-declares EventType`,
      ).toBe(false);
    }
  });

  it("keeps the generated TypeScript as the only protocol source in core", () => {
    // The inverse gate since PNI-212: the generated directory is the internal
    // source, the package entry must actually consume it, and the old
    // hand-written duplicate homes must not quietly return.
    const srcDir = join(TS_OUTPUT_DIR, "..");
    const index = readFileSync(join(srcDir, "index.ts"), "utf8");
    expect(index).toContain('"./generated/types"');
    // "the main entry must not reach the zod validators" is NOT asserted here.
    // A substring search for `"./generated/schemas"` in index.ts is satisfied
    // by `'./generated/schemas'`, by `./generated/schemas.js`, by a new
    // `./validators/` barrel and by any re-export one file deeper — every
    // shape that would actually break the optional peer. The real gate is
    // `sdks/typescript/packages/core/src/__tests__/main-entry-zod-free.test.ts`,
    // which bundles the entry with zod marked external and fails on a
    // surviving `zod` import, module graph and all, with a vacuity control
    // that proves the check can fail. Two greps that a rename defeats read as
    // a second opinion and are not one.
    const schemasEntry = readFileSync(join(srcDir, "schemas.ts"), "utf8");
    expect(schemasEntry).toContain('"./generated/schemas"');
    for (const retired of ["events.ts", "types.ts"]) {
      expect(
        existsSync(join(srcDir, retired)),
        `${retired} was retired by PNI-212; protocol semantics live in generated/`,
      ).toBe(false);
    }
    // No hand-written module may re-declare the protocol surface: looseObject
    // is the generated validators' signature shape, and an EventType enum
    // outside generated/ is a duplicate constant table.
    //
    // Recursive, because the scan used to read only the top level and `continue`
    // past every directory: a hand-written `src/validators/events.ts` — the
    // most natural place for exactly this regression to land — was never
    // opened. `generated/` is the one directory skipped, since it IS the
    // generated source, and `__tests__/` because a test may legitimately spell
    // a validator shape to assert against it.
    const SKIP = new Set(["generated", "__tests__"]);
    const handWritten = (dir: string, prefix: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? SKIP.has(entry.name)
            ? []
            : handWritten(join(dir, entry.name), `${prefix}${entry.name}/`)
          : entry.isFile() && entry.name.endsWith(".ts")
            ? [`${prefix}${entry.name}`]
            : [],
      );
    const scanned = handWritten(srcDir, "");
    // A scan that walked nothing would pass every assertion in the loop below.
    expect(scanned, "the hand-written scan found no files").not.toEqual([]);
    expect(scanned, "index.ts is not being scanned").toContain("index.ts");
    for (const name of scanned) {
      const content = readFileSync(join(srcDir, name), "utf8");
      expect(
        /z\.looseObject|enum EventType/.test(content),
        `${name} re-declares protocol semantics that belong to generated/`,
      ).toBe(false);
    }
  });

  it("mentions the generated directory nowhere in the package manifest", () => {
    // The scan above proves nothing reachable from the entries touches the
    // generated directories; this closes the other door — a package.json
    // entry (exports, files, main) pointing into generated/ directly.
    const manifest = readFileSync(
      join(TS_OUTPUT_DIR, "..", "..", "package.json"),
      "utf8",
    );
    expect(manifest).not.toContain("generated");
  });
});

/**
 * Every definition reaches every language, in the COMMITTED output.
 *
 * `accounts for every schema definition` above compares the IR to `$defs`: it
 * says the READER dropped nothing. Nothing said the EMITTERS dropped nothing —
 * a definition the TypeScript emitter skipped would leave `covered` complete,
 * the byte-for-byte gate green (the committed file matches what the generator
 * produces, which is the file with the hole in it), and the SDK simply
 * missing a type.
 *
 * Read from the committed files rather than from `files`, because the
 * committed files are what consumers get; the byte gate above is what keeps
 * the two the same.
 */
describe("every definition reaches the committed output", () => {
  // Mixins included: they are flattened INTO the definitions that compose
  // them, but both languages also emit them as types in their own right, and
  // an SDK consumer composing one is entitled to find it.
  const expected = [
    ...model.definitions.map((definition) => definition.name),
    ...model.mixins,
  ].sort();

  const tsTypes = readFileSync(join(TS_OUTPUT_DIR, "types.ts"), "utf8");
  const tsSchemas = readFileSync(join(TS_OUTPUT_DIR, "schemas.ts"), "utf8");
  const pyModels = readFileSync(join(PY_OUTPUT_DIR, "models.py"), "utf8");

  /** A vacuity control: the probe must find the name it is looking for. */
  const missing = (
    source: string,
    pattern: (name: string) => RegExp,
  ): string[] => expected.filter((name) => !pattern(name).test(source));

  it("as an exported TypeScript type", () => {
    expect(
      missing(
        tsTypes,
        (name) => new RegExp(`^export (type|enum|const) ${name}\\b`, "m"),
      ),
    ).toEqual([]);
  });

  it("as a generated zod validator", () => {
    expect(
      missing(tsSchemas, (name) => new RegExp(`^export const ${name}Schema\\b`, "m")),
    ).toEqual([]);
  });

  it("as a Python model", () => {
    // A class for an object, a union or a mixin; a module-level assignment for
    // an alias or a Literal enum. Either is the name a consumer imports.
    expect(
      missing(
        pyModels,
        (name) => new RegExp(`^(class ${name}\\b|${name}(: TypeAlias)? =)`, "m"),
      ),
    ).toEqual([]);
  });

  it("finds the names it looks for, so the three checks above can fail", () => {
    // Without this, a probe whose regex stopped matching anything would report
    // "nothing missing" for a corpus it never found.
    expect(expected.length).toBeGreaterThan(50);
    expect(
      missing(tsTypes, () => /^export (type|enum|const) ZZNoSuchDefinition\b/m),
    ).toEqual(expected);
  });

  /**
   * The two languages whose emitters reshape the names — .NET prefixes every
   * class with `AGUI`, protobuf dissolves the message union into one
   * `Message` and renames the content parts — cannot be checked by name from
   * here without reimplementing those mappings, and their emitters already
   * assert coverage while generating (`assertEveryDefinitionIsOnTheWire`,
   * `assertEveryDefinitionIsEmitted`), which runs on every `generateFiles()`
   * above.
   *
   * What those assertions do NOT check is their own exemption lists. An
   * exemption naming a definition that has since been renamed or deleted stays
   * in the file forever and silently applies to the next definition that
   * reuses the name — the same stale-pin hole `OPEN_DEFINITIONS` closes in
   * schema.test.ts. Read out of the generator source rather than imported,
   * because neither set is exported; a rename of the set itself fails here
   * rather than quietly matching nothing.
   */
  const exemptionSet = (file: string, constName: string): string[] => {
    const source = readFileSync(join(GENERATOR_DIR, file), "utf8");
    const start = source.indexOf(`const ${constName} = new Set([`);
    expect(start, `${file} no longer declares ${constName}`).toBeGreaterThan(-1);
    const end = source.indexOf("]);", start);
    expect(end, `${constName} is not a closed literal`).toBeGreaterThan(start);
    const body = source.slice(start, end);
    return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  };

  const definitionNames = new Set(
    model.definitions.map((definition) => definition.name),
  );

  it.each([
    ["protobuf.ts", "NOT_ON_THE_WIRE"],
    ["dotnet-models.ts", "NOT_IN_DOTNET"],
  ])("keeps no stale exemption in %s's %s", (file, constName) => {
    const names = exemptionSet(file, constName);
    expect(names.length, `${constName} parsed as empty`).toBeGreaterThan(0);
    expect(
      names.filter((name) => !definitionNames.has(name)),
      `${constName} exempts a definition that no longer exists — delete the entry, or a ` +
        "future definition reusing the name is exempted without anyone deciding so",
    ).toEqual([]);
  });
});

describe("the wire freeze machinery", () => {
  const committedFreeze = readFileSync(FREEZE_PATH, "utf8");

  it("turns an orphaned slot into a reserved number", () => {
    // A freeze entry whose schema field is gone must become a protobuf
    // reserved statement — in messages and in enums alike.
    const doctored =
      committedFreeze +
      "Interrupt.legacy_field = 9\n" +
      "JsonPatchOperationType.LEGACY = 6\n";
    const wire = buildWireModel(model, doctored);
    const byName = Object.fromEntries(
      emitProtoFiles(wire).map((file) => [file.name, file.content]),
    );
    expect(byName["types.proto"]).toContain("reserved 9;");
    expect(byName["patch.proto"]).toContain("reserved 6;");
  });

  it("refuses to reserve an orphaned zero enum value", () => {
    // proto3 requires the first enum value to be zero; retiring it is a wire
    // design decision, not something to generate blind.
    const doctored = committedFreeze
      .replace(
        "JsonPatchOperationType.ADD = 0",
        "JsonPatchOperationType.ADD_OLD = 0",
      )
      .replace("JsonPatchOperation.op = 1", "JsonPatchOperation.op = 1");
    const wire = buildWireModel(model, doctored);
    expect(() => emitProtoFiles(wire)).toThrow(/zero value was removed/);
  });
});

describe("the generated zod schemas against the fixture corpus", () => {
  // The fixtures are the behavioural contract, so the generated validators
  // must agree with them wherever the semantics are meant to coincide. The one
  // deliberate divergence is closure: the spec is strict and the generated zod
  // is loose (unknown keys survive for the strip-and-warn enforcement stage),
  // so a fixture rejected only by unevaluatedProperties is expected to parse.
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

  // The tolerant layer's whole promise is that unknown keys SURVIVE the parse
  // — the strip-and-warn enforcement stage needs to see them, and a
  // re-serialising intermediary must not lose them. A silent switch from
  // looseObject to a stripping z.object would pass every assertion above; this
  // is what fails.
  const objectAnchors = new Set(
    model.definitions
      .filter((definition) => definition.kind === "object")
      .map((definition) => definition.name),
  );
  const probeable = collect("valid").filter(([, anchor]) =>
    objectAnchors.has(anchor),
  );

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
