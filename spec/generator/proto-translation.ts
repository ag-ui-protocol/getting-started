/**
 * Emits the TypeScript translation layer between AG-UI JSON events and the
 * protobuf wire messages: sdks/typescript/packages/proto/src/proto.ts.
 *
 * The translation is mechanical — ts-proto's camelCase field names equal the
 * JSON wire names for every field that maps one-to-one, so the generic path
 * is a spread, and only the wire-shape deviations (the merged Message, the
 * flattened outcomes, the tagged patch operations, repeated fields that are
 * optional in JSON) get generated code, derived from the same wire model that
 * emitted the .proto files. The one block that is not schema-derived is the
 * legacy "binary" content-part mapping, kept verbatim as documented
 * compatibility behaviour.
 */

import type { Definition, Field, ObjectDefinition, TypeExpr } from "./ir";
import { buildScanGraph } from "./protobuf";
import type { WireModel } from "./protobuf";

function resolveAlias(defs: Map<string, Definition>, type: TypeExpr): TypeExpr {
  while (type.kind === "ref") {
    const target = defs.get(type.name);
    if (target?.kind !== "alias") return type;
    type = target.type;
  }
  return type;
}

/** The event's EventType value, from its narrowed `type` field. */
function eventTypeOf(definition: ObjectDefinition): string {
  const typeField = definition.fields.find((field) => field.name === "type");
  if (typeField?.type.kind !== "literal") {
    throw new Error(`${definition.name} has no literal type`);
  }
  return typeField.type.value;
}

