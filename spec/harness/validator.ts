import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020";

// Derived from import.meta.url rather than import.meta.dirname, which is absent
// when this file is loaded through a CommonJS transpile such as tsx's.
const HERE = fileURLToPath(new URL(".", import.meta.url));

export const DRAFT_DIR = join(HERE, "..", "draft");

export const SCHEMA_ID = "https://ag-ui.com/spec/draft/schema.json";
export const JSON_PATCH_ID = "https://ag-ui.com/spec/draft/json-patch.json";

function readSchemaFile(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DRAFT_DIR, name), "utf8")) as Record<
    string,
    unknown
  >;
}

export const schema = readSchemaFile("schema.json");
export const jsonPatchSchema = readSchemaFile("json-patch.json");

/**
 * Strict mode is the point of using ajv here: JSON Schema's default behaviour is
 * to ignore a keyword it does not recognise, so `requred` instead of `required`
 * would leave the rule silently absent while every test still passed. Strict
 * mode turns that into a load-time failure.
 *
 * `allErrors` is on because a document rejected inside a `oneOf` produces one
 * error per failed branch, and the branch that names the real problem is not
 * necessarily the first.
 */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    // strictRequired is an ajv lint, not a correctness check, and it is wrong for
    // composition: `required: ["id"]` on DeveloperMessage names a property
    // BaseMessage declares, which is exactly how allOf is meant to work. Left on,
    // it rejects the composition this contract is built from. Everything else
    // strict mode does — above all the unknown-keyword gate — stays on.
    strictRequired: false,
    allErrors: true,
    validateSchema: true,
  });
  // `$anchor` is a core 2020-12 keyword and ajv resolves it correctly, but its
  // strict-mode allowlist omits it, so compiling an anchored definition throws
  // "unknown keyword". Declaring it here tells ajv about a keyword the standard
  // already defines; it is not a custom annotation, and strict mode keeps
  // rejecting genuine misspellings, which `compiles every definition` pins.
  ajv.addKeyword("$anchor");
  // Registered by $id. Nothing is fetched: `json-patch.json` resolves against
  // schema.json's $id to the absolute JSON_PATCH_ID, and compiling succeeds only
  // because that exact identifier is already known here.
  ajv.addSchema(jsonPatchSchema);
  ajv.addSchema(schema);
  return ajv;
}

const ajv = createAjv();

/** A compiled validator for one anchored definition, e.g. `TextMessageStartEvent`. */
export function validatorFor(anchor: string): ValidateFunction {
  const uri = `${SCHEMA_ID}#${anchor}`;
  const validate = ajv.getSchema(uri);
  if (!validate) {
    throw new Error(`No schema registered at ${uri}`);
  }
  return validate;
}

/** A compiled validator for the whole event union, i.e. the document root. */
export function eventValidator(): ValidateFunction {
  const validate = ajv.getSchema(SCHEMA_ID);
  if (!validate) {
    throw new Error(`No schema registered at ${SCHEMA_ID}`);
  }
  return validate;
}

/**
 * One reported failure, in the vocabulary JSON Schema 2020-12's own output
 * format uses. ajv reports in its own shape; normalising here means a fixture's
 * expectation is written against the standard rather than against ajv, so the
 * same expectation files stay readable if another implementation ever consumes
 * them.
 */
export interface NormalisedError {
  keyword: string;
  instanceLocation: string;
  keywordLocation: string;
}

export function normaliseErrors(
  errors: ErrorObject[] | null | undefined,
): NormalisedError[] {
  return (errors ?? []).map((error) => ({
    keyword: error.keyword,
    instanceLocation: error.instancePath,
    keywordLocation: error.schemaPath,
  }));
}

/** The values the EventType enum declares. */
export function declaredEventTypes(): string[] {
  const eventType = (schema.$defs as Record<string, Record<string, unknown>>)
    .EventType;
  return eventType.enum as string[];
}

