/**
 * The reader: schema.json in, a language-neutral model out.
 *
 * Interpretation of JSON Schema happens here and nowhere else. Emitters render
 * the model without ever reading the schema, so every target language works
 * from the same resolved facts — the same fields, the same requiredness, the
 * same documentation — computed once.
 *
 * The reader is deliberately paranoid: it understands exactly the constructs
 * the schema uses today (the same vocabulary the harness pins) and throws on
 * anything else. A schema construct this file does not model must fail
 * generation loudly rather than be skipped by whichever emitter did not know
 * about it.
 */

export interface ProtocolModel {
  /** The version segment of the schema's $id, e.g. "draft" or "1.0". */
  version: string;
  /** The schema's full $id. */
  schemaId: string;
  /**
   * Every emitted definition, in dependency order: a definition appears after
   * everything it references, so an emitter can declare values top to bottom.
   * Mixins are not in this list — they are resolved into their composers.
   */
  definitions: Definition[];
  /** The names of the mixin definitions that were flattened away. */
  mixins: string[];
}

export type Definition =
  | ObjectDefinition
  | UnionDefinition
  | EnumDefinition
  | AliasDefinition;

export interface ObjectDefinition {
  kind: "object";
  name: string;
  description: string;
  /** Flattened: mixin fields first (composition order), then own fields. */
  fields: Field[];
  /** Whether the spec closes this object (unevaluatedProperties: false). */
  closed: boolean;
}

export interface UnionDefinition {
  kind: "union";
  name: string;
  description: string;
  /** Definition names, in schema order. */
  members: string[];
  /** The field every member pins to a distinct const, when one exists. */
  discriminator?: string;
}

export interface EnumDefinition {
  kind: "enum";
  name: string;
  description: string;
  values: string[];
}

export interface AliasDefinition {
  kind: "alias";
  name: string;
  description: string;
  type: TypeExpr;
}

export interface Field {
  name: string;
  description: string;
  required: boolean;
  type: TypeExpr;
  /** Annotation only: emitted as documentation, never as parse behaviour. */
  defaultValue?: unknown;
  /** Annotation only (e.g. "base64"): emitted as documentation. */
  contentEncoding?: string;
}

export type TypeExpr =
  | { kind: "string"; pattern?: string }
  | { kind: "integer"; minimum?: number; maximum?: number }
  | { kind: "boolean" }
  | {
      kind: "literal";
      value: string;
      /** Set when the literal narrows a reference to an enum definition. */
      enumRef?: string;
    }
  | { kind: "any" }
  | { kind: "openMap" }
  | { kind: "ref"; name: string }
  | { kind: "stringEnum"; values: string[] }
  | {
      kind: "array";
      items: TypeExpr;
      minItems?: number;
      /** The items subschema's own description, so no meaning is dropped. */
      itemsDescription?: string;
    }
  | { kind: "union"; members: TypeExpr[] };

type Json = Record<string, unknown>;

/** Every keyword the reader models. Anything else is a hard error. */
const KNOWN_KEYWORDS = new Set([
  "$anchor",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "const",
  "contentEncoding",
  "default",
  "description",
  "enum",
  "items",
  "maximum",
  "minItems",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
  "unevaluatedProperties",
]);

class SchemaReadError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SchemaReadError";
  }
}

function assertKnownKeywords(node: Json, path: string): void {
  for (const key of Object.keys(node)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      throw new SchemaReadError(
        path,
        `keyword "${key}" is not modelled by the generator — teach ir.ts what it means before the schema relies on it`,
      );
    }
  }
}

function requireString(value: unknown, path: string, what: string): string {
  if (typeof value !== "string") {
    throw new SchemaReadError(path, `expected a string ${what}`);
  }
  return value;
}

/**
 * A field's documentation: its own description, or the description of the
 * definition it references. A narrowing declaration (the `type` const on each
 * event) may have neither — it inherits at flatten time, which flattenObject
 * verifies once merging is done.
 */
function fieldDescription(
  node: Json,
  defs: Record<string, Json>,
): string | undefined {
  if (typeof node.description === "string") return node.description;
  const ref = node.$ref;
  if (typeof ref === "string") {
    const target = defs[ref.replace("#/$defs/", "")];
    if (target && typeof target.description === "string") {
      return target.description;
    }
  }
  return undefined;
}