export function emitProtoTranslation(wire: WireModel): string {
  const { defs, model } = wire;
  const objectDef = (name: string): ObjectDefinition => {
    const definition = defs.get(name);
    if (definition?.kind !== "object")
      throw new Error(`${name} is not an object`);
    return definition;
  };
  const eventUnion = defs.get("Event");
  if (eventUnion?.kind !== "union") throw new Error("Event union missing");
  const events = eventUnion.members.map(objectDef);
  const baseNames = new Set(wire.baseFieldNames);

  /* ---------------- content parts ---------------- */

  const contentUnion = defs.get("InputContent");
  if (contentUnion?.kind !== "union") throw new Error("InputContent missing");
  const partEntries = contentUnion.members.map((memberName) => {
    const member = objectDef(memberName);
    const discriminator = member.fields.find(
      (field) => field.name === contentUnion.discriminator,
    );
    if (discriminator?.type.kind !== "literal")
      throw new Error("part discriminator");
    const payload = member.fields.filter(
      (field) => field.name !== contentUnion.discriminator,
    );
    return { entry: discriminator.type.value, payload };
  });

  const sourceUnion = defs.get("InputContentSource");
  if (sourceUnion?.kind !== "union")
    throw new Error("InputContentSource missing");
  const sourceEntries = sourceUnion.members.map((memberName) => {
    const member = objectDef(memberName);
    const discriminator = member.fields.find(
      (field) => field.name === sourceUnion.discriminator,
    );
    if (discriminator?.type.kind !== "literal")
      throw new Error("source discriminator");
    const payload = member.fields
      .filter((field) => field.name !== sourceUnion.discriminator)
      .map((field) => field.name);
    return { entry: discriminator.type.value, payload };
  });

  const toPartCase = (entry: { entry: string; payload: Field[] }): string => {
    const fields = entry.payload
      .map((field) => {
        const resolved = resolveAlias(defs, field.type);
        if (resolved.kind === "ref" && resolved.name === "InputContentSource") {
          return `${field.name}: toProtoSource(rec.${field.name})`;
        }
        return `${field.name}: rec.${field.name}`;
      })
      .join(", ");
    return `    case ${JSON.stringify(entry.entry)}:\n      return { ${entry.entry}: { ${fields} } };`;
  };

  const fromPartCase = (entry: { entry: string; payload: Field[] }): string => {
    const fields = entry.payload
      .map((field) => {
        const resolved = resolveAlias(defs, field.type);
        if (resolved.kind === "ref" && resolved.name === "InputContentSource") {
          return `${field.name}: fromProtoSource(part.${field.name})`;
        }
        return `${field.name}: part.${field.name}`;
      })
      .join(", ");
    return `  if (rec.${entry.entry}) {\n    const part = rec.${entry.entry} as LooseRecord;\n    return { type: ${JSON.stringify(entry.entry)}, ${fields} };\n  }`;
  };

  /* ---------------- merged Message ---------------- */

  const messageUnion = defs.get("Message");
  if (messageUnion?.kind !== "union") throw new Error("Message union missing");
  // role value -> how its content field rides the wire
  const contentModes = messageUnion.members.map((memberName) => {
    const member = objectDef(memberName);
    const role = member.fields.find(
      (field) => field.name === messageUnion.discriminator,
    );
    if (role?.type.kind !== "literal") throw new Error("message discriminator");
    const content = member.fields.find((field) => field.name === "content");
    const mode =
      content === undefined
        ? "none"
        : content.type.kind === "union"
          ? "stringOrParts"
          : content.type.kind === "openMap"
            ? "map"
            : "string";
    return { role: role.type.value, mode };
  });
  const mapModeRoles = contentModes
    .filter((entry) => entry.mode === "map")
    .map((entry) => entry.role);
  const partsModeRoles = contentModes
    .filter((entry) => entry.mode === "stringOrParts")
    .map((entry) => entry.role);

  /* ---------------- per-event wire deviations ---------------- */

  interface FlattenSpec {
    eventType: string;
    jsonField: string;
    cases: Array<{ value: string; payload: Field[] }>;
  }
  const flattenSpecs: FlattenSpec[] = [];
  const patchFields: Array<{ eventType: string; jsonField: string }> = [];
  const optionalArrays: Array<{ eventType: string; jsonField: string }> = [];
  const nestedInputs: Array<{
    eventType: string;
    jsonField: string;
    def: string;
  }> = [];

  for (const event of events) {
    const type = eventTypeOf(event);
    for (const field of event.fields) {
      if (baseNames.has(field.name)) continue;
      const resolved =
        field.type.kind === "ref" ? defs.get(field.type.name) : undefined;
      if (resolved?.kind === "union") {
        flattenSpecs.push({
          eventType: type,
          jsonField: field.name,
          cases: resolved.members.map((memberName) => {
            const member = objectDef(memberName);
            const discriminator = member.fields.find(
              (entry) => entry.name === resolved.discriminator,
            );
            if (discriminator?.type.kind !== "literal") {
              throw new Error(`${memberName} discriminator`);
            }
            return {
              value: discriminator.type.value,
              payload: member.fields.filter(
                (entry) => entry.name !== resolved.discriminator,
              ),
            };
          }),
        });
        continue;
      }
      const aliased = resolveAlias(defs, field.type);
      const arrayType =
        field.type.kind === "array"
          ? field.type
          : aliased.kind === "array"
            ? aliased
            : field.type.kind === "ref" &&
                defs.get(field.type.name)?.kind === "alias" &&
                (defs.get(field.type.name) as { type: TypeExpr }).type.kind ===
                  "array"
              ? ((defs.get(field.type.name) as { type: TypeExpr })
                  .type as TypeExpr & {
                  kind: "array";
                })
              : undefined;
      if (arrayType && arrayType.kind === "array") {
        const items = arrayType.items;
        const itemsDef =
          items.kind === "ref" ? defs.get(items.name) : undefined;
        if (itemsDef?.name === "JsonPatchOperation") {
          patchFields.push({ eventType: type, jsonField: field.name });
        }
        if (!field.required) {
          optionalArrays.push({ eventType: type, jsonField: field.name });
        }
        continue;
      }
      if (
        resolved?.kind === "object" &&
        !["Interrupt", "TokenUsage"].includes(resolved.name) &&
        resolved.fields.some((entry) => {
          const inner = resolveAlias(defs, entry.type);
          return (
            inner.kind === "array" &&
            inner.items.kind === "ref" &&
            defs.get(inner.items.name)?.kind === "union"
          );
        })
      ) {
        nestedInputs.push({
          eventType: type,
          jsonField: field.name,
          def: resolved.name,
        });
      }
    }
  }

  const inputDefs = [...new Set(nestedInputs.map((entry) => entry.def))].map(
    objectDef,
  );

  const inputConverter = (definition: ObjectDefinition): string => {
    const to: string[] = [];
    const from: string[] = [];
    for (const field of definition.fields) {
      const aliased = resolveAlias(defs, field.type);
      if (aliased.kind === "array") {
        const items = aliased.items;
        const itemDef = items.kind === "ref" ? defs.get(items.name) : undefined;
        const mapper =
          itemDef?.kind === "union"
            ? "toWireMessage"
            : itemDef?.kind === "object" &&
                itemDef.fields.some((entry) => entry.name === "metadata")
              ? "normalizeItemMetadata"
              : undefined;
        const encodeExpr = mapper
          ? `asArray(input.${field.name}).map(${mapper})`
          : `asArray(input.${field.name})`;
        to.push(`    ${field.name}: ${encodeExpr},`);
        const decodeMapper =
          itemDef?.kind === "union" ? ".map(fromWireMessage)" : "";
        // Always present on decode, empty included: the wire cannot tell an
        // absent array from an empty one, and present-empty is the one form
        // every layer accepts (the handwritten input schema requires the keys).
        from.push(
          `  output.${field.name} = asArray(rec.${field.name})${decodeMapper};`,
        );
        continue;
      }
      to.push(`    ${field.name}: input.${field.name},`);
      from.push(
        `  if (rec.${field.name} !== undefined) output.${field.name} = rec.${field.name};`,
      );
    }
    return `
const toWire${definition.name} = (value: unknown): LooseRecord | undefined => {
  const input = asRecord(value);
  if (!input) return undefined;
  return {
${to.join("\n")}
  };
};

const fromWire${definition.name} = (value: unknown): LooseRecord | undefined => {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const output: LooseRecord = {};
${from.join("\n")}
  return output;
};
`;
  };

  /* ---------------- encode/decode special-case blocks ---------------- */

  const messagesSnapshotType = events.find((event) =>
    event.fields.some((field) => {
      const aliased = resolveAlias(defs, field.type);
      return (
        aliased.kind === "array" &&
        aliased.items.kind === "ref" &&
        aliased.items.name === "Message"
      );
    }),
  );

  const encodeCases: string[] = [];
  const decodeCases: string[] = [];

  if (messagesSnapshotType) {
    const type = eventTypeOf(messagesSnapshotType);
    encodeCases.push(`  if (type === ${JSON.stringify(type)} && Array.isArray(rest.messages)) {
    rest.messages = rest.messages.map(toWireMessage);
  }`);
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(type)} && Array.isArray(decoded.messages)) {
    decoded.messages = (decoded.messages as unknown[]).map(fromWireMessage);
  }`);
  }

  for (const spec of flattenSpecs) {
    const payloadNames = [
      ...new Set(
        spec.cases.flatMap((entry) => entry.payload.map((f) => f.name)),
      ),
    ];
    const clear = payloadNames
      .map((name) => `    rest.${name} = [];`)
      .join("\n");
    const branches = spec.cases
      .map((entry) => {
        const assign = entry.payload
          .map(
            (field) =>
              `      rest.${field.name} = asArray(outcomeRecord?.${field.name});`,
          )
          .join("\n");
        return `    } else if (outcomeRecord?.type === ${JSON.stringify(entry.value)}) {
      rest.${spec.jsonField} = ${JSON.stringify(entry.value)};
${assign}`;
      })
      .join("\n");
    encodeCases.push(`  if (type === ${JSON.stringify(spec.eventType)}) {
    const outcomeRecord = asRecord(rest.${spec.jsonField});
${clear}
    if (rest.${spec.jsonField} === undefined) {
      rest.${spec.jsonField} = "";
${branches}
    } else {
      rest.${spec.jsonField} =
        typeof outcomeRecord?.type === "string" ? outcomeRecord.type : "";
    }
  }`);

    const rebuild = spec.cases
      .map((entry) => {
        const pairs = entry.payload
          .map((field) =>
            field.required
              ? `, ${field.name}: asArray(payload.${field.name})`
              : `, ...(asArray(payload.${field.name}).length > 0 ? { ${field.name}: payload.${field.name} } : {})`,
          )
          .join("");
        // Payload that belongs to a different case is a contradiction — a
        // success carrying interrupts would finish the run with one pending —
        // so it rejects rather than silently vanishing.
        const ownNames = new Set(entry.payload.map((field) => field.name));
        const foreign = [
          ...new Set(
            spec.cases.flatMap((other) =>
              other.payload
                .map((field) => field.name)
                .filter((name) => !ownNames.has(name)),
            ),
          ),
        ];
        const foreignChecks = foreign
          .map(
            (name) => `
      if (asArray(payload.${name}).length > 0) {
        throw new Error("Invalid event: ${spec.jsonField} ${entry.value} cannot carry ${name}");
      }`,
          )
          .join("");
        return `    if (wireOutcome === ${JSON.stringify(entry.value)}) {${foreignChecks}
      record.${spec.jsonField} = { type: ${JSON.stringify(entry.value)}${pairs} };
    }`;
      })
      .join("\n");
    const allPayloadNames = [
      ...new Set(
        spec.cases.flatMap((entry) => entry.payload.map((f) => f.name)),
      ),
    ];
    const absentChecks = allPayloadNames
      .map(
        (name) => `
      if (asArray(payload.${name}).length > 0) {
        throw new Error("Invalid event: absent ${spec.jsonField} cannot carry ${name}");
      }`,
      )
      .join("");
    const knownValues = spec.cases.map((entry) => entry.value);
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(spec.eventType)}) {
    const record = decoded as LooseRecord;
    const wireOutcome =
      typeof record.${spec.jsonField} === "string" && record.${spec.jsonField} !== ""
        ? (record.${spec.jsonField} as string)
        : undefined;
    // An unknown discriminator must not silently decode to "no ${spec.jsonField}",
    // which would imply success; the JSON path errors on it, so this does too.
    if (wireOutcome !== undefined && !${JSON.stringify(knownValues)}.includes(wireOutcome)) {
      throw new Error("Invalid event: unknown ${spec.jsonField} " + wireOutcome);
    }
    const payload: LooseRecord = {};
${payloadNames.map((name) => `    payload.${name} = record.${name};\n    delete record.${name};`).join("\n")}
    delete record.${spec.jsonField};
    if (wireOutcome === undefined) {${absentChecks}
    }
${rebuild}
  }`);
  }

  for (const entry of patchFields) {
    encodeCases.push(`  if (type === ${JSON.stringify(entry.eventType)} && Array.isArray(rest.${entry.jsonField})) {
    rest.${entry.jsonField} = (rest.${entry.jsonField} as LooseRecord[]).map((operation) => ({
      ...operation,
      // Cast, not coercion: String(op) would turn malformed values such as
      // ["add"] into a valid enum member, where this throws instead.
      op: protoPatch.JsonPatchOperationType[
        (operation.op as string).toUpperCase() as keyof typeof protoPatch.JsonPatchOperationType
      ],
    }));
  }`);
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(entry.eventType)} && Array.isArray(decoded.${entry.jsonField})) {
    for (const operation of decoded.${entry.jsonField} as LooseRecord[]) {
      const opName =
        protoPatch.JsonPatchOperationType[
          operation.op as protoPatch.JsonPatchOperationType
        ];
      // A wire value outside the enum must not invent an operation.
      if (typeof opName !== "string" || opName === "UNRECOGNIZED") {
        throw new Error("Invalid event: unknown patch operation");
      }
      operation.op = opName.toLowerCase();
      Object.keys(operation).forEach((key) => {
        if (operation[key] === undefined) {
          delete operation[key];
        }
      });
    }
  }`);
  }

  const flattenedFields = new Set(
    flattenSpecs.map((spec) => `${spec.eventType}.${spec.jsonField}`),
  );
  const arrayNormalizations = optionalArrays.filter(
    (entry) => !flattenedFields.has(`${entry.eventType}.${entry.jsonField}`),
  );
  for (const entry of arrayNormalizations) {
    encodeCases.push(`  if (type === ${JSON.stringify(entry.eventType)}) {
    rest.${entry.jsonField} = asArray(rest.${entry.jsonField});
  }`);
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(entry.eventType)}) {
    if (Array.isArray(decoded.${entry.jsonField}) && decoded.${entry.jsonField}.length === 0) {
      delete decoded.${entry.jsonField};
    }
  }`);
  }

  for (const entry of nestedInputs) {
    encodeCases.push(`  if (type === ${JSON.stringify(entry.eventType)} && rest.${entry.jsonField} !== undefined) {
    rest.${entry.jsonField} = toWire${entry.def}(rest.${entry.jsonField});
  }`);
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(entry.eventType)} && decoded.${entry.jsonField} !== undefined) {
    decoded.${entry.jsonField} = fromWire${entry.def}(decoded.${entry.jsonField});
  }`);
  }

  /* ---------------- the file ---------------- */

  const eventMessage = wire.messages.find(
    (message) => message.name === "Event",
  );
  const envelopeTagNumbers = (eventMessage?.oneof?.entries ?? [])
    .map((entry) => entry.number)
    .join(", ");

  // The malformed-wire scan tables, from the shared scan graph: canonical
  // protobuf parsers MERGE a repeated occurrence of a singular message-typed
  // field where ts-proto REPLACES it, and a oneof carrying several distinct
  // arms materialises differently across runtimes too. Both reject.
  const scanGraph = buildScanGraph(wire);
  const scanSpecEntries = scanGraph.specs
    .map((spec) => {
      const arms = spec.arms
        ? `, arms: new Set([${spec.arms.numbers.join(", ")}])`
        : "";
      const descend = spec.descend
        .map((entry) => `${entry.number}: ${JSON.stringify(entry.child)}`)
        .join(", ");
      return `  ${spec.name}: { singular: new Set([${spec.singular.join(
        ", ",
      )}]), descend: { ${descend} }${arms} },`;
    })
    .join("\n");
  const envelopeScanEntries = scanGraph.envelope
    .map((entry) => `  ${entry.number}: ${JSON.stringify(entry.child)},`)
    .join("\n");

  const envelopeTypeEntries = wire.envelope
    .map((entry) => {
      const definition = objectDef(entry.definition);
      const key = entry.entry.replace(/_([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      );
      return `  ${key}: ${JSON.stringify(eventTypeOf(definition))},`;
    })
    .join("\n");

  return `// @generated by spec/generator — DO NOT EDIT.
