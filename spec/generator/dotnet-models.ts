/**
 * The C# model emitter: protocol model in, the AGUI.Abstractions types out.
 *
 * Emits the public .NET protocol types — events, messages, content parts and
 * the run/interrupt types — in the SDK's established idiom: mutable sealed
 * classes with System.Text.Json attributes, camelCase wire names behind
 * PascalCase properties, computed discriminators referencing the const
 * classes, JsonElement for arbitrary JSON, and context-wide omission for
 * optionals. C# has no export-aliasing, so unlike TypeScript and Python the
 * emitter owns the historic name map (Message -> AGUIMessage, ResumeEntry ->
 * AGUIResume, ...) and the generated types carry the public names directly.
 *
 * Representation shims stay hand-written and are referenced, not emitted:
 * the JSON converters, AGUIUserContent (the string|parts union struct), the
 * serializer context, and non-protocol helpers.
 */

import type {
  Definition,
  Field,
  ObjectDefinition,
  ProtocolModel,
  TypeExpr,
} from "./ir";
import {
  NULLABLE_REQUIRED_ANY,
  NULLABLE_REQUIRED_STRINGS,
  PROP_NAME,
} from "./dotnet-idioms";
import { assertTableKeys } from "./tables";

/* ------------------------------------------------------------------ */
/* .NET idiom tables                                                    */
/* ------------------------------------------------------------------ */

/** Definition -> public C# type name, where they differ. */
const TYPE_NAME: Record<string, string> = {
  Message: "AGUIMessage",
  DeveloperMessage: "AGUIDeveloperMessage",
  SystemMessage: "AGUISystemMessage",
  AssistantMessage: "AGUIAssistantMessage",
  UserMessage: "AGUIUserMessage",
  ToolMessage: "AGUIToolMessage",
  ActivityMessage: "AGUIActivityMessage",
  ReasoningMessage: "AGUIReasoningMessage",
  Tool: "AGUITool",
  Context: "AGUIContext",
  Interrupt: "AGUIInterrupt",
  ResumeEntry: "AGUIResume",
  ToolCall: "AGUIToolCall",
  FunctionCall: "AGUIToolCallFunction",
  InputContent: "AGUIInputContent",
  TextInputContent: "AGUITextInputContent",
  ImageInputContent: "AGUIImageInputContent",
  AudioInputContent: "AGUIAudioInputContent",
  VideoInputContent: "AGUIVideoInputContent",
  DocumentInputContent: "AGUIDocumentInputContent",
  InputContentSource: "AGUIInputContentSource",
  InputContentDataSource: "AGUIInputContentDataSource",
  InputContentUrlSource: "AGUIInputContentUrlSource",
};

// PROP_NAME, NULLABLE_REQUIRED_STRINGS and NULLABLE_REQUIRED_ANY live in
// dotnet-idioms.ts: this emitter declares those properties and the protobuf
// mapper carries them, so the two have to read one table rather than two
// copies that can drift apart.

/** Non-discriminator const/enum strings with an idiomatic default. */
const STRING_DEFAULT: Record<string, string> = {
  "ResumeEntry.status": "ResumeStatus.Resolved",
};

/**
 * Fields whose representation is a hand-written shim; emitted verbatim.
 * AGUIUserContent owns the string|parts wire union, and its JSON is written
 * by AGUIMessageJsonConverter rather than by an attribute.
 */
const BESPOKE_PROPERTY: Record<string, string[]> = {
  "UserMessage.content": [
    "    // Wire format (string | InputContent[]) is owned by AGUIMessageJsonConverter.",
    "    [JsonIgnore]",
    "    public AGUIUserContent Content { get; set; }",
  ],
};

/** Base classes every union member inherits, and the abstract base emission. */
const UNION_BASES: Record<
  string,
  { discriminator: string; constClass: string }
> = {
  Message: { discriminator: "role", constClass: "AGUIRoles" },
  InputContent: { discriminator: "type", constClass: "AGUIInputContentTypes" },
  InputContentSource: {
    discriminator: "type",
    constClass: "AGUIInputContentSourceTypes",
  },
  RunFinishedOutcome: {
    discriminator: "type",
    constClass: "RunFinishedOutcomeTypes",
  },
  SubagentFinishedOutcome: {
    discriminator: "type",
    constClass: "SubagentFinishedOutcomeTypes",
  },
};

/**
 * The unions this emitter does not model as a C# base class: Event has its own
 * hand-rolled hierarchy above, and JsonPatch rides as opaque JSON. Any other
 * union must have a UNION_BASES entry, or the emitted C# would name a class
 * nothing declares — see assertUnionsAreModelled.
 */
const UNMODELLED_UNIONS = new Set(["Event", "JsonPatchOperation"]);

