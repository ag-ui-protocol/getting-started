import { z } from "zod/v4";

/**
 * Deep-strips material a schema does not describe, without judging what it
 * does describe.
 *
 * The tolerant validators deliberately keep unknown keys so middleware can
 * see them; this is the stage after middleware, where whatever nobody handled
 * is removed and reported. Three kinds of deviation are stripped, never
 * fatal:
 *
 * - an unknown property on a described object (dropped, path reported),
 * - an unrecognised member of a discriminated union (the element is dropped
 *   from its array, or the key omitted, path reported),
 * - nothing else: a malformed VALUE on a described field is left in place for
 *   the validator to reject fatally, because inventing a reading for it would
 *   be data corruption.
 *
 * Arbitrary-JSON positions (state, metadata, rawEvent, forwardedProps, …) are
 * opaque schemas (z.any / z.custom), so their insides pass through untouched
 * — open-by-key means open.
 */
export interface StripResult<T> {
  value: T;
  /** JSON-pointer-ish paths of everything removed, for the deviation log. */
  stripped: string[];
}

/** Marks "this whole value is unrecognisable here" while unwinding. */
const DROP = Symbol("agui.strip.drop");

function unwrap(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  for (;;) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodCatch
    ) {
      current = (current as { unwrap(): unknown }).unwrap() as z.ZodType;
      continue;
    }
    // A pipe's INPUT side is the shape the wire data has; the output side
    // describes what the parse produces, which is not what is being stripped.
    if (current instanceof z.ZodPipe) {
      current = (current as unknown as { def: { in: z.ZodType } }).def.in;
      continue;
    }
    if (current instanceof z.ZodLazy) {
      current = (current as unknown as { def: { getter(): z.ZodType } }).def.getter();
      continue;
    }
    return current;
  }
}

function discriminatorOf(schema: z.ZodType): string | undefined {
  const def = (schema as { def?: { discriminator?: unknown } }).def;
  return typeof def?.discriminator === "string" ? def.discriminator : undefined;
}

/**
 * The single value a literal schema admits, read from `def.values` — the one
 * surface that is an array on every zod that ships `zod/v4`. The instance-level
 * `.values` is a Set on all of them, and the `.value` convenience getter only
 * exists from zod 3.25.7x on: a consumer holding an older copy of zod 3.25 (the
 * declared peer floor is 3.25.18) has literals with no `.value` at all, and a
 * reader that leaned on it silently keyed every event schema under
 * "undefined". Exported for enforce.ts, which builds its per-type map with it.
 */
export function literalValue(schema: z.ZodType): unknown {
  const probe = schema as unknown as {
    def?: { values?: unknown[] };
    values?: Iterable<unknown>;
    value?: unknown;
  };
  const values = Array.isArray(probe.def?.values)
    ? probe.def.values
    : probe.values
      ? Array.from(probe.values)
      : undefined;
  if (values && values.length === 1) return values[0];
  return probe.value;
}

function literalValueOf(schema: z.ZodType): unknown {
  const unwrapped = unwrap(schema);
  return unwrapped instanceof z.ZodLiteral ? literalValue(unwrapped) : undefined;
}