// Source: ${model.schemaId}
// Regenerate: pnpm --filter @ag-ui/spec generate

import { BaseEvent, AGUIEvent, EventSchemas, EventType } from "@ag-ui/core";
import * as protoEvents from "./generated/events";
import * as protoPatch from "./generated/patch";

/**
 * These converters run against values that have crossed a wire boundary, so
 * they accept \`unknown\` and narrow once rather than trusting a static type.
 */
type LooseRecord = Record<string, unknown>;

const asRecord = (value: unknown): LooseRecord | undefined =>
  value && typeof value === "object" ? (value as LooseRecord) : undefined;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

function toCamelCase(str: string): string {
  return str.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * The event types the handwritten SDK models know. The schema — and this
 * generated wire layer — can be ahead of them; an event outside this set is
 * carried structurally and validated once the SDK catches up.
 */
const KNOWN_TO_CORE = new Set<string>(Object.values(EventType));

/**
 * The envelope's oneof entry names, mapped to the event type each carries.
 * The entry selected the message shape, so it is authoritative on decode.
 */
const ENVELOPE_TYPE: Record<string, string | undefined> = {
${envelopeTypeEntries}
};
/** The envelope's known field numbers, for the repeated-tag scan. */
const ENVELOPE_TAGS = new Set<number>([${envelopeTagNumbers}]);

/**
 * Narrows metadata to the object the wire format declares, or nothing.
 *
 * On the validated path the schema has already guaranteed this. On the fallback
 * path below the event is unvalidated, and the generated \`Struct.wrap\` would
 * quietly mangle anything else — an array becomes \`{"0": …}\`, a string becomes
 * per-character keys, a number becomes \`{}\`. Dropping the value is the honest
 * outcome for a shim whose contract is to warn and encode best-effort; the
 * caller already gets a loud warning naming the validation failure.
 */
const normalizeMetadata = (metadata: unknown): LooseRecord | undefined =>
  typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as LooseRecord)
    : undefined;