/** Reads one subschema position into a TypeExpr. */
function readType(
  node: Json,
  defs: Record<string, Json>,
  path: string,
): TypeExpr {
  assertKnownKeywords(node, path);

  const ref = node.$ref;
  if (typeof ref === "string") {
    if (!ref.startsWith("#/$defs/")) {
      throw new SchemaReadError(path, `reference outside this file: ${ref}`);
    }
    // In 2020-12 a $ref applies alongside its siblings, so a constraint next
    // to one would combine with the target — a construct this reader does not
    // model and must not silently drop. Annotations are fine.
    for (const key of Object.keys(node)) {
      if (
        !["$ref", "description", "default", "contentEncoding"].includes(key)
      ) {
        throw new SchemaReadError(
          path,
          `unmodelled sibling "${key}" next to a $ref`,
        );
      }
    }
    return { kind: "ref", name: ref.replace("#/$defs/", "") };
  }

  if ("const" in node) {
    return { kind: "literal", value: requireString(node.const, path, "const") };
  }

  if (Array.isArray(node.enum)) {
    if (node.type !== "string" && node.type !== undefined) {
      throw new SchemaReadError(path, "enum on a non-string position");
    }
    const values = node.enum as unknown[];
    if (!values.every((value) => typeof value === "string")) {
      throw new SchemaReadError(path, "enum with a non-string member");
    }
    return { kind: "stringEnum", values: values as string[] };
  }

  if (Array.isArray(node.oneOf)) {
    return {
      kind: "union",
      members: (node.oneOf as Json[]).map((member, index) =>
        readType(member, defs, `${path}/oneOf/${index}`),
      ),
    };
  }

  switch (node.type) {
    case "string": {
      const expr: TypeExpr = { kind: "string" };
      if (typeof node.pattern === "string") expr.pattern = node.pattern;
      return expr;
    }
    case "integer": {
      const expr: TypeExpr = { kind: "integer" };
      if (typeof node.minimum === "number") expr.minimum = node.minimum;
      if (typeof node.maximum === "number") expr.maximum = node.maximum;
      return expr;
    }
    case "boolean":
      return { kind: "boolean" };
    case "object": {
      if (node.properties !== undefined) {
        throw new SchemaReadError(
          path,
          "inline object with properties — only definitions declare shapes",
        );
      }
      if (node.additionalProperties !== true) {
        throw new SchemaReadError(
          path,
          "object without additionalProperties: true",
        );
      }
      return { kind: "openMap" };
    }
    case "array": {
      const items = node.items;
      if (typeof items !== "object" || items === null) {
        throw new SchemaReadError(path, "array without an items schema");
      }
      const expr: TypeExpr = {
        kind: "array",
        items: readType(items as Json, defs, `${path}/items`),
      };
      if (typeof node.minItems === "number") expr.minItems = node.minItems;
      const itemsDescription = (items as Json).description;
      if (typeof itemsDescription === "string") {
        expr.itemsDescription = itemsDescription;
      }
      return expr;
    }
    case undefined: {
      // Only annotations left: an unconstrained position, i.e. any JSON value.
      return { kind: "any" };
    }
    default:
      throw new SchemaReadError(path, `unmodelled type "${String(node.type)}"`);
  }
}

/** Reads a property subschema into a Field, given the enclosing required set. */
function readField(
  name: string,
  node: Json,
  required: Set<string>,
  defs: Record<string, Json>,
  path: string,
): Field {
  const field: Field = {
    name,
    description: fieldDescription(node, defs) ?? "",
    required: required.has(name),
    type: readType(node, defs, path),
  };
  if ("default" in node) field.defaultValue = node.default;
  if (typeof node.contentEncoding === "string") {
    field.contentEncoding = node.contentEncoding;
  }
  return field;
}

/**
 * Flattens a definition and its mixins into one ordered field list. Mixin
 * fields come first, in composition order; the definition's own fields follow.
 * A local redeclaration of an inherited field (the `type` const on each event)
 * narrows it in place: the local type wins, the inherited description and
 * position survive.
 */