function stripAgainst(
  value: unknown,
  schema: z.ZodType,
  path: string,
  stripped: string[],
): unknown {
  const target = unwrap(schema);

  if (target instanceof z.ZodObject) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value; // wrong shape: the validator's to reject, fatally
    }
    const shape = target.shape as Record<string, z.ZodType>;
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    // Every generated object is a looseObject, because the layers below
    // enforcement have to see unknown keys to translate them. That tolerance is
    // not the same as the SPEC leaving an object open, and only the schema can
    // tell the two apart, so the generator marks the ones it really does leave
    // open. Today those are the RFC 6902 operations, which the RFC requires to
    // ignore members they do not define rather than reject them: a remove
    // carrying a leftover value is a valid patch, and removing that member
    // while warning about it deletes conformant data and cries wolf.
    const specOpen =
      (target.meta() as { specOpen?: boolean } | undefined)?.specOpen === true;
    for (const key of Object.keys(record)) {
      // OWN property, not a plain `shape[key]`. The keys iterated here are the
      // PRODUCER's, and property access on a plain object walks the prototype
      // chain: `shape["toString"]` answers with `Object.prototype.toString` —
      // a function, not `undefined` — so a producer key named `toString`,
      // `constructor`, `valueOf` or `hasOwnProperty` read as a field the
      // schema describes. It was then left in place and reported nowhere, and
      // an unrecognised property reached verification, subscribers and
      // application code in silence. Both halves of the guarantee at once.
      const field = Object.prototype.hasOwnProperty.call(shape, key)
        ? shape[key]
        : undefined;
      if (field === undefined) {
        if (specOpen) {
          result[key] = record[key];
          continue;
        }
        stripped.push(`${path}/${key}`);
        continue;
      }
      // Where the report stood before the descent. Anything the descent named
      // sits INSIDE this child, so if the child is dropped whole those paths
      // describe removals that never happened on their own — the enforcement
      // stage warns once per path, and would send an operator looking for a
      // key that was never the reason for anything.
      const mark = stripped.length;
      const child = stripAgainst(record[key], field, `${path}/${key}`, stripped);
      if (child === DROP) {
        stripped.length = mark;
        // An unrecognisable value in an OPTIONAL position is removable; in a
        // REQUIRED position the whole containing object is unrecognisable,
        // and the drop cascades — so a media part with a future source kind
        // removes the part, never leaving a sourceless part behind for the
        // validator to reject fatally.
        if (field.safeParse(undefined).success) {
          stripped.push(`${path}/${key}`);
          continue;
        }
        return DROP;
      }
      result[key] = child;
    }
    return result;
  }

  if (target instanceof z.ZodArray) {
    if (!Array.isArray(value)) return value;
    const element = target.element as z.ZodType;
    const result: unknown[] = [];
    value.forEach((entry, index) => {
      const mark = stripped.length;
      const child = stripAgainst(entry, element, `${path}/${index}`, stripped);
      if (child === DROP) {
        // The element goes whole, so the paths its descent named go with it.
        stripped.length = mark;
        stripped.push(`${path}/${index}`);
        return;
      }
      result.push(child);
    });
    return result;
  }

  if (target instanceof z.ZodRecord) {
    // A record describes every key, so no key here is ever "unrecognised" —
    // only a value can be, and it is removable exactly as an array element is.
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const valueType = (target as unknown as { def: { valueType: z.ZodType } }).def.valueType;
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const mark = stripped.length;
      const child = stripAgainst(record[key], valueType, `${path}/${key}`, stripped);
      if (child === DROP) {
        stripped.length = mark;
        stripped.push(`${path}/${key}`);
        continue;
      }
      result[key] = child;
    }
    return result;
  }

  if (target instanceof z.ZodUnion) {
    const options = target.options as z.ZodType[];
    const discriminator = discriminatorOf(target);
    if (discriminator !== undefined) {
      // Array.isArray, not just `typeof`: an array IS an "object", so without
      // this an array in a union slot reads its discriminator as undefined,
      // matches nothing, and is reported as removable — silently turning a
      // stream the validator would have rejected into a successful run with
      // the field quietly gone. It is a malformed VALUE on a described field,
      // which is the one deviation that stays fatal.
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      const tag = (value as Record<string, unknown>)[discriminator];
      for (const option of options) {
        const unwrapped = unwrap(option);
        if (!(unwrapped instanceof z.ZodObject)) continue;
        const shape = unwrapped.shape as Record<string, z.ZodType>;
        if (literalValueOf(shape[discriminator]) === tag) {
          return stripAgainst(value, option, path, stripped);
        }
      }
      // An unrecognised union member: removable, never fatal.
      return DROP;
    }
    // A structural union (e.g. string | array): recurse into the option whose
    // basic kind matches; if none does, the validator rejects fatally.
    //
    // With two or more OBJECT options there is no tag to read, so "basic kind"
    // picks whichever is listed first and then reports the other option's own
    // keys as unrecognised material — stripping exactly the fields that made
    // the value valid. Nothing generated has this shape today; leaving it
    // untouched hands the choice to the validator, which can actually make it.
    const objectOptions = options.filter((option) => unwrap(option) instanceof z.ZodObject);
    const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value);
    if (objectOptions.length > 1 && isPlainObject) return value;
    for (const option of options) {
      const unwrapped = unwrap(option);
      if (unwrapped instanceof z.ZodArray && Array.isArray(value)) {
        return stripAgainst(value, option, path, stripped);
      }
      if (unwrapped instanceof z.ZodObject && isPlainObject) {
        return stripAgainst(value, option, path, stripped);
      }
    }
    return value;
  }

  // Leaves (strings, numbers, enums, literals) and opaque schemas
  // (z.any, z.custom — the arbitrary-JSON positions) pass through whole.
  return value;
}

/** Deep-strips `value` against `schema`; see the module comment. */
export function stripUnknown<T>(value: T, schema: z.ZodType): StripResult<T> {
  const stripped: string[] = [];
  const result = stripAgainst(value, schema, "", stripped);
  if (result === DROP) {
    // Nothing generated can reach this: a required union member always sits
    // inside an array, whose element drop absorbs it. If a schema ever makes
    // the whole value unrecognisable, there is no honest answer to return —
    // handing back the untouched original alongside a list of removals would
    // describe a value the caller is not holding. So it is loud instead.
    throw new Error(
      "Internal error: the stripper found the whole value unrecognisable, which the schemas are not supposed to allow — schema/stripper mismatch.",
    );
  }
  return { value: result as T, stripped };
}