const toProtoSource = (source: unknown): unknown => {
  const rec = asRecord(source);
  if (!rec) return undefined;
${sourceEntries
  .map(
    (entry) => `  if (rec.type === ${JSON.stringify(entry.entry)}) {
    return { ${entry.entry}: { ${entry.payload.map((name) => `${name}: rec.${name}`).join(", ")} } };
  }`,
  )
  .join("\n")}
  return undefined;
};

const fromProtoSource = (source: unknown): unknown => {
  const rec = asRecord(source);
  if (!rec) return undefined;
  // Exactly one populated arm: a source carrying several is malformed, and
  // picking one would silently discard the rest.
  if ([${sourceEntries.map((entry) => `rec.${entry.entry}`).join(", ")}].filter(Boolean).length > 1) {
    throw new Error("Invalid event: source carries more than one arm");
  }
${sourceEntries
  .map(
    (entry) => `  if (rec.${entry.entry}) {
    const wire = rec.${entry.entry} as LooseRecord;
    return { type: ${JSON.stringify(entry.entry)}, ${entry.payload.map((name) => `${name}: wire.${name}`).join(", ")} };
  }`,
  )
  .join("\n")}
  return undefined;
};

const toProtoContentPart = (part: unknown): unknown => {
  const rec = asRecord(part);
  if (!rec) return undefined;

  switch (rec.type) {
${partEntries.map(toPartCase).join("\n")}
    // Legacy compatibility, predating the schema: the retired "binary" part
    // rides as a document part with marker metadata. Behavioural rule of this
    // layer, not a schema fact.
    case "binary": {
      const source = rec.data
        ? { data: { value: rec.data, mimeType: rec.mimeType } }
        : rec.url
          ? { url: { value: rec.url, mimeType: rec.mimeType } }
          : rec.id
            ? { url: { value: rec.id, mimeType: rec.mimeType } }
            : undefined;
      if (!source) return undefined;
      return {
        document: {
          source,
          metadata: { legacyBinary: true, filename: rec.filename, id: rec.id },
        },
      };
    }
    default:
      return undefined;
  }
};

