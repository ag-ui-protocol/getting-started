/**
 * Builds the three-way required-ness table that RECONCILIATION.md holds.
 *
 * The premise of this whole exercise is that the languages disagree about things
 * nobody ever decided. That claim is only worth making if it is checked, so this
 * reads the three SDKs' own sources and lines every field up against the schema.
 * Where they disagree, the schema had to pick one, and the table is where those
 * picks are visible in one place instead of buried in a diff.
 *
 * The parsing is deliberately simple and reports what it could not read rather
 * than guessing: the report says what the SDKs look like, it does not decide
 * whether they are right. What IS gated is its freshness —
 * `spec/harness/generator.test.ts` compares the committed RECONCILIATION.md
 * against `render()`, so this file and its output cannot drift apart.
 *
 *   pnpm --filter @ag-ui/spec reconcile
 */
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  effectiveProperties,
  effectiveRequired,
  schema,
} from "../harness/validator";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..");

/** The committed report. Exported so a test can compare it against `render()`. */
export const RECONCILIATION_PATH = join(REPO, "spec", "RECONCILIATION.md");

type Presence = "required" | "optional" | "absent";

interface Field {
  presence: Presence;
  nullable: boolean;
}

type Shape = Map<string, Field>;
/** Definition name -> its fields. */
type Model = Map<string, Shape>;

const snakeToCamel = (name: string): string =>
  name.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());

/** Resolves inheritance by folding a parent's fields under a child's. */
function flatten(raw: Map<string, { parent?: string; fields: Shape }>): Model {
  const resolved: Model = new Map();
  const resolve = (name: string, seen = new Set<string>()): Shape => {
    const cached = resolved.get(name);
    if (cached) return cached;
    const entry = raw.get(name);
    if (!entry || seen.has(name)) return new Map();
    seen.add(name);
    const shape: Shape = new Map();
    if (entry.parent) {
      for (const [field, value] of resolve(entry.parent, seen))
        shape.set(field, value);
    }
    for (const [field, value] of entry.fields) shape.set(field, value);
    resolved.set(name, shape);
    return shape;
  };
  for (const name of raw.keys()) resolve(name);
  return resolved;
}

// ------------------------------------------------------------------ TypeScript