/**
 * Definitions a field names but this emitter deliberately carries as opaque
 * JSON rather than as a C# type of their own. A reference to one is not a
 * dangling reference.
 */
const OPAQUE_REFS = new Set(["JsonPatch"]);

/**
 * Whether a type is one of the opaque references, or an alias that leads to
 * one. Both the property emitter and the reference-closure check ask this, so
 * neither can start seeing through an alias the other stops at.
 */
function namesAnOpaqueRef(
  defs: Map<string, Definition>,
  type: TypeExpr,
): boolean {
  if (type.kind !== "ref") return false;
  if (OPAQUE_REFS.has(type.name)) return true;
  const target = defs.get(type.name);
  return target?.kind === "alias" ? namesAnOpaqueRef(defs, target.type) : false;
}

/**
 * A union the schema gains without an entry above would otherwise emit a
 * reference to a class this emitter never writes, and the drift gate — which
 * only compares the generator against its own committed output — would accept
 * it. Fail at generation time instead, where the message can say what to add.
 */
function assertUnionsAreModelled(defs: Map<string, Definition>): void {
  const unmodelled = [...defs.values()]
    .filter(
      (definition) =>
        definition.kind === "union" &&
        !UNMODELLED_UNIONS.has(definition.name) &&
        UNION_BASES[definition.name] === undefined,
    )
    .map((definition) => definition.name);
  if (unmodelled.length > 0) {
    throw new Error(
      `no .NET union base for ${unmodelled.join(", ")} — add an entry to UNION_BASES ` +
        "(discriminator plus the const class its members' values live in), and emit that " +
        "const class alongside the others",
    );
  }
}

/**
 * The SDK's extra base between AGUIInputContent and the four media parts,
 * carrying the shared source/metadata pair. An idiom, not a schema shape.
 */
const MEDIA_PARTS = new Set([
  "ImageInputContent",
  "AudioInputContent",
  "VideoInputContent",
  "DocumentInputContent",
]);

/**
 * The fields AGUIMessage hoists out of the roles. Unlike BaseEvent, whose own
 * fields come from a mixin the schema declares (and are read from it), this
 * base is an SDK idiom: the schema's Message is a bare union.
 * assertMessageBaseFields keeps the set honest.
 */
const MESSAGE_BASE_FIELDS = new Set(["id", "metadata", "subagentRunId"]);

/**
 * A class this emitter writes may name another by reference, and a definition
 * nobody emits leaves that reference dangling: generation still succeeds, the
 * drift gate — which compares the generator only against its own output — still
 * passes, and the C# does not compile. Walk the emitted definitions' references
 * and insist every object among them is emitted too.
 */
function assertEveryReferencedObjectIsEmitted(
  defs: Map<string, Definition>,
  emitted: string[],
  emittedUnions: string[],
  extraShapes: ObjectDefinition[],
): void {
  const written = new Set(emitted);
  const writtenUnions = new Set(emittedUnions);
  const missing = new Set<string>();
  const visit = (type: TypeExpr, from: string): void => {
    if (type.kind === "array") return visit(type.items, from);
    if (type.kind !== "ref") return;
    if (namesAnOpaqueRef(defs, type)) return;
    const target = defs.get(type.name);
    if (target === undefined) return;
    if (target.kind === "alias") return visit(target.type, from);
    if (target.kind === "union") {
      // A union is emitted as its base plus its members, and only the union
      // families this emitter actually writes count: Event has its own
      // hierarchy above, and JsonPatch rides as opaque JSON, so a field
      // pointing at either names a class nothing declares.
      if (!writtenUnions.has(type.name)) {
        missing.add(`${from} -> ${type.name}`);
      }
      return;
    }
    // Enums ride as plain strings and have no class.
    if (target.kind !== "object") return;
    if (!written.has(type.name)) missing.add(`${from} -> ${type.name}`);
  };
  const shapes = [
    ...emitted
      .map((name) => defs.get(name))
      .filter(
        (definition): definition is ObjectDefinition =>
          definition?.kind === "object",
      ),
    // The bases this emitter writes itself, whose fields reference the schema
    // just as a member's do.
    ...extraShapes,
  ];
  for (const definition of shapes) {
    for (const field of definition.fields) visit(field.type, definition.name);
  }
  if (missing.size > 0) {
    throw new Error(
      `the .NET models reference objects this emitter does not write: ${[...missing].join(", ")} — ` +
        "add them to the plain types (or to whichever union family they belong to)",
    );
  }
}

/**
 * What a field's type is, for comparing two declarations of the same field: the
 * alias-resolved kind, or the definition a reference lands on, so narrowing an
 * inherited field to a different type does not pass for unchanged.
 */
function typeSignature(defs: Map<string, Definition>, type: TypeExpr): string {
  const resolved = resolveAlias(defs, type);
  if (resolved.kind === "array") {
    return `${typeSignature(defs, resolved.items)}[]`;
  }
  return resolved.kind === "ref" ? resolved.name : resolved.kind;
}