const fromProtoContentPart = (part: unknown): unknown => {
  const rec = asRecord(part);
  if (!rec) return undefined;
  // Exactly one populated arm, as with the source above.
  if ([${partEntries.map((entry) => `rec.${entry.entry}`).join(", ")}].filter(Boolean).length > 1) {
    throw new Error("Invalid event: content part carries more than one arm");
  }
${partEntries.map(fromPartCase).join("\n")}
  return undefined;
};

/**
 * The wire's one Message carries the union of every role's fields; which
 * field feeds \`content\` depends on the role.
 */
const MAP_CONTENT_ROLES = new Set<string>(${JSON.stringify(mapModeRoles)});
const PARTS_CONTENT_ROLES = new Set<string>(${JSON.stringify(partsModeRoles)});

const toWireMessage = (value: unknown): LooseRecord => {
  const message = asRecord(value) ?? {};
  const wire: LooseRecord = { ...message, contentParts: [] };
  wire.metadata = normalizeMetadata(message.metadata);
  wire.toolCalls = asArray(message.toolCalls).map((toolCall: unknown) => ({
    ...(toolCall as LooseRecord),
    metadata: normalizeMetadata(asRecord(toolCall)?.metadata),
  }));
  if (Array.isArray(message.content)) {
    wire.contentParts = message.content
      .map((part: unknown) => toProtoContentPart(part))
      .filter((part: unknown) => part !== undefined);
    wire.content = undefined;
  } else if (
    typeof message.role === "string" &&
    MAP_CONTENT_ROLES.has(message.role)
  ) {
    wire.activityContent = normalizeMetadata(message.content) ?? {};
    wire.content = undefined;
  }
  return wire;
};

