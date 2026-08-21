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

export const schema = JSON.parse(
  readFileSync(join(DRAFT_DIR, "schema.json"), "utf8"),
) as Record<string, unknown>;

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

/**
 * Every definition that declares `properties` — directly or through composition —
 * and therefore describes an object shape. These are the definitions the closure
 * check runs over: each either carries `unevaluatedProperties: false` or appears
 * on the documented open list.
 */
export function shapedDefinitions(): string[] {
  const defs = (schema.$defs ?? {}) as Record<string, Record<string, unknown>>;
  // Shape is what a document may carry, not the presence of one keyword. Asking
  // for a top-level `properties` would miss a definition whose fields arrive
  // only through an inline `allOf`.
  return Object.keys(defs)
    .filter((name) => effectiveProperties(name).length > 0)
    .sort();
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
 * the inline case would hide its fields from `effectiveProperties`.
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
 * included. Used by the reconciliation tool to compare the schema's judgement
 * against what each SDK requires today.
 */
export function effectiveRequired(definitionName: string): string[] {
  const defs = schema.$defs as Record<string, Record<string, unknown>>;
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
 * contract, including the ones it inherits by composition. With the objects
 * closed, this is also exactly what a document may carry at all — and what the
 * generated SDK boundaries will strip against.
 */
export function effectiveProperties(definitionName: string): string[] {
  const defs = schema.$defs as Record<string, Record<string, unknown>>;
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