/**
 * Every event class inherits BaseEvent and skips the fields the base declares.
 * An event that composes something else, or that says something different about
 * an inherited field, would be emitted with the base's shape rather than its
 * own — in C# that still compiles.
 */
function assertEventsComposeBaseEvent(
  defs: Map<string, Definition>,
  baseEventShape: ObjectDefinition,
  events: ObjectDefinition[],
): void {
  for (const event of events) {
    if (!event.composedMixins.includes("BaseEvent")) {
      throw new Error(
        `${event.name} does not compose BaseEvent, which every emitted event class inherits`,
      );
    }
    for (const base of baseEventShape.fields) {
      // Each event narrows type to its own literal; that is the point of it.
      if (base.name === "type") continue;
      const own = event.fields.find((field) => field.name === base.name);
      if (own === undefined) {
        throw new Error(
          `${event.name} does not declare ${base.name}, which BaseEvent carries for it`,
        );
      }
      if (
        own.required !== base.required ||
        typeSignature(defs, own.type) !== typeSignature(defs, base.type)
      ) {
        throw new Error(
          `${event.name}.${base.name} is not the shape BaseEvent declares, so inheriting ` +
            "the base property would say something the schema does not",
        );
      }
    }
  }
}

/**
 * AGUIMediaInputContent hoists source and metadata out of the four media parts.
 * A member that declares either differently — a required metadata, a source
 * pointing somewhere else — would be flattened into a base that no longer
 * describes it, in C# that still compiles.
 */
function assertMediaPartsShareTheirBase(members: ObjectDefinition[]): void {
  for (const member of members) {
    const source = member.fields.find((field) => field.name === "source");
    if (
      source?.required !== true ||
      source.type.kind !== "ref" ||
      source.type.name !== "InputContentSource"
    ) {
      throw new Error(
        `${member.name}.source is not the required InputContentSource ref that ` +
          "AGUIMediaInputContent hoists — update the base or stop hoisting it",
      );
    }
    const metadata = member.fields.find((field) => field.name === "metadata");
    if (
      metadata === undefined ||
      metadata.required ||
      metadata.type.kind !== "any"
    ) {
      throw new Error(
        `${member.name}.metadata is not the optional any-JSON field that ` +
          "AGUIMediaInputContent hoists — update the base or stop hoisting it",
      );
    }
  }
}

/**
 * A field this base claims but some role does not declare would be hoisted out
 * of nothing, and the role would lose it. Fail at generation time rather than
 * emitting that.
 */