const fromWireMessage = (value: unknown): LooseRecord => {
  const wire = asRecord(value) ?? {};
  const message: LooseRecord = { ...wire };
  const role = typeof wire.role === "string" ? wire.role : "";
  // Content carriers are role-exclusive; a message carrying a carrier its
  // role does not use would lose data whichever one decode preferred.
  if (
    !PARTS_CONTENT_ROLES.has(role) &&
    asArray(wire.contentParts).length > 0
  ) {
    throw new Error(
      "Invalid event: message carries content parts for a role that has none",
    );
  }
  if (wire.activityContent !== undefined && !MAP_CONTENT_ROLES.has(role)) {
    throw new Error(
      "Invalid event: message carries activity content for a non-activity role",
    );
  }
  if (MAP_CONTENT_ROLES.has(role) && wire.content !== undefined) {
    throw new Error(
      "Invalid event: activity content cannot ride with other content forms",
    );
  }
  if (
    PARTS_CONTENT_ROLES.has(role) &&
    wire.content !== undefined &&
    asArray(wire.contentParts).length > 0
  ) {
    // String content and parts together is a contradiction the encoder never
    // writes; resolving it either way would silently discard the other half.
    throw new Error(
      "Invalid event: message carries both string content and content parts",
    );
  }
  if (PARTS_CONTENT_ROLES.has(role) && wire.content === undefined) {
    // String content rides the content field; anything else is the parts
    // array — including an empty one, which is valid content of its own. A
    // part with no recognisable arm is rejected, not erased: the JSON path
    // rejects an unknown part type too, and a vanishing image changes what
    // the message says.
    message.content = asArray(wire.contentParts).map((part: unknown) => {
      const converted = fromProtoContentPart(part);
      if (converted === undefined) {
        throw new Error("Invalid event: unreadable content part");
      }
      return converted;
    });
  }
  if (MAP_CONTENT_ROLES.has(role) && wire.activityContent !== undefined) {
    message.content = wire.activityContent;
  }
  delete message.activityContent;
  delete message.contentParts;
  if (asArray(wire.toolCalls).length === 0) {
    delete message.toolCalls;
  }
  Object.keys(message).forEach((key) => {
    if (message[key] === undefined) delete message[key];
  });
  return message;
};

/**
 * ts-proto materialises absent optional fields as undefined-valued keys, on
 * nested objects too. An absent field stays absent: the keys go.
 */
const dropUndefinedDeep = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const entry of value) dropUndefinedDeep(entry);
    return;
  }
  const rec = asRecord(value);
  if (!rec) return;
  for (const key of Object.keys(rec)) {
    if (rec[key] === undefined) {
      delete rec[key];
    } else {
      dropUndefinedDeep(rec[key]);
    }
  }
};

