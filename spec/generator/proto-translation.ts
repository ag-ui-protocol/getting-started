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
import {
  buildScanGraph,
  MERGE_SPLIT,
  snakeCase,
  UNION_STRATEGY,
} from "./protobuf";
import { assertTableKeys } from "./tables";
import type { WireModel } from "./protobuf";

function resolveAlias(defs: Map<string, Definition>, type: TypeExpr): TypeExpr {
  while (type.kind === "ref") {
    const target = defs.get(type.name);
    if (target?.kind !== "alias") return type;
    type = target.type;
  }
  return type;
}

/**
 * The far half of the round trip between a wire field's two spellings.
 *
 * MERGE_SPLIT names its buckets in the .proto's snake_case — which is why
 * snakeCase is imported from protobuf.ts rather than written again here — and
 * ts-proto hands the generated TypeScript the camelCase of the same name.
 * Going through both functions is what keeps this emitter from writing a wire
 * field name of its own: the .proto and the mapper end up spelling one
 * decision, not two.
 */
function camelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
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
  const baseFieldNames = wire.baseFieldNames;
  const baseNames = new Set(baseFieldNames);

  /**
   * The base fields encode does not simply pass through, and what it writes
   * instead: `type` becomes the proto enum, `metadata` is narrowed to the
   * object Struct can carry. Every other base field rides as it arrived, so a
   * field added to BaseEvent reaches the wire without an entry here.
   *
   * Keyed by name and asserted, like every other idiom table: a rename would
   * not fail the lookup, it would silently revert the field to a pass-through
   * and quietly stop encoding the enum.
   */
  const BASE_FIELD_ENCODING: Record<string, string> = {
    "BaseEvent.type":
      "protoEvents.EventType[event.type as keyof typeof protoEvents.EventType]",
    "BaseEvent.metadata": "normalizeMetadata(metadata)",
  };
  assertTableKeys(
    "BASE_FIELD_ENCODING",
    Object.keys(BASE_FIELD_ENCODING),
    model,
  );

  // Both halves of encode's base handling come from the one list, so they
  // cannot disagree about which fields exist: the destructuring pattern that
  // takes them off the event, and the literal that puts them back on
  // base_event. Repeating them by hand let a new BaseEvent field regenerate
  // every file byte for byte while silently failing to cross the wire.
  const baseDestructuring = baseFieldNames.join(", ");
  const baseEventLiteral = baseFieldNames
    .map((name) => {
      const written = BASE_FIELD_ENCODING[`BaseEvent.${name}`];
      return written
        ? `        ${name}: ${written},`
        : `        ${name},`;
    })
    .join("\n");

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
    const sources = entry.payload.filter((field) => {
      const resolved = resolveAlias(defs, field.type);
      return resolved.kind === "ref" && resolved.name === "InputContentSource";
    });
    const fields = entry.payload
      .map((field) => {
        const resolved = resolveAlias(defs, field.type);
        if (resolved.kind === "ref" && resolved.name === "InputContentSource") {
          return `${field.name}: fromProtoSource(part.${field.name})`;
        }
        return `${field.name}: part.${field.name}`;
      })
      .join(", ");
    // A source kind this build does not know takes its whole part with it.
    // The source is required, so on the JSON path the drop CASCADES: an
    // unrecognisable value in a required position removes the object
    // containing it, leaving the array one part shorter. Emitting a known
    // part with no source instead would hand enforcement something the schema
    // calls malformed, and a media kind added after this build shipped would
    // be fatal over binary while surviving over SSE.
    //
    // Only when the source is PRESENT and unreadable, though. An absent one is
    // a required field the producer omitted — malformed, not from the future —
    // and dropping that too would hide a defect the JSON path reports. Message
    // fields carry presence on the wire, so the two really are distinguishable
    // here: absent reads as undefined, present-but-empty as {}.
    const sourceGuards = sources
      .map(
        (field) =>
          `    if (part.${field.name} !== undefined && fromProtoSource(part.${field.name}) === undefined) {\n      return undefined;\n    }\n`,
      )
      .join("");
    return `  if (rec.${entry.entry}) {\n    const part = rec.${entry.entry} as LooseRecord;\n${sourceGuards}    return { type: ${JSON.stringify(entry.entry)}, ${fields} };\n  }`;
  };

  /* ---------------- merged Message ---------------- */

  const messageUnion = defs.get("Message");
  if (messageUnion?.kind !== "union") throw new Error("Message union missing");

  /**
   * The one field the merged Message has to split, found the way protobuf.ts
   * decides to split it: the members disagree about its shape.
   *
   * Naming it here instead would be this emitter deciding for itself which
   * field rides several wire fields, and a schema that moved the disagreement
   * to another field would leave the mapper reading a field the .proto no
   * longer splits — with the drift gate green, because it only compares the
   * generator against its own output.
   */
  const contentField = (() => {
    const shapes = new Map<string, Set<string>>();
    for (const memberName of messageUnion.members) {
      for (const field of objectDef(memberName).fields) {
        const kinds = shapes.get(field.name) ?? new Set<string>();
        kinds.add(resolveAlias(defs, field.type).kind);
        shapes.set(field.name, kinds);
      }
    }
    const split = [...shapes]
      .filter(([, kinds]) => kinds.size > 1)
      .map(([name]) => name);
    if (split.length !== 1) {
      throw new Error(
        `the merged Message splits ${split.length} fields (${split.join(", ")}) — ` +
          "this emitter is written for exactly one, so decide how the others " +
          "ride before regenerating",
      );
    }
    return split[0];
  })();

  /**
   * That field's three wire spellings, straight out of MERGE_SPLIT and through
   * ts-proto's camelCase. Which bucket a member lands in is its TypeExpr kind,
   * which is what `mode` below records.
   */
  const wireContent = camelCase(MERGE_SPLIT.string(snakeCase(contentField)));
  const wireContentParts = camelCase(
    MERGE_SPLIT.array(snakeCase(contentField)),
  );
  const wireActivityContent = camelCase(
    MERGE_SPLIT.openMap(snakeCase(contentField)),
  );

  // role value -> how its content field rides the wire
  const contentModes = messageUnion.members.map((memberName) => {
    const member = objectDef(memberName);
    const role = member.fields.find(
      (field) => field.name === messageUnion.discriminator,
    );
    if (role?.type.kind !== "literal") throw new Error("message discriminator");
    const content = member.fields.find(
      (field) => field.name === contentField,
    );
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
  /**
   * Definitions that never get a nested-input converter, however their fields
   * are shaped.
   *
   * The converter below exists for RunAgentInput: an event field that is a
   * whole nested OBJECT carrying arrays of union members, which the generic
   * spread cannot map because those members need toWireMessage. These two are
   * carried by the generic path on purpose — Interrupt because its payload is
   * schema-free by design, TokenUsage because it is flat counters — and a
   * converter for either would rewrite a shape the wire is frozen against.
   *
   * Neither carries an array of union members today, so the exclusion matches
   * nothing; it is a standing decision about these two, not a live filter, and
   * the point of naming them is that a field added to either does not quietly
   * acquire a converter. Keyed by name, so the keys are asserted: a rename
   * would not fail the list, it would just stop matching.
   */
  const NO_INPUT_CONVERTER = ["Interrupt", "TokenUsage"];
  assertTableKeys("NO_INPUT_CONVERTER", NO_INPUT_CONVERTER, model);

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
      // Only a FLATTEN union dissolves into the event carrying it. protobuf.ts
      // decides that per union in UNION_STRATEGY, so reading the same table is
      // what keeps the mapper and the .proto agreeing about what a union does
      // on the wire; treating every union as flattened would emit a mapper for
      // a shape the .proto never wrote.
      if (resolved?.kind === "union" && UNION_STRATEGY[resolved.name] === "flatten") {
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
      if (resolved?.kind === "union") {
        // A union in a direct field position that protobuf.ts does NOT flatten
        // has no mapper here at all, and the field would simply stop crossing
        // the wire while every generated file still regenerated byte for byte.
        throw new Error(
          `${event.name}.${field.name} references union ${resolved.name}, whose ` +
            `wire strategy is "${UNION_STRATEGY[resolved.name]}" — this emitter ` +
            "only maps flattened unions in a direct field position; add the mapper " +
            "for that strategy before regenerating",
        );
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
        // A TAGGED union rides with its discriminator as a proto enum, which
        // is the whole reason the encode/decode pair below exists. Keying on
        // the definition's name instead would let this emitter and the .proto
        // disagree about which union is tagged.
        if (itemsDef !== undefined && UNION_STRATEGY[itemsDef.name] === "tagged") {
          patchFields.push({ eventType: type, jsonField: field.name });
        }
        if (!field.required) {
          optionalArrays.push({ eventType: type, jsonField: field.name });
        }
        continue;
      }
      if (
        resolved?.kind === "object" &&
        !NO_INPUT_CONVERTER.includes(resolved.name) &&
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
        // toWireMessage is told where it is, so a part it cannot encode is
        // named rather than merely missing; the other mappers have nothing to
        // say about position.
        const encodeExpr =
          mapper === "toWireMessage"
            ? `asArray(input.${field.name}).map((item: unknown, index: number) =>\n      toWireMessage(item, \`${field.name}[$\{index}]\`),\n    )`
            : mapper
              ? `asArray(input.${field.name}).map(${mapper})`
              : `asArray(input.${field.name})`;
        to.push(`    ${field.name}: ${encodeExpr},`);
        const decodeMapper =
          itemDef?.kind === "union"
            ? ".map(fromWireMessage).filter((message) => message !== undefined)"
            : "";
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
    rest.messages = rest.messages.map((message: unknown, index: number) =>
      toWireMessage(message, \`messages[\${index}]\`),
    );
  }`);
    decodeCases.push(`  if (decoded.type === ${JSON.stringify(type)} && Array.isArray(decoded.messages)) {
    decoded.messages = (decoded.messages as unknown[])
      .map(fromWireMessage)
      .filter((message) => message !== undefined);
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
        // Payload belonging to a different case is a contradiction — a success
        // carrying interrupts would finish the run with one pending — but it is
        // the SAME contradiction the JSON form can express, where it reads as an
        // unknown property on a closed object and enforcement strips it. So it
        // is rebuilt as it arrived and judged there, on both transports alike,
        // rather than being decided here for one of them.
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
        const foreignPairs = foreign
          .map(
            (name) =>
              `, ...(asArray(payload.${name}).length > 0 ? { ${name}: payload.${name} } : {})`,
          )
          .join("");
        return `    if (wireOutcome === ${JSON.stringify(entry.value)}) {
      record.${spec.jsonField} = { type: ${JSON.stringify(entry.value)}${pairs}${foreignPairs} };
    }`;
      })
      .join("\n");
    const allPayloadNames = [
      ...new Set(
        spec.cases.flatMap((entry) => entry.payload.map((f) => f.name)),
      ),
    ];
    // With no outcome at all the payload belongs nowhere, so it rides
    // at the top level, where it is an undescribed property and enforcement
    // strips it with a warning — the same reading a JSON producer's stray
    // property gets.
    const absentChecks = allPayloadNames
      .map(
        (name) => `
      if (asArray(payload.${name}).length > 0) {
        record.${name} = payload.${name};
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
    const payload: LooseRecord = {};
${payloadNames.map((name) => `    payload.${name} = record.${name};\n    delete record.${name};`).join("\n")}
    delete record.${spec.jsonField};
    if (wireOutcome === undefined) {${absentChecks}
    }
${rebuild}
    // An unrecognised ${spec.jsonField} is still representable as JSON, so it
    // is rebuilt as it was sent rather than judged here. Decoding bytes into
    // events is transport work; deciding what an unrecognised value MEANS
    // belongs to the one enforcement stage every transport shares, so that a
    // stream cannot survive over SSE and fail over binary. Which payload an
    // unknown case owns is unknowable, so whatever arrived rides along for
    // enforcement to strip with the rest.
    if (wireOutcome !== undefined && !${JSON.stringify(knownValues)}.includes(wireOutcome)) {
      record.${spec.jsonField} = {
        type: wireOutcome${payloadNames.map((name) => `,
        ...(asArray(payload.${name}).length > 0 ? { ${name}: payload.${name} } : {})`).join("")}
      };
    }
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
    // An operation this build cannot name is never invented and never fatal —
    // and never dropped here either. An operation added to JSON Patch after
    // this build shipped arrives over SSE as an unrecognised union member,
    // which enforcement removes from the array and NAMES; throwing here made
    // the same patch fatal over binary and survivable over SSE, and filtering
    // it out here made it vanish over binary with nothing said, while the same
    // patch over SSE printed the path it lost.
    //
    // The enum value is all the wire carries for an operation this build has no
    // name for, so it rides on as its own decimal spelling. That is not a valid
    // JSON Patch op either — which is the point: enforcement reads it as the
    // unrecognised union member it is, strips the operation and says so.
    decoded.${entry.jsonField} = (decoded.${entry.jsonField} as LooseRecord[]).map(
      (operation) => {
        const opName =
          protoPatch.JsonPatchOperationType[
            operation.op as protoPatch.JsonPatchOperationType
          ];
        operation.op =
          typeof opName === "string" && opName !== "UNRECOGNIZED"
            ? opName.toLowerCase()
            : String(operation.op);
        Object.keys(operation).forEach((key) => {
          if (operation[key] === undefined) {
            delete operation[key];
          }
        });
        return operation;
      },
    );
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
      const eventType = eventTypeOf(definition);
      const key = camelCase(entry.entry);
      // One identity, derived twice. encode picks the envelope arm by
      // camelCasing the EventType VALUE; this table — which decode reads — is
      // keyed by the entry protobuf.ts names after the definition NAME. They
      // agree for every event today by convention alone, and nothing made
      // them: a schema where they parted would have encode writing an arm
      // decode cannot read, and only a round trip at runtime would say so.
      const encodeKey = camelCase(eventType.toLowerCase());
      if (encodeKey !== key) {
        throw new Error(
          `${definition.name}: encode writes the envelope arm "${encodeKey}" ` +
            `(from the EventType value ${eventType}) but decode reads "${key}" ` +
            `(from the definition name) — the two spellings of one arm have ` +
            "parted, and an event encoded here could not be decoded back",
        );
      }
      return `  ${key}: ${JSON.stringify(eventType)},`;
    })
    .join("\n");

  return `// @generated by spec/generator — DO NOT EDIT.
// Source: ${model.schemaId}
// Regenerate: pnpm --filter @ag-ui/spec generate

import { BaseEvent, AGUIEvent, EventType } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
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

/**
 * The same switch the client's enforcement stage reads, so one variable
 * silences both halves of what is really one decision about unrecognised
 * material.
 */
const suppressWarnings = (): boolean =>
  typeof process !== "undefined" &&
  typeof process.env !== "undefined" &&
  Boolean(process.env.SUPPRESS_TRANSFORMATION_WARNINGS);

/**
 * The one drop this layer makes that it cannot hand on to enforcement.
 *
 * An unrecognised role or patch operation still has a NAME — the string or the
 * enum value arrived on the wire — so it rides along and enforcement strips it
 * and says which path it stripped. An unset protobuf oneof has no name at all:
 * the bytes say only that no arm this build knows was populated. There is
 * nothing to pass on, so the drop has to happen here, and a drop that happens
 * here is a drop enforcement will never mention. Saying so is the difference
 * between the two transports losing the same part loudly and one of them
 * losing it in silence.
 */
const warnDroppedContentPart = (): void => {
  if (suppressWarnings()) return;
  console.warn(
    "[ag-ui][proto] Dropped a content part this build does not know: the protocol has a variant this SDK predates.",
  );
};

/**
 * The encode-side twin, and the only one that can say WHERE.
 *
 * Reached only with validation bypassed, since the schema would have rejected
 * the part first. There is no wire arm to put it on, so it cannot be encoded —
 * but the message then arrives at the far end one part shorter, and until this
 * warning existed nothing said which part went missing or from which message.
 */
const warnUnencodableContentPart = (at: string, index: number): void => {
  if (suppressWarnings()) return;
  console.warn(
    \`[ag-ui][proto.encode] Dropped \${at}.\${CONTENT_FIELD}[\${index}]: no wire form for this content part, so it is not encoded.\`,
  );
};

function toCamelCase(str: string): string {
  return str.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * A validation failure as the list of places it failed.
 *
 * Read structurally rather than by instanceof: a zod error crossing a package
 * boundary may come from a different copy of zod, and an instanceof that
 * quietly missed would leave the warning naming nothing at all.
 */
const issuePaths = (err: unknown): string => {
  const issues = (err as { issues?: unknown })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return String(err);
  const paths = issues.map((issue) => {
    const path = (issue as { path?: unknown }).path;
    return Array.isArray(path) && path.length > 0
      ? \`/\${path.join("/")}\`
      : "the event itself";
  });
  return [...new Set(paths)].join(", ");
};

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
/** Every role the Message union declares, for telling unknown from misused. */
const KNOWN_ROLES = new Set<string>(${JSON.stringify(contentModes.map((entry) => entry.role))});

/** The JSON field the merged Message splits, for naming a part in a warning. */
const CONTENT_FIELD = ${JSON.stringify(contentField)};

const toWireMessage = (value: unknown, at = "message"): LooseRecord => {
  const message = asRecord(value) ?? {};
  const wire: LooseRecord = { ...message, ${wireContentParts}: [] };
  wire.metadata = normalizeMetadata(message.metadata);
  wire.toolCalls = asArray(message.toolCalls).map((toolCall: unknown) => ({
    ...(toolCall as LooseRecord),
    metadata: normalizeMetadata(asRecord(toolCall)?.metadata),
  }));
  if (Array.isArray(message.${contentField})) {
    wire.${wireContentParts} = message.${contentField}
      .map((part: unknown, index: number) => {
        const mapped = toProtoContentPart(part);
        if (mapped === undefined) warnUnencodableContentPart(at, index);
        return mapped;
      })
      .filter((part: unknown) => part !== undefined);
    wire.${wireContent} = undefined;
  } else if (
    typeof message.role === "string" &&
    MAP_CONTENT_ROLES.has(message.role)
  ) {
    wire.${wireActivityContent} = normalizeMetadata(message.${contentField}) ?? {};
    wire.${wireContent} = undefined;
  }
  return wire;
};

const fromWireMessage = (value: unknown): LooseRecord | undefined => {
  const wire = asRecord(value) ?? {};
  const message: LooseRecord = { ...wire };
  const role = typeof wire.role === "string" ? wire.role : "";
  // A role this build does not know makes the whole message an unrecognised
  // member of the Message union — which is exactly what the same message is on
  // the JSON path, where enforcement's discriminated-union walk removes it from
  // the array and NAMES the path it removed. So it is rebuilt as it arrived and
  // judged there, on both transports alike. Dropping it here instead removed it
  // just as surely, but silently: enforcement then saw a snapshot with nothing
  // wrong in it, and the same stream lost a message loudly over SSE and quietly
  // over protobuf.
  const known = KNOWN_ROLES.has(role);
  // Which carrier feeds \`content\` is a fact about the ROLE, for a role this
  // build knows. For one it does not, there is no rule to look up and no way to
  // invent one, so the carrier the producer actually populated decides.
  // An unknown role's EMPTY parts array reads as no content — enforcement drops the message anyway.
  const usesParts = known
    ? PARTS_CONTENT_ROLES.has(role)
    : asArray(wire.${wireContentParts}).length > 0;
  const usesMap = known
    ? MAP_CONTENT_ROLES.has(role)
    : !usesParts && wire.${wireActivityContent} !== undefined;
  // Carrier exclusivity comes in two kinds, and only one of them survives not
  // knowing the role.
  //
  // WHICH carrier a role uses is a fact about the role, so it can only be
  // checked for a role this build knows; applying it to an unknown one would
  // make a role added after this build shipped fatal over binary and
  // survivable over SSE — the very split this layer exists to prevent.
  //
  // Carrying SEVERAL at once is different: they are competing spellings of one
  // JSON field, so no role, present or future, can mean anything by it. That
  // half holds whatever the role is. Without it an unknown role carrying two
  // would have kept whichever this code happened to read first and dropped the
  // rest in silence — the same quiet loss this whole change is about.
  if (
    !known &&
    (wire.${wireContent} !== undefined ? 1 : 0) +
      (asArray(wire.${wireContentParts}).length > 0 ? 1 : 0) +
      (wire.${wireActivityContent} !== undefined ? 1 : 0) >
      1
  ) {
    throw new Error(
      "Invalid event: message carries more than one content form",
    );
  }
  if (known) {
    // Content carriers are role-exclusive; a message carrying a carrier its
    // role does not use would lose data whichever one decode preferred.
    if (!usesParts && asArray(wire.${wireContentParts}).length > 0) {
      throw new Error(
        "Invalid event: message carries content parts for a role that has none",
      );
    }
    if (wire.${wireActivityContent} !== undefined && !usesMap) {
      throw new Error(
        "Invalid event: message carries activity content for a non-activity role",
      );
    }
    if (usesMap && wire.${wireContent} !== undefined) {
      throw new Error(
        "Invalid event: activity content cannot ride with other content forms",
      );
    }
    if (
      usesParts &&
      wire.${wireContent} !== undefined &&
      asArray(wire.${wireContentParts}).length > 0
    ) {
      // String content and parts together is a contradiction the encoder never
      // writes; resolving it either way would silently discard the other half.
      throw new Error(
        "Invalid event: message carries both string content and content parts",
      );
    }
  }
  if (usesParts && wire.${wireContent} === undefined) {
    // String content rides the content field; anything else is the parts
    // array — including an empty one, which is valid content of its own. A
    // part naming no arm this build knows is DROPPED rather than rejected,
    // because that is what the same part does on the JSON path: an
    // unrecognised member of a union is stripped from its array, and a media
    // kind added after this build shipped must not kill the message carrying
    // it. Rejecting here made a future content part fatal over binary and
    // survivable over SSE.
    message.${contentField} = asArray(wire.${wireContentParts})
      .map((part: unknown) => {
        const mapped = fromProtoContentPart(part);
        if (mapped === undefined) warnDroppedContentPart();
        return mapped;
      })
      .filter((part: unknown) => part !== undefined);
  }
  if (usesMap && wire.${wireActivityContent} !== undefined) {
    message.${contentField} = wire.${wireActivityContent};
  }
  delete message.${wireActivityContent};
  delete message.${wireContentParts};
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
      // The paths the schema objected to, and nothing else. The event itself
      // used to ride along as a second console argument: on a stream that is a
      // wall of text around the one line that matters, and it prints whatever
      // the event was carrying — message content, raw provider payloads — into
      // logs that may have no business holding it. The paths say what to fix.
      //
      // Encoding continues regardless: the tolerance is the contract here, and
      // this only changes what the tolerance says on its way past.
      console.warn(
        \`[ag-ui][proto.encode] Encoding \${String(event.type)} without validation: the schema rejected it at \${issuePaths(err)}. Encoded as given.\`,
      );
      validatedEvent = event;
    }
  }
  const oneofField = toCamelCase(validatedEvent.type as string);
  const { ${baseDestructuring}, ...rest } =
    validatedEvent as unknown as LooseRecord;

${encodeCases.join("\n")}

  const eventMessage = {
    [oneofField]: {
      baseEvent: {
${baseEventLiteral}
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

/**
 * The envelope carried nothing but variants this build was not compiled
 * against — an event from a later protocol, rather than broken bytes.
 *
 * Kept distinct from a decode failure on purpose. An SSE reader hands such an
 * event to the pipeline, which drops it with a warning and carries on; the
 * binary reader cannot hand it over at all, because an unknown arm has no type
 * string to put on it. Naming the case lets the caller drop the frame the same
 * way, so a producer that adds an event does not kill every binary client
 * while text clients sail past it.
 */
export class AGUIUnknownEventTypeError extends Error {
  constructor(message = "Unknown event type") {
    super(message);
    this.name = "AGUIUnknownEventTypeError";
  }
}

/**
 * Reads a varint that must fit the width its position allows, returning -1 for
 * anything unreadable or too wide.
 *
 * readVarint above deliberately MASKS the overflow bits instead, mirroring the
 * wire reader so that an overlong tag cannot dodge duplicate detection. The
 * walkers below want the opposite: masking would quietly turn a field number
 * or a length that no protobuf encoder can produce into a smaller, plausible
 * one, and broken bytes would read as a well-formed message.
 *
 * The line these walkers hold is well-formed PROTOBUF, never conformance to a
 * schema. A tag or a length that overflows its width is not protobuf at all; a
 * field number protobuf reserves by convention still is, and judging that would
 * be judging the shape of an arm this build was never compiled against.
 */
function boundedVarint(
  data: Uint8Array,
  cursor: { offset: number },
  maxBytes: number,
  lastByteMax: number,
): number {
  let result = 0;
  let shift = 0;
  let bytes = 0;
  for (;;) {
    if (cursor.offset >= data.length || bytes >= maxBytes) return -1;
    const byte = data[cursor.offset++];
    bytes += 1;
    // The final byte carries only the bits the width has left over, so a bigger
    // one encodes a number the field could never hold. A continuation bit here
    // fails the same test, since it asks for a byte the width does not have.
    if (bytes === maxBytes && byte > lastByteMax) return -1;
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) return result;
  }
}

/**
 * A tag and a length are both uint32 on the wire: five bytes, the last holding
 * four bits. Capping a tag there caps the field number at protobuf's own
 * maximum, since the tag is the field number shifted left by three.
 */
const varint32 = (data: Uint8Array, cursor: { offset: number }): number =>
  boundedVarint(data, cursor, 5, 0x0f);

/** A varint-typed VALUE is uint64: ten bytes, the last holding one bit. */
const varint64 = (data: Uint8Array, cursor: { offset: number }): number =>
  boundedVarint(data, cursor, 10, 0x01);

/**
 * Whether the given bytes walk cleanly as a protobuf message.
 *
 * Used on the payload of an arm this build does not know, where nothing else
 * can vouch for it: the generated parser skips an unknown field without ever
 * reading inside it, so bytes that encode no message at all would otherwise be
 * indistinguishable from an event from the future.
 *
 * Deliberately a WELL-FORMEDNESS check and nothing more. It asks whether the
 * bytes are a protobuf message, never whether they are an AG-UI event — an arm
 * this build has not been compiled against may be shaped in ways this version
 * cannot anticipate, and demanding a familiar shape would reject exactly the
 * future events this whole path exists to survive. For the same reason it does
 * not recurse: at this level a length-delimited run of bytes is equally a
 * nested message, a string or a blob, so its insides settle nothing either way.
 */
function walksAsMessage(data: Uint8Array): boolean {
  const cursor = { offset: 0 };
  const groups: number[] = [];
  while (cursor.offset < data.length) {
    const tag = varint32(data, cursor);
    if (tag < 0) return false;
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (field === 0) return false;
    if (wireType === 3) {
      groups.push(field);
    } else if (wireType === 4) {
      // A legacy group closes with the field number it opened with; any other
      // pairing is a frame no encoder produces.
      if (groups.pop() !== field) return false;
    } else if (wireType === 0) {
      if (varint64(data, cursor) < 0) return false;
    } else if (wireType === 1) {
      cursor.offset += 8;
    } else if (wireType === 5) {
      cursor.offset += 4;
    } else if (wireType === 2) {
      const length = varint32(data, cursor);
      if (length < 0 || cursor.offset + length > data.length) return false;
      cursor.offset += length;
    } else {
      return false;
    }
    if (cursor.offset > data.length) return false;
  }
  return groups.length === 0;
}

/**
 * Whether the frame names one or more arms from a later protocol and nothing
 * this build could have read.
 *
 * Only consulted once the generated parser has found no known arm, because a
 * frame that DOES carry one is already answered: protobuf ignores unknown
 * fields, and this envelope is no exception — a later version may add fields
 * beside the arms, and rejecting a frame for carrying one would break every
 * older reader the moment it shipped. That rule is settled and tested.
 *
 * With no known arm the frame is either an event this build predates or broken
 * bytes, and the two must not share an answer. A known tag that failed to
 * parse, or any tag of a wire type no arm uses, means broken; at least one
 * unknown length-delimited field whose payload walks as a message means an
 * event from the future, which the caller drops the way enforcement drops an
 * unrecognised event off an SSE stream.
 */
function namesOnlyFutureArms(data: Uint8Array): boolean {
  const cursor = { offset: 0 };
  const groups: number[] = [];
  let future = 0;
  while (cursor.offset < data.length) {
    const tag = varint32(data, cursor);
    if (tag < 0) return false;
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (field === 0) return false;
    // Inside an unknown group every field is that group's business, so it is
    // skipped wholesale rather than read as a tag of the envelope.
    const atTopLevel = groups.length === 0;
    if (wireType === 3) {
      // Every arm of the envelope is a length-delimited message, so a known tag
      // opening a group names an event this build knows in a shape no encoder
      // writes. Checked before descending, because inside the group the tags
      // belong to the group rather than to the envelope.
      if (atTopLevel && ENVELOPE_TAGS.has(field)) return false;
      groups.push(field);
    } else if (wireType === 4) {
      if (groups.pop() !== field) return false;
    } else if (wireType === 0) {
      if (atTopLevel && ENVELOPE_TAGS.has(field)) return false;
      if (varint64(data, cursor) < 0) return false;
    } else if (wireType === 1) {
      if (atTopLevel && ENVELOPE_TAGS.has(field)) return false;
      cursor.offset += 8;
    } else if (wireType === 5) {
      if (atTopLevel && ENVELOPE_TAGS.has(field)) return false;
      cursor.offset += 4;
    } else if (wireType === 2) {
      const length = varint32(data, cursor);
      if (length < 0 || cursor.offset + length > data.length) return false;
      if (atTopLevel) {
        // A known arm the parser could not populate: the frame names an event
        // this build knows and failed to read it, which is broken input.
        if (ENVELOPE_TAGS.has(field)) return false;
        if (!walksAsMessage(data.subarray(cursor.offset, cursor.offset + length))) {
          return false;
        }
        future += 1;
      }
      cursor.offset += length;
    } else {
      return false;
    }
    if (cursor.offset > data.length) return false;
  }
  return groups.length === 0 && future > 0;
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
    // No arm this build knows. If the frame names one from a later protocol
    // instead, the two transports must agree about it: over SSE such an event
    // reaches enforcement and is dropped with a warning, so over binary it must
    // not be fatal either. Anything else here is malformed and stays fatal — an
    // empty envelope names nothing, and bytes that encode no message are broken
    // rather than a message to learn about later.
    if (populated.length === 0 && namesOnlyFutureArms(data)) {
      throw new AGUIUnknownEventTypeError();
    }
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

  // Deliberately unvalidated. Decoding turns bytes into the event a producer
  // sent, which is the same job the SSE reader does with JSON.parse and no
  // more; the client pipeline then strips, enforces and verifies whatever
  // arrives, identically for both transports. Validating here as well made the
  // binary path strictly harsher than the text one — an event carrying
  // anything this build did not recognise threw at the transport instead of
  // reaching enforcement, so the same stream succeeded over SSE and failed
  // over protobuf. The structural guards above stay: bytes that map to no
  // valid event at all are a decode failure, and that IS transport work.
  return decoded as unknown as BaseEvent;
}
`;
}
