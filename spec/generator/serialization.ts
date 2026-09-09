import type { Definition, ProtocolModel, TypeExpr } from "./ir";

/** Only protocol structure is traversable. Arbitrary JSON and open maps are leaves. */
type Shape =
  | string
  | { array: Shape }
  | {
      optional: string[];
      fields: Record<string, Shape>;
    }
  | { discriminator: string; variants: Record<string, string> };

export function emitSerialization(model: ProtocolModel): string {
  const definitions = new Map(
    model.definitions.map((definition) => [definition.name, definition]),
  );
  const shapeOfType = (type: TypeExpr): Shape | undefined => {
    if (type.kind === "ref") {
      const definition = definitions.get(type.name)!;
      return definition.kind === "alias"
        ? shapeOfType(definition.type)
        : definition.kind === "enum"
          ? undefined
          : type.name;
    }
    if (type.kind === "array") {
      const items = shapeOfType(type.items);
      return items === undefined ? undefined : { array: items };
    }
    if (type.kind === "union") {
      // The inline content union is string | protocol-content-array. A scalar
      // is a leaf; the array walker only acts on arrays. Two traversable arms
      // would require a discriminator rather than guessing which fields to omit.
      const members = type.members.map((member) => ({
        type: member,
        shape: shapeOfType(member),
      }));
      const arms = members.filter((member) => member.shape !== undefined);
      const isScalar = (member: TypeExpr): boolean => {
        if (member.kind === "ref") {
          const target = definitions.get(member.name)!;
          return (
            target.kind === "enum" ||
            (target.kind === "alias" && isScalar(target.type))
          );
        }
        return [
          "string",
          "integer",
          "boolean",
          "literal",
          "stringEnum",
        ].includes(member.kind);
      };
      if (
        arms.length > 1 ||
        (arms.length === 1 &&
          (typeof arms[0].shape === "string" ||
            members.some(
              (member) => member.shape === undefined && !isScalar(member.type),
            )))
      ) {
        throw new Error(
          "Optional-null serialization requires a discriminator for structured unions",
        );
      }
      return arms[0]?.shape;
    }
    return undefined;
  };
  const shapeOfDefinition = (definition: Definition): Shape | undefined => {
    if (definition.kind === "object") {
      return {
        optional: definition.fields
          .filter((field) => !field.required)
          .map((field) => field.name),
        fields: Object.fromEntries(
          definition.fields.flatMap((field) => {
            const shape = shapeOfType(field.type);
            return shape === undefined ? [] : [[field.name, shape]];
          }),
        ),
      };
    }
    if (definition.kind === "union") {
      const discriminator = definition.discriminator;
      if (!discriminator) {
        throw new Error(
          `${definition.name}: optional-null serialization requires a discriminator`,
        );
      }
      return {
        discriminator,
        variants: Object.fromEntries(
          definition.members.map((name) => {
            const member = definitions.get(name)!;
            const field =
              member.kind === "object" &&
              member.fields.find((field) => field.name === discriminator);
            if (!field || field.type.kind !== "literal")
              throw new Error(`${name}: missing discriminator literal`);
            return [field.type.value, name];
          }),
        ),
      };
    }
    return undefined;
  };
  const shapes = Object.fromEntries(
    model.definitions.flatMap((definition) => {
      const shape = shapeOfDefinition(definition);
      return shape === undefined ? [] : [[definition.name, shape]];
    }),
  );
  return `// @generated from ${model.schemaId}. DO NOT EDIT.
// Regenerate with pnpm --filter @ag-ui/spec generate.

type Shape = string | { array: Shape } | {
  optional: string[];
  fields: Record<string, Shape>;
} | { discriminator: string; variants: Record<string, string> };

const shapes: Record<string, Shape> = ${JSON.stringify(shapes)};

function omit(value: unknown, shape: Shape): unknown {
  if (typeof shape === "string") return omit(value, shapes[shape]);
  if ("array" in shape) {
    if (!Array.isArray(value)) return value;
    const result = value.map((item) => omit(item, shape.array));
    return result.every((item, index) => item === value[index]) ? value : result;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  if ("discriminator" in shape) {
    const tag = object[shape.discriminator];
    return typeof tag === "string" && Object.prototype.hasOwnProperty.call(shape.variants, tag)
      ? omit(value, shape.variants[tag]) : value;
  }
  let result = object;
  for (const key of shape.optional) {
    if (Object.prototype.hasOwnProperty.call(object, key) && object[key] === null) {
      if (result === object) result = { ...object };
      delete result[key];
    }
  }
  for (const [key, child] of Object.entries(shape.fields)) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    const next = omit(result[key], child);
    if (next !== result[key]) {
      if (result === object) result = { ...object };
      result[key] = next;
    }
  }
  return result;
}

/**
 * Omits whole optional null fields before transmission. Does not validate,
 * mutate the input, or traverse arbitrary application JSON or unknown fields.
 * Required null payloads and null values inside opaque data remain intact.
 */
export function omitOptionalNulls<T>(value: T, root: "Event" | "RunAgentInput"): T {
  return omit(value, root) as T;
}
`;
}