const normalizeItemMetadata = (value: unknown): LooseRecord => ({
  ...(asRecord(value) ?? {}),
  metadata: normalizeMetadata(asRecord(value)?.metadata),
});
${inputDefs.map(inputConverter).join("\n")}
/**
 * Encodes an event to the protobuf wire format.
 */
export function encode(event: BaseEvent): Uint8Array {
  // Events the handwritten SDK knows are validated, with a warning and a
  // best-effort fallback for malformed ones — existing clients encoding
  // invalid events keep working, loudly. Events the SDK does not know yet
  // (the schema can be ahead of it) are carried structurally.
  let validatedEvent: AGUIEvent | BaseEvent = event;
  if (KNOWN_TO_CORE.has(event.type as string)) {
    try {
      validatedEvent = EventSchemas.parse(event) as AGUIEvent;
    } catch (err) {
      console.warn(
        "[ag-ui][proto.encode] Malformed event detected, falling back to unvalidated event",
        err,
        event,
      );
      validatedEvent = event;
    }
  }
  const oneofField = toCamelCase(validatedEvent.type as string);
  const { type, timestamp, rawEvent, metadata, ...rest } =
    validatedEvent as unknown as LooseRecord;

${encodeCases.join("\n")}

  const eventMessage = {
    [oneofField]: {
      baseEvent: {
        type: protoEvents.EventType[event.type as keyof typeof protoEvents.EventType],
        timestamp,
        rawEvent,
        metadata: normalizeMetadata(metadata),
      },
      ...rest,
    },
  };
  return protoEvents.Event.encode(eventMessage).finish();
}

/**
 * Decodes the protobuf wire format to an event.
 */
/**
 * One message level of the malformed-wire scan: which singular message-typed
 * fields may not repeat (canonical protobuf merges them, ts-proto — this
 * runtime — replaces), which fields to descend into, and which oneof arms
 * are mutually exclusive. google.protobuf.* payloads are counted but not
 * entered: their insides belong to the runtime library, a recorded boundary.
 */
interface ScanSpec {
  singular: Set<number>;
  descend: Record<number, string | undefined>;
  arms?: Set<number>;
}

const SCAN_SPECS: Record<string, ScanSpec | undefined> = {
${scanSpecEntries}
};

/** Envelope entry number -> event message name, all descended into. */
const ENVELOPE_SCAN: Record<number, string | undefined> = {
${envelopeScanEntries}
};

// Mirrors the wire reader's uint32 truncation exactly: the fifth byte
// contributes only its low four bits, later bytes none — otherwise an
// overlong encoding of a tag would dodge duplicate detection while the
// real decoder still reads the canonical field number.
function readVarint(data: Uint8Array, cursor: { offset: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (cursor.offset >= data.length) throw new Error("Invalid event");
    const byte = data[cursor.offset++];
    if (shift < 28) result += (byte & 0x7f) * 2 ** shift;
    else if (shift === 28) result += (byte & 0x0f) * 2 ** 28;
    shift += 7;
    if ((byte & 0x80) === 0) return result;
  }
}

/** Walks one message level of the scan graph, recursing along descend edges. */
function scanMessage(data: Uint8Array, spec: ScanSpec): void {
  const cursor = { offset: 0 };
  let groupDepth = 0;
  const seenSingular = new Set<number>();
  let seenArm = 0;
  while (cursor.offset < data.length) {
    const tag = readVarint(data, cursor);
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (field === 0) {
      throw new Error("Invalid event");
    }
    if (wireType === 3) {
      groupDepth += 1;
      continue;
    }
    if (wireType === 4) {
      groupDepth -= 1;
      if (groupDepth < 0) throw new Error("Invalid event");
      continue;
    }
    if (wireType === 0) {
      readVarint(data, cursor);
    } else if (wireType === 1) {
      cursor.offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(data, cursor);
      if (cursor.offset + length > data.length) throw new Error("Invalid event");
      if (groupDepth === 0) {
        if (spec.singular.has(field)) {
          // A duplicate of a singular message-typed field merges in
          // canonical parsers and replaces here; reject.
          if (seenSingular.has(field)) throw new Error("Invalid event");
          seenSingular.add(field);
        }
        if (spec.arms?.has(field)) {
          if (seenArm !== 0 && seenArm !== field) throw new Error("Invalid event");
          seenArm = field;
        }
        const child = spec.descend[field];
        if (child !== undefined) {
          const childSpec = SCAN_SPECS[child];
          if (childSpec !== undefined) {
            scanMessage(data.subarray(cursor.offset, cursor.offset + length), childSpec);
          }
        }
      }
      cursor.offset += length;
    } else if (wireType === 5) {
      cursor.offset += 4;
    } else {
      throw new Error("Invalid event");
    }
    if (cursor.offset > data.length) throw new Error("Invalid event");
  }
  if (groupDepth !== 0) throw new Error("Invalid event");
}