function assertMessageBaseFields(
  defs: Map<string, Definition>,
  members: ObjectDefinition[],
): void {
  // What the hand-written properties on AGUIMessage say, so a role that starts
  // saying something else about a hoisted field cannot be flattened into them.
  const expected: Record<string, { required: boolean; kind: string }> = {
    id: { required: true, kind: "string" },
    metadata: { required: false, kind: "openMap" },
    subagentRunId: { required: false, kind: "string" },
  };
  for (const name of MESSAGE_BASE_FIELDS) {
    const shape = expected[name];
    if (shape === undefined) {
      throw new Error(`AGUIMessage hoists ${name} with no expected shape`);
    }
    for (const member of members) {
      const field = member.fields.find((candidate) => candidate.name === name);
      if (field === undefined) {
        throw new Error(
          `AGUIMessage hoists ${name}, which ${member.name} does not declare — ` +
            "remove it from MESSAGE_BASE_FIELDS or give the base a shape every role shares",
        );
      }
      const kind = resolveAlias(defs, field.type).kind;
      if (field.required !== shape.required || kind !== shape.kind) {
        throw new Error(
          `${member.name}.${name} is ${field.required ? "required" : "optional"} ${kind}, ` +
            `which the ${shape.required ? "required" : "optional"} ${shape.kind} property on ` +
            "AGUIMessage does not express",
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * A C# member name for a schema vocabulary value. The values are lower-case
 * words the schema separates however it likes (TEXT_MESSAGE_START, tool-call),
 * and a separator carried into the identifier would not compile, so each
 * segment is capitalised and joined.
 */
function csMember(value: string): string {
  const member = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => pascal(segment))
    .join("");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) {
    throw new Error(
      `the schema value "${value}" has no C# member name — name it explicitly ` +
        "rather than deriving one",
    );
  }
  return member;
}

function csName(definition: string): string {
  return TYPE_NAME[definition] ?? definition;
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Wraps a schema description as an XML doc comment. */
function doc(description: string, indent: string): string[] {
  if (description === "") return [];
  const words = xmlEscape(description).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && line.length + word.length + 1 > 76 - indent.length) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return [
    `${indent}/// <summary>`,
    ...lines.map((entry) => `${indent}/// ${entry}`),
    `${indent}/// </summary>`,
  ];
}

function banner(schemaId: string): string {
  return [
    "// <auto-generated />",
    "// @generated by spec/generator — DO NOT EDIT.",
    `// Source: ${schemaId}`,
    "// Regenerate: pnpm --filter @ag-ui/spec generate",
    "#nullable enable",
  ].join("\n");
}

function resolveAlias(defs: Map<string, Definition>, type: TypeExpr): TypeExpr {
  while (type.kind === "ref") {
    const target = defs.get(type.name);
    if (target?.kind !== "alias") return type;
    type = target.type;
  }
  return type;
}

/* ------------------------------------------------------------------ */
/* Property emission                                                    */
/* ------------------------------------------------------------------ */

interface EmitContext {
  defs: Map<string, Definition>;
  /** Union member -> the union it belongs to (for discriminators). */
  memberOf: Map<string, string>;
}

function csProperty(
  context: EmitContext,
  definition: ObjectDefinition,
  field: Field,
): string[] {
  const key = `${definition.name}.${field.name}`;
  const bespoke = BESPOKE_PROPERTY[key];
  if (bespoke) return bespoke;

  const propName = PROP_NAME[key] ?? pascal(field.name);
  const lines = doc(field.description, "    ");
  const attr = (name: string) => lines.push(`    ${name}`);
  attr(`[JsonPropertyName("${field.name}")]`);

  // Patches ride as raw JSON in this SDK; the protobuf mappers own the
  // structured form. Aliases are followed but not seen through: resolving the
  // JsonPatch alias would reach its array shape and emit a list of a class
  // this emitter never writes.
  if (namesAnOpaqueRef(context.defs, field.type)) {
    if (field.required) {
      lines.push(`    public JsonElement ${propName} { get; set; }`);
    } else {
      lines.push(`    public JsonElement? ${propName} { get; set; }`);
    }
    return lines;
  }

  const resolved = resolveAlias(context.defs, field.type);
  const union = context.memberOf.get(definition.name);

  // Discriminators are computed overrides referencing the const classes.
  if (union !== undefined && resolved.kind === "literal") {
    const base = UNION_BASES[union];
    if (base !== undefined && field.name === base.discriminator) {
      // The same derivation the const class declares its members with, so the
      // two cannot name the value differently.
      lines.push(
        `    public override string ${pascal(field.name)} => ${base.constClass}.${csMember(resolved.value)};`,
      );
      return lines;
    }
  }
  if (
    field.name === "type" &&
    resolved.kind === "literal" &&
    context.memberOf.get(definition.name) === "Event"
  ) {
    lines.push(
      `    public override string Type => AGUIEventTypes.${csMember(resolved.value)};`,
    );
    return lines;
  }

  // No per-property [JsonIgnore(WhenWritingNull)]: the omission rule lives once,
  // on the serializer context's DefaultIgnoreCondition, and a per-property
  // spelling would make a green omission sweep stop proving that setting works.
  const prop = (type: string, init = "") =>
    lines.push(`    public ${type} ${propName} { get; set; }${init}`);

  switch (resolved.kind) {
    case "string":
    case "literal":
    case "stringEnum": {
      const value =
        resolved.kind === "literal" ? `"${resolved.value}"` : undefined;
      const defaulted =
        STRING_DEFAULT[key] ?? (field.required ? value : undefined);
      if (field.required && !NULLABLE_REQUIRED_STRINGS.has(key)) {
        prop("string", ` = ${defaulted ?? "string.Empty"};`);
      } else {
        prop("string?");
      }
      return lines;
    }
    case "integer":
      if (field.required) {
        prop("long");
        return lines;
      }
      prop("long?");
      return lines;
    case "boolean":
      if (field.required) {
        prop("bool");
        return lines;
      }
      prop("bool?");
      return lines;
    case "any":
      if (field.required) {
        if (!NULLABLE_REQUIRED_ANY.has(key)) {
          prop("JsonElement");
          return lines;
        }

        // Required, and null is one of its legal values. The property is
        // nullable so the model can hold that null, and it opts out of the
        // serializer context's write-nothing-for-null default: omitting it
        // would produce an event missing a field the schema requires, which
        // the other SDKs' validators reject.
        attr("[JsonIgnore(Condition = JsonIgnoreCondition.Never)]");
        prop("JsonElement?");
        return lines;
      }
      prop("JsonElement?");
      return lines;
    case "openMap":
      if (field.required) {
        prop("JsonElement");
        return lines;
      }
      prop("JsonElement?");
      return lines;
    case "array": {
      const items = resolveAlias(context.defs, resolved.items);
      const element = arrayElementType(context, key, items);
      if (field.required) {
        prop(`IList<${element}>`, " = [];");
      } else {
        prop(`IList<${element}>?`);
      }
      return lines;
    }
    case "ref": {
      const target = context.defs.get(resolved.name);
      if (target?.kind === "enum") {
        // Enums ride as plain strings in this SDK.
        if (field.required) {
          prop("string", ` = ${STRING_DEFAULT[key] ?? "string.Empty"};`);
        } else {
          prop("string?");
        }
        return lines;
      }
      if (field.required) {
        // A required object ref is a value the sender must have supplied, so the
        // property is non-nullable. Union bases are abstract and cannot be
        // constructed, so they lean on the deserializer to fill the slot.
        const isUnionBase = target?.kind === "union";
        prop(csName(resolved.name), isUnionBase ? " = null!;" : " = new();");
        return lines;
      }
      prop(`${csName(resolved.name)}?`);
      return lines;
    }
    default:
      throw new Error(`no .NET model mapping for ${key} (${resolved.kind})`);
  }
}

/**
 * The C# element type for an array field. Only the element kinds the protocol
 * uses today are mapped: anything else would otherwise land as JsonElement,
 * which compiles while quietly exposing the wrong shape, or name an enum class
 * this emitter does not write (enums ride as plain strings here).
 */
function arrayElementType(
  context: EmitContext,
  key: string,
  items: TypeExpr,
): string {
  if (items.kind === "ref") {
    const target = context.defs.get(items.name);
    if (target?.kind === "enum") return "string";
    return csName(items.name);
  }
  if (items.kind === "string" || items.kind === "stringEnum") return "string";
  if (items.kind === "any" || items.kind === "openMap") return "JsonElement";
  throw new Error(
    `no .NET element type for the ${items.kind} items of ${key} — add one to arrayElementType`,
  );
}
/* ------------------------------------------------------------------ */
/* Class and file emission                                              */
/* ------------------------------------------------------------------ */

function emitClass(
  context: EmitContext,
  definition: ObjectDefinition,
  options: { base?: string; sealed?: boolean; skip?: Set<string> },
): string {
  const name = csName(definition.name);
  const lines = doc(definition.description, "");
  const modifier = options.sealed === false ? "" : "sealed ";
  const base = options.base ? ` : ${options.base}` : "";
  lines.push(`public ${modifier}class ${name}${base}`);
  lines.push("{");
  const bodies: string[][] = [];
  for (const field of definition.fields) {
    if (options.skip?.has(field.name)) continue;
    bodies.push(csProperty(context, definition, field));
  }
  lines.push(bodies.map((body) => body.join("\n")).join("\n\n"));
  lines.push("}");
  return lines.join("\n");
}

/** An abstract union base with a computed discriminator. */
function emitUnionBase(
  name: string,
  description: string,
  discriminator: string,
  converter: string | undefined,
  extraFields: string[] = [],
): string {
  const lines = doc(description, "");
  if (converter) lines.push(`[JsonConverter(typeof(${converter}))]`);
  lines.push(`public abstract class ${csName(name)}`);
  lines.push("{");
  const body = [
    `    [JsonPropertyName("${discriminator}")]`,
    `    public abstract string ${pascal(discriminator)} { get; }`,
  ];
  lines.push([...extraFields, body.join("\n")].join("\n\n"));
  lines.push("}");
  return lines.join("\n");
}

function emitConstClass(
  name: string,
  description: string,
  entries: Array<[string, string]>,
): string {
  // Two schema values that differ only in case or separators derive the same
  // member name, which would emit the same constant twice.
  const seen = new Map<string, string>();
  for (const [member, value] of entries) {
    const first = seen.get(member);
    if (first !== undefined) {
      throw new Error(
        `${name}.${member} would be declared twice, for "${first}" and "${value}" — ` +
          "name one of them explicitly rather than deriving it",
      );
    }
    seen.set(member, value);
  }

  const lines = doc(description, "");
  lines.push(`public static class ${name}`);
  lines.push("{");
  lines.push(
    entries
      .map(
        ([member, value]) => `    public const string ${member} = "${value}";`,
      )
      .join("\n"),
  );
  lines.push("}");
  return lines.join("\n");
}

const FILE_USINGS = [
  "using System.Collections.Generic;",
  "using System.Text.Json;",
  "using System.Text.Json.Serialization;",
  "",
  "namespace AGUI.Abstractions;",
].join("\n");

export interface GeneratedDotnetModelFile {
  name: string;
  content: string;
}

/**
 * Definitions this emitter deliberately writes no C# class for, each with the
 * reason. Everything else the schema declares as an object or a union has to be
 * emitted: the class list below is written by hand, so a definition the schema
 * gains and nobody adds to it is simply absent from .NET — while TypeScript and
 * Python emit it, and the drift gate, which compares the generator only against
 * its own output, stays green.
 */
const NOT_IN_DOTNET = new Set([
  // JSON Patch rides as opaque JsonElement in this SDK (see OPAQUE_REFS): the
  // operations have no C# classes, so neither does the union over them.
  "JsonPatchOperation",
  "AddOperation",
  "RemoveOperation",
  "ReplaceOperation",
  "MoveOperation",
  "CopyOperation",
  "TestOperation",
]);

/** Every object and union either becomes a C# class or says why it does not. */
function assertEveryDefinitionIsEmitted(
  model: ProtocolModel,
  emitted: Iterable<string>,
): void {
  const written = new Set(emitted);
  const missing = model.definitions
    .filter(
      (definition) =>
        (definition.kind === "object" || definition.kind === "union") &&
        !written.has(definition.name) &&
        !NOT_IN_DOTNET.has(definition.name),
    )
    .map((definition) => definition.name);
  if (missing.length > 0) {
    throw new Error(
      `the .NET models write no class for ${missing.join(", ")} — the class list is written ` +
        "by hand, so a definition nobody adds to it silently has no .NET representation at " +
        "all; add it to the plain types (or to whichever union family it belongs to), or to " +
        "NOT_IN_DOTNET with the reason it has none",
    );
  }
}

export function emitDotnetModels(
  model: ProtocolModel,
): GeneratedDotnetModelFile[] {
  assertTableKeys("TYPE_NAME", Object.keys(TYPE_NAME), model);
  assertTableKeys("PROP_NAME", Object.keys(PROP_NAME), model);
  assertTableKeys("STRING_DEFAULT", Object.keys(STRING_DEFAULT), model);
  assertTableKeys("BESPOKE_PROPERTY", Object.keys(BESPOKE_PROPERTY), model);
  assertTableKeys("NULLABLE_REQUIRED_STRINGS", NULLABLE_REQUIRED_STRINGS, model);
  assertTableKeys("NULLABLE_REQUIRED_ANY", NULLABLE_REQUIRED_ANY, model);
  const defs = new Map(model.definitions.map((d) => [d.name, d]));
  const memberOf = new Map<string, string>();
  for (const definition of model.definitions) {
    if (definition.kind !== "union") continue;
    for (const member of definition.members) {
      memberOf.set(member, definition.name);
    }
  }
  assertUnionsAreModelled(defs);
  const context: EmitContext = { defs, memberOf };
  const objectDef = (name: string): ObjectDefinition => {
    const definition = defs.get(name);
    if (definition?.kind !== "object")
      throw new Error(`${name} is not an object`);
    return definition;
  };
  const enumDef = (name: string) => {
    const definition = defs.get(name);
    if (definition?.kind !== "enum") throw new Error(`${name} is not an enum`);
    return definition;
  };
  const unionDef = (name: string) => {
    const definition = defs.get(name);
    if (definition?.kind !== "union") throw new Error(`${name} is not a union`);
    return definition;
  };
  const file = (
    name: string,
    ...sections: string[]
  ): GeneratedDotnetModelFile => ({
    name,
    content: [banner(model.schemaId), FILE_USINGS, ...sections, ""].join(
      "\n\n",
    ),
  });

  /**
   * The members of a union's discriminator const class, read from the members
   * themselves: adding a role, a content type or an outcome to the schema adds
   * its constant here rather than leaving the emitted C# naming one that does
   * not exist.
   */
  const unionConstMembers = (unionName: string): Array<[string, string]> => {
    const { discriminator } = UNION_BASES[unionName];
    return unionDef(unionName).members.map((member) => {
      const field = objectDef(member).fields.find(
        (candidate) => candidate.name === discriminator,
      );
      if (field?.type.kind !== "literal") {
        throw new Error(
          `${member}.${discriminator} is not a literal, so the .NET const class ` +
            `for the ${unionName} union cannot be derived from the schema`,
        );
      }
      return [csMember(field.type.value), field.type.value];
    });
  };

  /* ---- const classes ---- */
  const eventTypes = emitConstClass(
    "AGUIEventTypes",
    enumDef("EventType").description,
    enumDef("EventType").values.map((value) => [csMember(value), value]),
  );
  const roles = emitConstClass(
    "AGUIRoles",
    "Constants for AG-UI message role discriminators.",
    unionConstMembers("Message"),
  );
  const resumeStatus = emitConstClass(
    "ResumeStatus",
    "Constants for the resume entry status discriminator.",
    // An inline enum on the field rather than a named definition, so its values
    // are read from there.
    (() => {
      const status = objectDef("ResumeEntry").fields.find(
        (field) => field.name === "status",
      );
      if (status?.type.kind !== "stringEnum") {
        throw new Error("ResumeEntry.status is not a string enum");
      }
      return status.type.values.map((value): [string, string] => [
        csMember(value),
        value,
      ]);
    })(),
  );
  const outcomeTypes = emitConstClass(
    "RunFinishedOutcomeTypes",
    unionDef("RunFinishedOutcome").description,
    unionConstMembers("RunFinishedOutcome"),
  );
  const subagentOutcomeTypes = emitConstClass(
    "SubagentFinishedOutcomeTypes",
    unionDef("SubagentFinishedOutcome").description,
    unionConstMembers("SubagentFinishedOutcome"),
  );
  const inputContentTypes = emitConstClass(
    "AGUIInputContentTypes",
    unionDef("InputContent").description,
    unionConstMembers("InputContent"),
  );
  const sourceTypes = emitConstClass(
    "AGUIInputContentSourceTypes",
    unionDef("InputContentSource").description,
    unionConstMembers("InputContentSource"),
  );

  /* ---- events ---- */
  const baseEventShape = model.mixinShapes.find((s) => s.name === "BaseEvent");
  if (!baseEventShape) throw new Error("BaseEvent mixin missing");
  const baseEvent = [
    ...doc(baseEventShape.description, ""),
    "[JsonConverter(typeof(BaseEventJsonConverter))]",
    "public abstract class BaseEvent",
    "{",
    [
      [
        '    [JsonPropertyName("type")]',
        "    public abstract string Type { get; }",
      ].join("\n"),
      ...baseEventShape.fields
        .filter((field) => field.name !== "type")
        .map((field) => csProperty(context, baseEventShape, field).join("\n")),
    ].join("\n\n"),
    "}",
  ].join("\n");

  // BaseEvent is emitted from the schema's mixin, so the fields its events must
  // not redeclare are exactly that mixin's. subagentRunId is not among them:
  // the schema composes it from Attributable, which the run-scoped events omit
  // and the three subagent lifecycle events require, so it rides per event.
  const eventBaseFields = new Set(
    baseEventShape.fields
      .map((field) => field.name)
      .filter((name) => name !== "type"),
  );

  assertEventsComposeBaseEvent(
    defs,
    baseEventShape,
    unionDef("Event").members.map(objectDef),
  );

  const eventClasses = unionDef("Event").members.map((member) =>
    emitClass(context, objectDef(member), {
      base: "BaseEvent",
      skip: eventBaseFields,
    }),
  );

  /* ---- messages ---- */
  const baseMessage = [
    ...doc("Any message in a conversation. Discriminated by role.", ""),
    "[JsonConverter(typeof(AGUIMessageJsonConverter))]",
    "public abstract class AGUIMessage",
    "{",
    [
      [
        ...doc(
          "Identifies this message. Every role requires it, so the property is non-nullable: an empty id is schema-valid and rides as empty, but an absent one is not a message the protocol describes.",
          "    ",
        ),
        '    [JsonPropertyName("id")]',
        "    public string Id { get; set; } = string.Empty;",
      ].join("\n"),
      [
        '    [JsonPropertyName("role")]',
        "    public abstract string Role { get; }",
      ].join("\n"),
      [
        ...doc(
          "Extra information attached to this message, open by key. Any JSON value is allowed under a key, including null. The object itself is absent or an object, never null. The ag-ui key is reserved for AG-UI's own use; see AGUIMetadata.ReservedKey.",
          "    ",
        ),
        '    [JsonPropertyName("metadata")]',
        "    public JsonElement? Metadata { get; set; }",
      ].join("\n"),
      [
        ...doc(
          "The subagent run this message is attributed to, when a subagent produced it on behalf of the main run.",
          "    ",
        ),
        '    [JsonPropertyName("subagentRunId")]',
        "    public string? SubagentRunId { get; set; }",
      ].join("\n"),
    ].join("\n\n"),
    "}",
  ].join("\n");

  assertMessageBaseFields(defs, unionDef("Message").members.map(objectDef));

  const messageClasses = unionDef("Message").members.map((member) =>
    emitClass(context, objectDef(member), {
      base: "AGUIMessage",
      skip: MESSAGE_BASE_FIELDS,
    }),
  );

  /* ---- input content ---- */
  const inputContentBase = emitUnionBase(
    "InputContent",
    unionDef("InputContent").description,
    "type",
    "AGUIInputContentJsonConverter",
  );
  // The base above is an SDK idiom, not a schema shape: it exists so the four
  // media parts share one source/metadata pair. If a member stops matching that
  // pair, hoisting it would change what the member says.
  assertMediaPartsShareTheirBase([...MEDIA_PARTS].map(objectDef));

  const mediaBase = [
    ...doc(
      "The shared shape of the four media parts: where the bytes come from, and open extra information about the part.",
      "",
    ),
    "public abstract class AGUIMediaInputContent : AGUIInputContent",
    "{",
    [
      [
        '    [JsonPropertyName("source")]',
        "    public AGUIInputContentSource Source { get; set; } = null!;",
      ].join("\n"),
      [
        '    [JsonPropertyName("metadata")]',
        "    public JsonElement? Metadata { get; set; }",
      ].join("\n"),
    ].join("\n\n"),
    "}",
  ].join("\n");
  const contentClasses = unionDef("InputContent").members.map((member) =>
    emitClass(context, objectDef(member), {
      base: MEDIA_PARTS.has(member)
        ? "AGUIMediaInputContent"
        : "AGUIInputContent",
      skip: MEDIA_PARTS.has(member)
        ? new Set(["source", "metadata"])
        : undefined,
    }),
  );
  const sourceBase = emitUnionBase(
    "InputContentSource",
    unionDef("InputContentSource").description,
    "type",
    "AGUIInputContentSourceJsonConverter",
  );
  const sourceClasses = unionDef("InputContentSource").members.map((member) =>
    emitClass(context, objectDef(member), { base: "AGUIInputContentSource" }),
  );

  /* ---- outcomes ---- */
  const outcomeBase = emitUnionBase(
    "RunFinishedOutcome",
    unionDef("RunFinishedOutcome").description,
    "type",
    "RunFinishedOutcomeJsonConverter",
    ["    internal RunFinishedOutcome() { }"],
  );
  const outcomeClasses = unionDef("RunFinishedOutcome").members.map((member) =>
    emitClass(context, objectDef(member), { base: "RunFinishedOutcome" }),
  );
  const subagentOutcomeBase = emitUnionBase(
    "SubagentFinishedOutcome",
    unionDef("SubagentFinishedOutcome").description,
    "type",
    "SubagentFinishedOutcomeJsonConverter",
    ["    internal SubagentFinishedOutcome() { }"],
  );
  const subagentOutcomeClasses = unionDef(
    "SubagentFinishedOutcome",
  ).members.map((member) =>
    emitClass(context, objectDef(member), { base: "SubagentFinishedOutcome" }),
  );

  /* ---- plain types ---- */
  const plainNames = [
    "FunctionCall",
    "ToolCall",
    "Tool",
    "Context",
    "Interrupt",
    "ResumeEntry",
    "TokenUsage",
    "RunAgentInput",
    // The capability model. Listed after the run types because a capabilities
    // snapshot describes the agent rather than a run, and in schema order so
    // the emitted file reads the way the schema declares them.
    "SubagentInfo",
    "IdentityCapabilities",
    "TransportCapabilities",
    "ToolsCapabilities",
    "OutputCapabilities",
    "StateCapabilities",
    "MultiAgentCapabilities",
    "ReasoningCapabilities",
    "MultimodalInputCapabilities",
    "MultimodalOutputCapabilities",
    "MultimodalCapabilities",
    "ExecutionCapabilities",
    "HumanInTheLoopCapabilities",
    "AgentCapabilities",
  ];
  const plain = plainNames.map((name) =>
    emitClass(context, objectDef(name), {}),
  );

  const emittedUnions = [
    "Event",
    "Message",
    "InputContent",
    "InputContentSource",
    "RunFinishedOutcome",
    "SubagentFinishedOutcome",
  ];
  const emittedObjects = [
    ...emittedUnions.flatMap((name) => unionDef(name).members),
    ...plainNames,
  ];

  assertEveryReferencedObjectIsEmitted(
    defs,
    emittedObjects,
    // The union families emitted above, base and members alike. Event is among
    // them: BaseEvent and its event classes are written here too.
    emittedUnions,
    [baseEventShape],
  );
  // The check above walks outwards from what is written and insists every
  // reference lands somewhere. This one walks the other way: from the schema,
  // insisting nothing it declares is left out — a definition nothing references
  // yet is invisible to a reference walk.
  assertEveryDefinitionIsEmitted(model, [...emittedObjects, ...emittedUnions]);

  return [
    file("AGUIEventTypes.g.cs", eventTypes),
    file("AGUIRoles.g.cs", roles),
    file(
      "AGUIConstants.g.cs",
      resumeStatus,
      outcomeTypes,
      subagentOutcomeTypes,
      inputContentTypes,
      sourceTypes,
    ),
    file("BaseEvent.g.cs", baseEvent),
    file("AGUIEvents.g.cs", ...eventClasses),
    file(
      "AGUIMessages.g.cs",
      baseMessage,
      ...messageClasses,
      inputContentBase,
      mediaBase,
      ...contentClasses,
      sourceBase,
      ...sourceClasses,
    ),
    file(
      "AGUITypes.g.cs",
      ...plain,
      outcomeBase,
      ...outcomeClasses,
      subagentOutcomeBase,
      ...subagentOutcomeClasses,
    ),
  ];
}