function parseTypeScript(): Model {
  const raw = new Map<string, { parent?: string; fields: Shape }>();
  const read = (file: string): string =>
    readFileSync(join(REPO, "sdks/typescript/packages/core/src", file), "utf8");
  // Since PNI-212 the TypeScript SDK's protocol source IS the generated
  // schemas, so this column now verifies the generated output against the
  // schema rather than revealing hand-written divergence. Reading it anyway,
  // rather than declaring agreement by fiat: a generator bug would show here.
  const sources = ["generated/schemas.ts"].map((file) => ({
    file,
    text: read(file),
  }));

  // Aliases such as `export const StateSchema = z.any();`. A field declared as a
  // bare alias shows none of the modifiers that decide whether its key is
  // optional, so the alias has to be substituted before reading it — otherwise
  // `snapshot: StateSchema` looks mandatory when z.any() means the opposite.
  //
  const aliases = new Map<string, string>();
  for (const text of sources.map((source) => source.text)) {
    // `[^;{]` stops at an object literal, so `z.object({...})` definitions are
    // not mistaken for aliases while multi-line chains like
    // `MetadataSchema.nullable().optional().transform(...)` still resolve.
    for (const [, name, expression] of text.matchAll(
      /export const (\w+Schema) = ([^;{]+);/g,
    )) {
      aliases.set(name, expression.replace(/\s+/g, " ").trim());
    }
  }
  const resolveAlias = (declaration: string): string => {
    const trimmed = declaration.trim();
    const head = /^(\w+Schema)\b/.exec(trimmed);
    const expansion = head && aliases.get(head[1]);
    return expansion ? trimmed.replace(head[1], expansion) : trimmed;
  };

  for (const { text: source } of sources) {
    // export const XSchema = z.looseObject({...}) — the generated schemas
    // flatten their mixins, so there is no .extend chain to resolve.
    const blocks = source.matchAll(
      /export const (\w+)Schema = (?:(\w+)Schema\s*\.extend|z\s*\.looseObject)\(\{([\s\S]*?)\n\s*\}\)/g,
    );
    for (const [, name, parent, body] of blocks) {
      const fields: Shape = new Map();
      // A field runs from its name to the next top-level field name, so chained
      // modifiers such as .nullable().optional() stay with the field they modify.
      const entries = body.split(/\n\s{2,}(?=[a-zA-Z_]\w*:)/);
      for (const entry of entries) {
        const match = /^\s*([a-zA-Z_]\w*):\s*([\s\S]*)$/.exec(entry);
        if (!match) continue;
        const [, field, rawDeclaration] = match;
        const declaration = resolveAlias(rawDeclaration);
        const optional =
          declaration.includes(".optional()") ||
          declaration.includes(".default(") ||
          // z.any() accepts undefined, so its key is optional whether or not
          // anyone wrote .optional() — unless the generated required-any
          // guard follows: .refine((value) => value !== undefined) is exactly
          // how the generator says "the key must be present".
          (/^z\.any\(\)/.test(declaration.trim()) &&
            !declaration.includes("value !== undefined"));
        fields.set(field, {
          presence: optional ? "optional" : "required",
          nullable: declaration.includes(".nullable()"),
        });
      }
      raw.set(name, { parent, fields });
    }
  }
  return flatten(raw);
}

// ---------------------------------------------------------------------- Python

function parsePython(): Model {
  const raw = new Map<string, { parent?: string; fields: Shape }>();
  // Since PNI-213 the Python SDK's protocol source IS the generated models,
  // so this column now verifies the generated output against the schema
  // rather than revealing hand-written divergence — same as TypeScript.
  for (const file of ["../_generated/models.py"]) {
    const source = readFileSync(
      join(REPO, "sdks/python/ag_ui/core", file),
      "utf8",
    );
    const classes = source.split(/\nclass /).slice(1);
    for (const block of classes) {
      const header = /^(\w+)\(([^)]*)\)/.exec(block);
      if (!header) continue;
      const [, name, bases] = header;
      const parent = bases
        .split(",")
        .map((base) => base.trim())
        .find((base) => /^[A-Z]\w*$/.test(base) && base !== "BaseModel");
      const fields: Shape = new Map();
      for (const line of block.split("\n")) {
        const match =
          /^ {4}([a-z_][a-z0-9_]*)\s*:\s*([^=]+?)(\s*=\s*(.+))?$/.exec(line);
        if (!match) continue;
        const [, field, annotation, , fallback] = match;
        if (field === "model_config") continue;
        // Pydantic spells a fixed discriminator as `Literal[X] = X`, which is a
        // default rather than a requirement — but the key is always serialised,
        // so reporting it as optional would bury the real disagreements under 30
        // rows of noise.
        const isDiscriminator =
          /^\s*Literal\[/.test(annotation) && fallback !== undefined;
        // `= Field(...)` without a default= is constraint wiring (min_length,
        // aliases), not a default: the field stays mandatory.
        const isBareFieldCall =
          fallback !== undefined &&
          /^Field\(/.test(fallback.trim()) &&
          !/\bdefault(_factory)?\s*=/.test(fallback);
        fields.set(snakeToCamel(field), {
          // Pydantic v2 dropped v1's implicit None default, so an annotation with
          // no default is mandatory — including a bare `Any`.
          presence:
            fallback === undefined || isDiscriminator || isBareFieldCall
              ? "required"
              : "optional",
          nullable:
            annotation.includes("Optional[") || annotation.includes("| None"),
        });
      }
      raw.set(name, { parent, fields });
    }
  }
  return flatten(raw);
}

// ------------------------------------------------------------------------ .NET

function parseDotnet(): Model {
  const raw = new Map<string, { parent?: string; fields: Shape }>();
  const root = join(REPO, "sdks/dotnet/src/AGUI.Abstractions");

  // Sorted: readdirSync's order is whatever the filesystem hands back, and the
  // walk order decides which declaration of a duplicated name wins, so an
  // unsorted walk can render two different reports from the same sources.
  const walk = (dir: string): string[] =>
    readdirSync(dir)
      .sort()
      .flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory()
          ? walk(path)
          : path.endsWith(".cs")
            ? [path]
            : [];
      });

  for (const path of walk(root)) {
    const source = readFileSync(path, "utf8");
    const classes = source.matchAll(
      /(?:class|record)\s+(\w+)(?:\s*:\s*([\w<>, ]+))?\s*\{([\s\S]*?)\n\}/g,
    );
    for (const [, name, bases, body] of classes) {
      const parent = bases
        ?.split(",")
        .map((base) => base.trim())
        .find((base) => /^[A-Z]\w*$/.test(base) && !base.startsWith("I"));
      const fields: Shape = new Map();
      // Split on the attribute rather than matching across a gap. A single regex
      // with a lazy gap between the attribute and `public … {` runs straight past
      // an expression-bodied member — `public override string Type => …;` has no
      // brace — and swallows the next property's attribute with it, so `type`
      // took MessageId's declaration and `messageId` vanished from the report.
      // Splitting means the first declaration after an attribute is always the
      // member that attribute belongs to.
      for (const chunk of body.split(/\[JsonPropertyName\("/).slice(1)) {
        const quote = chunk.indexOf('"');
        if (quote === -1) continue;
        const wireName = chunk.slice(0, quote);
        const declaration =
          // The terminator says what kind of member it is: `{` an auto-property,
          // `=>` an expression-bodied one, `;` a field.
          /public\s+(?:(required)\s+)?(?:(?:override|virtual|new|static|readonly)\s+)*([\w<>?.[\]]+)\s+(\w+)\s*(\{|=>|;)/.exec(
            chunk.slice(quote),
          );
        if (!declaration) continue;
        const [, isRequired, csType, , terminator] = declaration;
        // An expression-bodied member is a computed getter — the fixed
        // discriminators are all written that way — so it is always serialised.
        // Calling it optional is the same false claim as reading Pydantic's
        // `Literal[X] = X` as optional, and it reported .NET `type` as optional
        // on every event.
        const alwaysSerialised = terminator === "=>";
        fields.set(wireName, {
          // Otherwise: System.Text.Json has no notion of a required member unless
          // the C# `required` modifier is used, which these types do not use — so
          // a field is reported optional rather than inferred from nullability.
          presence: isRequired || alwaysSerialised ? "required" : "optional",
          nullable: !alwaysSerialised && csType.endsWith("?"),
        });
      }
      // The same discriminator, in the classes that declare it without a
      // JsonPropertyName attribute at all.
      for (const [wireName, csName] of [
        ["type", "Type"],
        ["role", "Role"],
      ]) {
        if (fields.has(wireName)) continue;
        if (
          new RegExp(`public\\s+override\\s+string\\s+${csName}\\s*=>`).test(
            body,
          )
        ) {
          fields.set(wireName, { presence: "required", nullable: false });
        }
      }
      if (fields.size > 0 || parent) raw.set(name, { parent, fields });
    }
  }
  return flatten(raw);
}

// ---------------------------------------------------------------------- report

/**
 * Where an SDK's name for a definition cannot be derived.
 *
 * .NET prefixes its non-event types with `AGUI`, which is handled by rule below
 * rather than listed here — an earlier hand-written table silently omitted the
 * input-content classes, so the report claimed .NET had no `InputContentDataSource`
 * fields at all. Only genuinely different names belong here.
 */
const SDK_NAMES: Record<string, { ts?: string; py?: string; net?: string }> = {
  FunctionCall: { net: "AGUIToolCallFunction" },
  ResumeEntry: { net: "AGUIResume" },
  BaseMessage: { net: "AGUIMessage" },
};

/** The .NET name for a definition: an explicit mapping, then the AGUI prefix. */
function dotnetName(definition: string, model: Model): string {
  const mapped = SDK_NAMES[definition]?.net;
  if (mapped) return mapped;
  if (model.has(definition)) return definition;
  return `AGUI${definition}`;
}

const cell = (field: Field | undefined): string => {
  if (!field) return "—";
  return field.nullable ? `${field.presence}, nullable` : field.presence;
};

/**
 * Renders a Markdown table with padded columns.
 *
 * Padded because that is what Prettier does to a Markdown table, and this file is
 * committed: an unpadded table would be reformatted on the next `pnpm format`,
 * making a generated artifact dirty the worktree every time either one runs.
 */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell_, column) =>
    Math.max(cell_.length, ...rows.map((row) => row[column].length)),
  );
  const renderRow = (row: string[]): string =>
    `| ${row.map((value, column) => value.padEnd(widths[column])).join(" | ")} |`;
  return [
    renderRow(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.map(renderRow),
  ];
}

interface Report {
  text: string;
  compared: number;
  disagreements: number;
  unread: number;
}

function build(): Report {
  const ts = parseTypeScript();
  const py = parsePython();
  const net = parseDotnet();

  const defs = schema.$defs as Record<string, Record<string, unknown>>;
  const definitions = Object.entries(defs)
    .filter(([, def]) => def.properties !== undefined)
    .map(([name]) => name)
    .filter(
      (name) =>
        // Mixins have no wire shape of their own.
        name !== "Attributable" &&
        name !== "BaseEvent" &&
        name !== "BaseMessage" &&
        // The RFC 6902 operations are an external standard the SDKs consume
        // through JSON Patch libraries rather than declare as types, so there
        // is nothing to reconcile them against.
        name !== "AddOperation" &&
        name !== "RemoveOperation" &&
        name !== "ReplaceOperation" &&
        name !== "MoveOperation" &&
        name !== "CopyOperation" &&
        name !== "TestOperation",
    );

  const lines: string[] = [];
  const disagreements: string[][] = [];
  const unread: string[] = [];

  lines.push("# Required-ness across the SDKs and the schema");
  lines.push("");
  lines.push(
    "Generated by `pnpm --filter @ag-ui/spec reconcile`. One row per field, showing what",
    "each SDK asks for today and what the schema settled on. Regenerate it rather than",
    "editing it.",
  );
  lines.push("");
  lines.push(
    "`—` means this tool found no declaration of the field in that SDK, which is not",
    "always the same as the SDK not having it: .NET's `AGUIUserMessage.content` is",
    "`[JsonIgnore]` with a converter owning its wire shape, so it shows as `—` while",
    "being very much present.",
    "",
    "A .NET field reads _optional_ unless it is a computed discriminator. System.Text.Json",
    "has no required member unless the C# `required` modifier is used and these types do not",
    "use it, so for an ordinary property requiredness genuinely is not expressed there rather",
    "than being unread. A fixed discriminator is different: it is written",
    "`public override string Type => …`, a computed getter that is always serialised, so",
    "calling it optional would be the same false claim as reading Pydantic's `Literal[X] = X`",
    "as optional.",
  );
  lines.push("");

  for (const definition of definitions) {
    const names = SDK_NAMES[definition] ?? {};
    const tsShape = ts.get(names.ts ?? definition);
    const pyShape = py.get(names.py ?? definition);
    const netShape = net.get(dotnetName(definition, net));

    if (!tsShape && !pyShape && !netShape) {
      unread.push(definition);
      continue;
    }

    const required = new Set(effectiveRequired(definition));
    lines.push(`## ${definition}`);
    lines.push("");

    const rows: string[][] = [];
    for (const field of effectiveProperties(definition)) {
      const schemaCell = required.has(field) ? "required" : "optional";
      rows.push([
        field,
        cell(tsShape?.get(field)),
        cell(pyShape?.get(field)),
        cell(netShape?.get(field)),
        schemaCell,
      ]);

      // A disagreement worth reading is one where the two SDKs that do express
      // requiredness differ from each other, or where the schema differs from
      // either of them.
      const tsPresence = tsShape?.get(field)?.presence;
      const pyPresence = pyShape?.get(field)?.presence;
      const expressed = [tsPresence, pyPresence].filter(Boolean) as Presence[];
      const differ = new Set([...expressed, schemaCell]).size > 1;
      if (differ && expressed.length > 0) {
        disagreements.push([
          `${definition}.${field}`,
          tsPresence ?? "—",
          pyPresence ?? "—",
          schemaCell,
        ]);
      }
    }
    lines.push(
      ...table(["field", "TypeScript", "Python", ".NET", "schema"], rows),
    );
    lines.push("");
  }

  const header: string[] = [];
  header.push("# Reconciliation");
  header.push("");
  header.push(
    `${disagreements.length} field${disagreements.length === 1 ? "" : "s"} where TypeScript and`,
    "Python disagree with the schema about required-ness. Each one is a decision the schema",
    "had to make, not a transcription.",
    "",
    "Read the count for exactly what it covers. Only required-ness is compared: nullability",
    "is reported in each column but never enters the comparison, and the .NET column is",
    "informational — it is printed, not checked against anything. The TypeScript column is",
    "read off the zod validator rather than the generated type, so a field the schema gives",
    "a default reads `optional` here even where the generated TypeScript type requires it —",
    "`tools` and `context` on RunAgentInput are the two.",
  );
  header.push("");
  header.push(
    ...table(["field", "TypeScript", "Python", "schema"], disagreements),
  );
  header.push("");
  if (unread.length > 0) {
    header.push(
      `Not found in any SDK source, so not compared: ${unread.join(", ")}. A definition`,
      "reaching this list exists in the schema and in none of the SDKs, which is a gap to",
      "close rather than a fact to record.",
    );
    header.push("");
  }

  // Trailing blank lines are trimmed so the generated file is already
  // Prettier-clean and a `pnpm format` after a `reconcile` is a no-op.
  const body = [...header, ...lines];
  while (body.at(-1) === "") body.pop();
  return {
    text: body.join("\n") + "\n",
    compared: definitions.length - unread.length,
    disagreements: disagreements.length,
    unread: unread.length,
  };
}

/**
 * The report this tool would write, as a string.
 *
 * Exported so `spec/harness/generator.test.ts` can compare it against the
 * committed RECONCILIATION.md. That comparison is only worth anything if
 * importing this module has no side effect — hence the entry-point guard on
 * `main()` below. Without it the import would rewrite the file first and the
 * test would always pass.
 */
export function render(): string {
  return build().text;
}

function main(): void {
  const report = build();
  writeFileSync(RECONCILIATION_PATH, report.text);
  console.log(
    `Wrote spec/RECONCILIATION.md: ${report.compared} definitions compared, ` +
      `${report.disagreements} disagreements, ${report.unread} not in any SDK yet.`,
  );
}

// Only when run as the script, never on import: see `render()` above.
// realpath both sides before comparing. Node hands `import.meta.url` back
// already resolved through symlinks, but `process.argv[1]` is whatever path the
// launcher passed, so under a symlinked repo root (macOS /tmp → /private/tmp,
// some CI caches) the two would differ and this entry point would silently
// no-op — exiting 0 having written nothing, which then reads as a stale
// RECONCILIATION.md. The realpath is guarded so a missing argv path can't throw.
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
if (
  process.argv[1] &&
  realpathOrSelf(fileURLToPath(import.meta.url)) === realpathOrSelf(resolve(process.argv[1]))
) {
  main();
}