/**
 * Rejects a wire envelope that repeats a KNOWN event tag, then walks each
 * event payload through the scan graph. Canonical protobuf merges repeated
 * message occurrences where ts-proto overwrites, so two runtimes would
 * surface different events; neither silent behaviour is acceptable. Unknown
 * field numbers are protobuf's to ignore — repeated or not — so forward
 * compatibility is untouched.
 */
function assertNoRepeatedTopLevelTags(data: Uint8Array): void {
  const seen = new Set<number>();
  const cursor = { offset: 0 };
  // Legacy group wire types nest; everything inside a group is an unknown
  // field a protobuf decoder skips, so the scan skips it too.
  let groupDepth = 0;
  while (cursor.offset < data.length) {
    const tag = readVarint(data, cursor);
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    // Field zero is not a legal tag: canonical decoders reject it while
    // ts-proto silently stops reading, which would truncate the stream in
    // one runtime and error in another.
    if (field === 0) {
      throw new Error("Invalid event");
    }
    if (wireType === 3) {
      groupDepth += 1;
      continue;
    }
    if (wireType === 4) {
      groupDepth -= 1;
      if (groupDepth < 0) throw new Error("Invalid event");
      continue;
    }
    if (groupDepth === 0 && ENVELOPE_TAGS.has(field)) {
      if (seen.has(field)) {
        throw new Error("Invalid event");
      }
      seen.add(field);
    }
    if (wireType === 0) {
      readVarint(data, cursor);
    } else if (wireType === 1) {
      cursor.offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(data, cursor);
      if (cursor.offset + length > data.length) throw new Error("Invalid event");
      if (groupDepth === 0) {
        const child = ENVELOPE_SCAN[field];
        if (child !== undefined) {
          const childSpec = SCAN_SPECS[child];
          if (childSpec !== undefined) {
            scanMessage(data.subarray(cursor.offset, cursor.offset + length), childSpec);
          }
        }
      }
      cursor.offset += length;
    } else if (wireType === 5) {
      cursor.offset += 4;
    } else {
      throw new Error("Invalid event");
    }
    if (cursor.offset > data.length) throw new Error("Invalid event");
  }
  if (groupDepth !== 0) throw new Error("Invalid event");
}

export function decode(data: Uint8Array): BaseEvent {
  assertNoRepeatedTopLevelTags(data);
  const envelope = protoEvents.Event.decode(data);
  // Exactly one oneof entry. ts-proto's field-per-entry decoding cannot
  // reproduce protobuf's last-field-wins for a malformed envelope carrying
  // several, so the deterministic behaviour is to reject it loudly rather
  // than silently pick a different event than another runtime would.
  const populated = Object.entries(envelope).filter(
    ([, value]) => value !== undefined,
  );
  if (populated.length !== 1) {
    throw new Error("Invalid event");
  }
  const entry = populated[0];
  // The oneof entry selected the message shape, so it names the type; a
  // base_event.type that disagrees is a malformed event, not a tiebreak.
  const entryType = ENVELOPE_TYPE[entry[0]];
  if (entryType === undefined) {
    throw new Error("Invalid event");
  }
  const decoded = entry[1] as LooseRecord;
  const base = asRecord(decoded.baseEvent);
  if (!base) {
    throw new Error("Invalid event");
  }
  const declaredType = protoEvents.EventType[base.type as number];
  if (declaredType !== entryType) {
    throw new Error(
      "Invalid event: envelope carries " +
        entryType +
        " but the base event declares " +
        String(declaredType),
    );
  }
  decoded.type = entryType;
  decoded.timestamp = base.timestamp;
  decoded.rawEvent = base.rawEvent;
  // Struct decodes an absent object to undefined, so an event that carried no
  // metadata stays without the key rather than gaining an empty one.
  if (base.metadata !== undefined) {
    decoded.metadata = base.metadata;
  }
  delete decoded.baseEvent;

${decodeCases.join("\n")}

  dropUndefinedDeep(decoded);

  // Same gate as encode: validate what the SDK knows, carry the rest.
  if (KNOWN_TO_CORE.has(decoded.type as string)) {
    return EventSchemas.parse(decoded) as BaseEvent;
  }
  return decoded as unknown as BaseEvent;
}
`;
}