/**
 * Every definition in schema.json that is an event, keyed by its `type` value.
 *
 * A definition counts as an event when it pins `type` to a value the EventType
 * enum declares. Pinning a `type` is not enough on its own: several non-event
 * definitions do it too, because a tool call, an outcome and a content part are
 * all discriminated the same way.
 */
export function eventDefinitions(): Map<string, string> {
  const defs = schema.$defs as Record<string, Record<string, unknown>>;
  const eventTypes = new Set(declaredEventTypes());
  const byType = new Map<string, string>();
  for (const [name, def] of Object.entries(defs)) {
    const properties = def.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    const typeConst = properties?.type?.const;
    if (typeof typeConst === "string" && eventTypes.has(typeConst)) {
      byType.set(typeConst, name);
    }
  }
  return byType;
}

/** Every top-level definition name in schema.json. */
export function definitionNames(): string[] {
  return Object.keys(schema.$defs as Record<string, unknown>);
}

/** Every top-level definition name in json-patch.json. */
export function jsonPatchDefinitionNames(): string[] {
  return Object.keys(jsonPatchSchema.$defs as Record<string, unknown>);
}

/**
 * Every definition in a file that declares `properties`, and therefore has a
 * shape that can drift. Unions, enums and the always-true definitions have
 * nothing to pin and are excluded. The pin tables are checked against this, so
 * adding a definition without pinning it fails rather than going unchecked.
 */
export function shapedDefinitions(
  file: Record<string, unknown> = schema,
): string[] {
  const defs = (file.$defs ?? {}) as Record<string, Record<string, unknown>>;
  // Shape is what a document may carry, not the presence of one keyword. Asking
  // for a top-level `properties` missed a definition whose fields arrive only
  // through an inline `allOf` — which needed no pin and could therefore lose a
  // field silently, the exact hole the pins exist to close.
  return Object.keys(defs)
    .filter((name) => effectiveProperties(name, file).length > 0)
    .sort();
}

/**
 * Every `oneOf` in a file, wherever it appears, with a description of each
 * member.
 *
 * Keyed by its location under `$defs` — `Message`, or
 * `UserMessage/properties/content` for one nested inside a property. Looking only
 * at definition-level unions missed the inline one on `UserMessage.content`, so a
 * member could be added to it with the whole suite green: `{"type": "number"}`
 * there makes `content: 42` a valid user message.
 *
 * A member is described by the definition it references, or by its declared type
 * when it is inline, which is enough to notice one appearing or disappearing.
 */