function flattenObject(
  name: string,
  def: Json,
  defs: Record<string, Json>,
  mixins: Set<string>,
): ObjectDefinition {
  const path = `#/$defs/${name}`;
  const fields = new Map<string, Field>();
  const required = new Set<string>();

  const collectRequired = (node: Json): void => {
    for (const entry of (node.required as string[] | undefined) ?? []) {
      required.add(entry);
    }
    for (const member of (node.allOf as Json[] | undefined) ?? []) {
      const ref = member.$ref as string;
      collectRequired(defs[ref.replace("#/$defs/", "")]);
    }
  };
  collectRequired(def);

  const collectFields = (node: Json, nodePath: string): void => {
    for (const member of (node.allOf as Json[] | undefined) ?? []) {
      const ref = member.$ref as string | undefined;
      const target = ref?.replace("#/$defs/", "");
      if (!target || !mixins.has(target)) {
        throw new SchemaReadError(
          nodePath,
          "allOf member is not a mixin reference",
        );
      }
      collectFields(defs[target], `#/$defs/${target}`);
    }
    for (const [fieldName, child] of Object.entries(
      (node.properties as Json) ?? {},
    )) {
      const childPath = `${nodePath}/properties/${fieldName}`;
      const inherited = fields.get(fieldName);
      const field = readField(
        fieldName,
        child as Json,
        required,
        defs,
        childPath,
      );
      if (inherited === undefined) {
        fields.set(fieldName, field);
        continue;
      }
      // Narrowing in place: keep the inherited description when the local
      // declaration has none of its own, and record which enum a literal
      // narrows when the inherited field referenced one.
      if (field.description === "") {
        field.description = inherited.description;
      }
      if (
        field.type.kind === "literal" &&
        inherited.type.kind === "ref" &&
        defs[inherited.type.name]?.enum !== undefined
      ) {
        field.type.enumRef = inherited.type.name;
      }
      fields.set(fieldName, field);
    }
  };
  collectFields(def, path);

  for (const field of fields.values()) {
    if (field.description === "") {
      throw new SchemaReadError(
        `${path}/properties/${field.name}`,
        "no description on the field, its reference target, or the field it narrows",
      );
    }
  }

  return {
    kind: "object",
    name,
    description: requireString(def.description, path, "description"),
    fields: [...fields.values()],
    closed: def.unevaluatedProperties === false,
  };
}

/** The field every union member pins to a distinct const, if there is one. */
function findDiscriminator(
  members: string[],
  defs: Record<string, Json>,
  mixins: Set<string>,
): string | undefined {
  const flattened = members.map((member) =>
    flattenObject(member, defs[member], defs, mixins),
  );
  const candidates = flattened[0].fields
    .filter((field) => field.type.kind === "literal" && field.required)
    .map((field) => field.name);
  for (const candidate of candidates) {
    const values = new Set<string>();
    const pinnedEverywhere = flattened.every((definition) => {
      const field = definition.fields.find((entry) => entry.name === candidate);
      if (!field || field.type.kind !== "literal" || !field.required)
        return false;
      values.add(field.type.value);
      return true;
    });
    if (pinnedEverywhere && values.size === members.length) return candidate;
  }
  return undefined;
}

/** Definition names a definition references, for dependency ordering. */
function referencesOf(definition: Definition): string[] {
  const refs = new Set<string>();
  const walkType = (type: TypeExpr): void => {
    switch (type.kind) {
      case "ref":
        refs.add(type.name);
        break;
      case "literal":
        if (type.enumRef) refs.add(type.enumRef);
        break;
      case "array":
        walkType(type.items);
        break;
      case "union":
        type.members.forEach(walkType);
        break;
      default:
        break;
    }
  };
  switch (definition.kind) {
    case "object":
      definition.fields.forEach((field) => walkType(field.type));
      break;
    case "union":
      definition.members.forEach((member) => refs.add(member));
      break;
    case "alias":
      walkType(definition.type);
      break;
    case "enum":
      break;
  }
  return [...refs];
}

/**
 * Walks every subschema position in the document and asserts its keywords are
 * modelled. The readers below assert too, but only where they look — this
 * catches an unmodelled constraint parked somewhere no reader visits, such as
 * a mixin's own top level, before anything is silently dropped.
 */