export function unionPositions(
  file: Record<string, unknown> = schema,
): Record<string, string[]> {
  const defs = (file.$defs ?? {}) as Record<string, Record<string, unknown>>;
  const found: Record<string, string[]> = {};

  const describe = (member: Record<string, unknown>): string => {
    const ref = member.$ref as string | undefined;
    if (ref?.startsWith("#/$defs/")) return ref.replace("#/$defs/", "");
    if (ref !== undefined) return `ref:${ref}`;
    const type = member.type as string | undefined;
    return type ? `type:${type}` : "inline";
  };

  const step = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return;
    const object = node as Record<string, unknown>;
    if (Array.isArray(object.oneOf)) {
      found[path] = (object.oneOf as Array<Record<string, unknown>>).map(
        describe,
      );
    }
    for (const [key, value] of Object.entries(object)) {
      if (key === "properties" || key === "$defs") {
        for (const [name, child] of Object.entries(
          value as Record<string, unknown>,
        )) {
          step(child, `${path}/${key}/${name}`.replace(/^\/properties\//, ""));
        }
      } else if (key === "oneOf" || key === "anyOf" || key === "allOf") {
        (value as unknown[]).forEach((child, index) =>
          step(child, `${path}/${key}/${index}`),
        );
      } else if (key === "items") {
        step(value, `${path}/items`);
      }
    }
  };

  for (const [name, def] of Object.entries(defs)) step(def, name);
  return found;
}

/**
 * Every `enum` in a file, wherever it appears, keyed by location.
 *
 * `EventType` is checked separately against the definitions. The others were
 * unchecked, so a member could be removed with the suite green — dropping
 * `"developer"` from `TextMessageRole` makes a valid TEXT_MESSAGE_START invalid.
 */
export function enumPositions(
  file: Record<string, unknown> = schema,
): Record<string, string[]> {
  const defs = (file.$defs ?? {}) as Record<string, Record<string, unknown>>;
  const found: Record<string, string[]> = {};

  const step = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return;
    const object = node as Record<string, unknown>;
    if (Array.isArray(object.enum)) found[path] = object.enum as string[];
    for (const [key, value] of Object.entries(object)) {
      if (key === "properties" || key === "$defs") {
        for (const [name, child] of Object.entries(
          value as Record<string, unknown>,
        )) {
          step(child, `${path}/${key}/${name}`.replace(/^\/properties\//, ""));
        }
      } else if (key === "oneOf" || key === "anyOf" || key === "allOf") {
        (value as unknown[]).forEach((child, index) =>
          step(child, `${path}/${key}/${index}`),
        );
      } else if (key === "items") {
        step(value, `${path}/items`);
      }
    }
  };

  for (const [name, def] of Object.entries(defs)) step(def, name);
  return found;
}

/**
 * Every `const` in a file, wherever it appears, keyed by location.
 *
 * A `const` is what makes a discriminated union discriminate, so one that stops
 * being fixed changes what documents mean. Two were verifiably decorative before
 * this was pinned.
 */
export function constPositions(
  file: Record<string, unknown> = schema,
): Record<string, unknown> {
  const defs = (file.$defs ?? {}) as Record<string, Record<string, unknown>>;
  const found: Record<string, unknown> = {};

  const step = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return;
    const object = node as Record<string, unknown>;
    if ("const" in object) found[path] = object.const;
    for (const [key, value] of Object.entries(object)) {
      if (key === "properties" || key === "$defs") {
        for (const [name, child] of Object.entries(
          value as Record<string, unknown>,
        )) {
          step(child, `${path}/${key}/${name}`.replace(/^\/properties\//, ""));
        }
      } else if (key === "oneOf" || key === "anyOf" || key === "allOf") {
        (value as unknown[]).forEach((child, index) =>
          step(child, `${path}/${key}/${index}`),
        );
      } else if (key === "items" || key === "not") {
        step(value, `${path}/${key}`);
      }
    }
  };

  for (const [name, def] of Object.entries(defs)) step(def, name);
  return found;
}

/**
 * Every constraint in a file, flattened to location -> the keywords that decide
 * what a document may contain.
 *
 * The pins above cover structure — which properties exist, what is required, what
 * a union contains, which values are fixed. They do not cover the operands, and
 * the operands carry a lot of the contract: dropping `type: "string"` from
 * `FunctionCall.arguments` lets a tool call carry an object, and lowering
 * `TokenUsage.inputTokens.maximum` rejects legitimate counts. Both left every
 * other check green.
 *
 * Descriptions are excluded deliberately. They change often and for good reasons,
 * and a snapshot that churned on every wording fix would be updated without being
 * read — which is the failure mode a snapshot exists to prevent. That they exist
 * at all is checked separately.
 */
export function constraintMap(
  file: Record<string, unknown> = schema,
): Record<string, Record<string, unknown>> {
  const STRUCTURAL = new Set([
    "description",
    "title",
    "$anchor",
    "$id",
    "$schema",
    "properties",
    "$defs",
    "oneOf",
    "allOf",
    "items",
  ]);
  const found: Record<string, Record<string, unknown>> = {};

  const step = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return;
    const object = node as Record<string, unknown>;
    const constraints: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(object)) {
      if (!STRUCTURAL.has(key)) constraints[key] = value;
    }
    if (Object.keys(constraints).length > 0) found[path] = constraints;
    for (const [key, value] of Object.entries(object)) {
      if (key === "properties" || key === "$defs") {
        for (const [name, child] of Object.entries(
          value as Record<string, unknown>,
        )) {
          step(child, `${path}/${key}/${name}`);
        }
      } else if (key === "oneOf" || key === "anyOf" || key === "allOf") {
        (value as unknown[]).forEach((child, index) =>
          step(child, `${path}/${key}/${index}`),
        );
      } else if (key === "items" || key === "not") {
        step(value, `${path}/${key}`);
      }
    }
  };

  // Walked from the file itself, not from `$defs`. Starting at the definitions
  // left the root unchecked, and the root carries the `$ref` that decides what
  // validating the bare file means: repointing json-patch.json's from JsonPatch to
  // JsonPatchOperation made it reject a valid patch array and accept a single
  // operation, with every test still green. A constraint added at the root would
  // have gone unseen too.
  step(file, "#");
  return found;
}

/** The members of the root event union, as definition names. */
export function unionMembers(): string[] {
  const event = (schema.$defs as Record<string, Record<string, unknown>>).Event;
  const oneOf = event.oneOf as Array<{ $ref: string }>;
  return oneOf.map((member) => member.$ref.replace("#/$defs/", ""));
}

/**
 * One member of an `allOf`, as something to walk.
 *
 * A member is either a reference to a definition or an inline schema. Skipping
 * the inline case — which both walkers used to do — hides its fields from the
 * very pin that exists to catch a field nobody wrote down.
 */
function resolveMember(
  member: Record<string, unknown>,
  defs: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const ref = member.$ref as string | undefined;
  if (ref === undefined) return member;
  if (!ref.startsWith("#/$defs/")) {
    throw new Error(`Composition reference outside this file: ${ref}`);
  }
  const target = defs[ref.replace("#/$defs/", "")];
  if (!target) throw new Error(`Dangling composition reference: ${ref}`);
  return target;
}

/**
 * Every property this definition makes mandatory, inherited requirements
 * included. Pinned alongside the property sets because required-ness is exactly
 * where the three SDKs disagree today, and several entries here are judgement
 * calls rather than transcriptions — a change to one should have to be argued
 * for rather than slipped in.
 */
export function effectiveRequired(
  definitionName: string,
  file: Record<string, unknown> = schema,
): string[] {
  const defs = file.$defs as Record<string, Record<string, unknown>>;
  const collected = new Set<string>();

  const walk = (def: Record<string, unknown>): void => {
    for (const name of (def.required as string[] | undefined) ?? [])
      collected.add(name);
    for (const member of (def.allOf as
      | Array<Record<string, unknown>>
      | undefined) ?? []) {
      walk(resolveMember(member, defs));
    }
  };

  const def = defs[definitionName];
  if (!def) throw new Error(`No definition named ${definitionName}`);
  walk(def);
  return [...collected].sort();
}

/**
 * Every property name a document of this definition may carry as part of the
 * contract, including the ones it inherits by composition. This is what the
 * compatibility middleware will eventually strip against, which is why the
 * suite pins it: a property missing here is a property that gets quietly
 * dropped off the wire once the SDKs are generated.
 */
export function effectiveProperties(
  definitionName: string,
  file: Record<string, unknown> = schema,
): string[] {
  const defs = file.$defs as Record<string, Record<string, unknown>>;
  const collected = new Set<string>();

  const walk = (def: Record<string, unknown>): void => {
    const properties = def.properties as Record<string, unknown> | undefined;
    for (const key of Object.keys(properties ?? {})) {
      collected.add(key);
    }
    for (const member of (def.allOf as
      | Array<Record<string, unknown>>
      | undefined) ?? []) {
      walk(resolveMember(member, defs));
    }
  };

  const def = defs[definitionName];
  if (!def) throw new Error(`No definition named ${definitionName}`);
  walk(def);
  return [...collected].sort();
}