function assertVocabulary(root: Json): void {
  const step = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return;
    const object = node as Json;
    assertKnownKeywords(object, path);
    for (const [key, value] of Object.entries(object)) {
      if (key === "properties" || key === "$defs") {
        for (const [name, child] of Object.entries(value as Json)) {
          step(child, `${path}/${key}/${name}`);
        }
      } else if (key === "allOf" || key === "oneOf") {
        (value as unknown[]).forEach((child, index) =>
          step(child, `${path}/${key}/${index}`),
        );
      } else if (
        key === "items" ||
        key === "additionalProperties" ||
        key === "unevaluatedProperties"
      ) {
        step(value, `${path}/${key}`);
      }
    }
  };
  step(root, "#");
}

/**
 * Reads the whole schema into the model. Throws on any construct outside the
 * vocabulary this file understands.
 */
export function buildModel(schema: Json): ProtocolModel {
  assertVocabulary(schema);
  const schemaId = requireString(schema.$id, "#", "$id");
  const versionMatch = /\/spec\/([^/]+)\/schema\.json$/.exec(schemaId);
  if (!versionMatch) {
    throw new SchemaReadError(
      "#/$id",
      `cannot read a version out of "${schemaId}"`,
    );
  }

  const defs = schema.$defs as Record<string, Json>;

  // A mixin is a definition that exists to be composed: it is referenced from
  // some allOf and never from anywhere else. Derived rather than listed, so a
  // new mixin needs no generator change.
  const composedFrom = new Set<string>();
  const referencedElsewhere = new Set<string>();
  for (const def of Object.values(defs)) {
    for (const member of (def.allOf as Json[] | undefined) ?? []) {
      const ref = member.$ref as string | undefined;
      if (ref) composedFrom.add(ref.replace("#/$defs/", ""));
    }
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const object = node as Json;
      const ref = object.$ref;
      if (typeof ref === "string") {
        referencedElsewhere.add(ref.replace("#/$defs/", ""));
      }
      for (const [key, value] of Object.entries(object)) {
        if (key !== "allOf") walk(value);
      }
    };
    walk(def);
  }
  const mixins = new Set(
    [...composedFrom].filter((name) => !referencedElsewhere.has(name)),
  );

  const definitions = new Map<string, Definition>();
  for (const [name, def] of Object.entries(defs)) {
    if (mixins.has(name)) continue;
    const path = `#/$defs/${name}`;
    assertKnownKeywords(def, path);
    const description = requireString(def.description, path, "description");

    if (Array.isArray(def.enum)) {
      definitions.set(name, {
        kind: "enum",
        name,
        description,
        values: def.enum as string[],
      });
    } else if (Array.isArray(def.oneOf)) {
      const members = (def.oneOf as Json[]).map((member, index) => {
        const ref = member.$ref;
        if (typeof ref !== "string") {
          throw new SchemaReadError(
            `${path}/oneOf/${index}`,
            "union member is not a reference",
          );
        }
        return ref.replace("#/$defs/", "");
      });
      definitions.set(name, {
        kind: "union",
        name,
        description,
        members,
        discriminator: findDiscriminator(members, defs, mixins),
      });
    } else if (def.properties !== undefined || def.allOf !== undefined) {
      definitions.set(name, flattenObject(name, def, defs, mixins));
    } else {
      definitions.set(name, {
        kind: "alias",
        name,
        description,
        type: readType(
          Object.fromEntries(
            Object.entries(def).filter(
              ([key]) => !["$anchor", "description"].includes(key),
            ),
          ),
          defs,
          path,
        ),
      });
    }
  }

  // Dependency order with schema order as the tie-break: visit definitions as
  // the schema declares them, emitting each one's references first.
  const ordered: Definition[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      throw new SchemaReadError(`#/$defs/${name}`, "reference cycle");
    }
    state.set(name, "visiting");
    const definition = definitions.get(name);
    if (!definition) {
      throw new SchemaReadError(
        `#/$defs/${name}`,
        "reference to a definition that is not emitted",
      );
    }
    for (const ref of referencesOf(definition)) visit(ref);
    state.set(name, "done");
    ordered.push(definition);
  };
  for (const name of definitions.keys()) visit(name);

  return {
    version: versionMatch[1],
    schemaId,
    definitions: ordered,
    mixins: [...mixins].sort(),
  };
}
