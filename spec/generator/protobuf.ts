/**
 * The protobuf emitter: model in, .proto files, the wire freeze, and the
 * TypeScript translation layer out.
 *
 * Two truths meet here. The schema owns what exists; the freeze file owns
 * what it is numbered on the wire. A frozen slot keeps its number forever —
 * schema order is irrelevant to the wire — and a genuinely new slot gets the
 * next free number in its message, appended to the freeze by the generator
 * itself. A freeze entry whose schema field is gone becomes a protobuf
 * `reserved` statement, so numbers are never reused. Nobody authors a number.
 *
 * The tables in this file are transport shape, not field meaning: which
 * strategy renders a union on the wire, what a message is called in proto,
 * where a merged field lands. Descriptions still come from the schema; if a
 * field's meaning ever appears here, it has escaped the schema.
 */

import type {
  Definition,
  Field,
  ObjectDefinition,
  ProtocolModel,
  TypeExpr,
  UnionDefinition,
} from "./ir";
import { assertTableKeys } from "./tables";

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

/**
 * A schema field name in the .proto's spelling. Exported because the
 * translation emitter has to reach MERGE_SPLIT's buckets, which are named in
 * this spelling: one function, so the .proto and the mapper cannot drift into
 * two ideas of what a wire field is called.
 */
export function snakeCase(name: string): string {
  return name
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");
}

/** How a definition is named on the wire, where it differs from the schema. */
const PROTO_NAME: Record<string, string> = {
  TokenUsage: "Usage",
  TextInputContent: "TextInputPart",
  ImageInputContent: "ImageInputPart",
  AudioInputContent: "AudioInputPart",
  VideoInputContent: "VideoInputPart",
  DocumentInputContent: "DocumentInputPart",
};

function protoName(definitionName: string): string {
  return PROTO_NAME[definitionName] ?? definitionName;
}

/**
 * How each union renders on the wire. A union without a strategy fails
 * generation: a new union is a new transport decision, not a default.
 *
 * - envelope: the Event oneof wrapper message
 * - merge:    one message carrying the union of all members' fields
 * - oneof:    a message with one oneof over per-member messages
 * - flatten:  the union dissolves into its parent as a discriminator string
 *             plus the members' fields
 * - tagged:   one message with the discriminator as a proto enum (JSON Patch)
 *
 * Exported because the translation layer has to branch on the same decision
 * this table records; branching on definition names instead would let the two
 * disagree about what a union does on the wire.
 */
export const UNION_STRATEGY: Record<string, string> = {
  Event: "envelope",
  Message: "merge",
  InputContent: "oneof",
  InputContentSource: "oneof",
  RunFinishedOutcome: "flatten",
  SubagentFinishedOutcome: "flatten",
  JsonPatchOperation: "tagged",
};

/**
 * Where a merged union member's clashing field lands, by the member field's
 * shape: the string form keeps the field's name, the parts array and the
 * open-map form get wire fields of their own.
 *
 * Keyed by TypeExpr kind. A UNION's variants are looked up through mergeSplit,
 * so a variant kind with no bucket fails generation. A field that is not a
 * union is not split at all — it keeps its own name — except an openMap, which
 * mergeVariants reads out of this table directly rather than through
 * mergeSplit: routing it through would demand a bucket for every non-union kind
 * the merged message carries, and most of them have none. Two variants sharing
 * a bucket share a wire field, and only the first of them survives. Exported
 * for the same reason UNION_STRATEGY is.
 */
export const MERGE_SPLIT: Record<string, (field: string) => string> = {
  string: (field) => field,
  array: (field) => `${field}_parts`,
  openMap: (field) => `activity_${field}`,
};

/**
 * The bucket a merged union variant lands in, or a hard error. A variant with
 * no bucket of its own would collide with another variant's wire field and be
 * dropped in silence — the message would still emit, and the freeze, which
 * pins numbers rather than meanings, would still agree with it.
 */
function mergeSplit(
  kind: TypeExpr["kind"],
  fieldName: string,
): (field: string) => string {
  const split = MERGE_SPLIT[kind];
  if (split === undefined) {
    throw new WireError(
      `merged union field ${fieldName}: a "${kind}" variant has no MERGE_SPLIT bucket — ` +
        "decide the wire field it lands on, or it silently shares another variant's " +
        "field and all but the first are dropped",
    );
  }
  return split;
}

/**
 * Fields whose deployed proto type differs from the mechanical mapping.
 * Value and Struct encode differently, so changing a deployed field's type
 * silently corrupts old streams — these two shipped as Value before the
 * schema constrained them to objects, and the wire keeps what shipped.
 */
const WIRE_TYPE_OVERRIDE: Record<string, string> = {
  "Interrupt.response_schema": "google.protobuf.Value",
  "Interrupt.metadata": "google.protobuf.Value",
};

/** Which file each non-event definition is emitted into. */
const FILE_OF: Record<string, string> = {
  EventType: "events.proto",
  BaseEvent: "events.proto",
  TokenUsage: "events.proto",
  Event: "events.proto",
  JsonPatchOperation: "patch.proto",
};
const DEFAULT_FILE = "types.proto";

/* ------------------------------------------------------------------ */
/* The freeze                                                          */
/* ------------------------------------------------------------------ */

export class WireFreeze {
  private numbers = new Map<string, number>();
  /** Keys that belong to each allocation group (a message or an enum). */
  private groups = new Map<string, Set<string>>();
  /** Keys the current generation actually used. */
  private live = new Set<string>();

  constructor(text: string) {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("//"))
        continue;
      const match = /^([\w.]+)\s*=\s*(\d+)$/.exec(line);
      if (!match) throw new Error(`unreadable freeze line: "${line}"`);
      const key = match[1];
      this.numbers.set(key, Number(match[2]));
      this.group(key).add(key);
    }
  }

  /**
   * The allocation group a key belongs to. Oneof segments are lowercase and
   * share their containing message's number space; nested messages are
   * PascalCase and have their own.
   */
  private groupOf(key: string): string {
    const segments = key.split(".");
    segments.pop();
    while (
      segments.length > 1 &&
      /^[a-z]/.test(segments[segments.length - 1])
    ) {
      segments.pop();
    }
    return segments.join(".");
  }

  private group(key: string): Set<string> {
    const name = this.groupOf(key);
    let group = this.groups.get(name);
    if (!group) {
      group = new Set();
      this.groups.set(name, group);
    }
    return group;
  }

  /** The frozen number for a slot, or the next free one, recorded. */
  numberFor(key: string, kind: "field" | "enum"): number {
    this.live.add(key);
    const frozen = this.numbers.get(key);
    if (frozen !== undefined) return frozen;
    const group = this.group(key);
    let next = kind === "enum" ? 0 : 1;
    for (const member of group) {
      const number = this.numbers.get(member);
      if (number !== undefined && number >= next) next = number + 1;
    }
    this.numbers.set(key, next);
    group.add(key);
    return next;
  }

  /** Frozen numbers in a group whose slots this generation did not use. */
  reservedIn(groupName: string): number[] {
    const group = this.groups.get(groupName);
    if (!group) return [];
    return [...group]
      .filter((key) => !this.live.has(key))
      .map((key) => this.numbers.get(key) as number)
      .sort((a, b) => a - b);
  }

  emit(banner: string): string {
    const lines = [...this.numbers.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, number]) => `${key} = ${number}`);
    return [banner.trimEnd(), "", ...lines, ""].join("\n");
  }
}

/* ------------------------------------------------------------------ */
/* Wire model                                                          */
/* ------------------------------------------------------------------ */

interface WireField {
  name: string;
  type: string;
  label: "" | "optional " | "repeated ";
  number: number;
  comment?: string;
  /** The JSON field this carries, for the translation layer. */
  jsonName?: string;
}

interface WireOneof {
  name: string;
  entries: WireField[];
}

interface WireMessage {
  name: string;
  comment?: string;
  fields: WireField[];
  oneof?: WireOneof;
  nested: WireMessage[];
  reserved: number[];
  file: string;
}

interface WireEnum {
  name: string;
  comment?: string;
  values: Array<{ name: string; number: number }>;
  reserved: number[];
  file: string;
}

export interface WireModel {
  enums: WireEnum[];
  messages: WireMessage[];
  /** The Event envelope oneof, entry name -> event definition name. */
  envelope: Array<{ entry: string; definition: string }>;
  /** Base-event field names, excluded from per-event messages. */
  baseFieldNames: string[];
  model: ProtocolModel;
  defs: Map<string, Definition>;
  freeze: WireFreeze;
}

class WireError extends Error {}

function defOf(defs: Map<string, Definition>, name: string): Definition {
  const definition = defs.get(name);
  if (!definition) throw new WireError(`no definition named ${name}`);
  return definition;
}

/** Resolves an alias chain to its underlying TypeExpr. */
function resolveAlias(defs: Map<string, Definition>, type: TypeExpr): TypeExpr {
  while (type.kind === "ref") {
    const target = defs.get(type.name);
    if (target?.kind !== "alias") return type;
    type = target.type;
  }
  return type;
}

/**
 * Maps a TypeExpr to a proto type + label, or null when it must flatten.
 *
 * `where` is the `Message.field` this position sits in, carried only so the
 * refusals below can name it: a position this mapper will not write is a
 * schema edit somebody has to find, and "somewhere in the schema" is not a
 * place.
 */
function protoType(
  defs: Map<string, Definition>,
  type: TypeExpr,
  where: string,
): { type: string; repeated: boolean } | { flatten: UnionDefinition } {
  switch (type.kind) {
    case "string":
    case "literal":
    case "stringEnum":
      return { type: "string", repeated: false };
    case "integer":
      return { type: "int64", repeated: false };
    case "boolean":
      return { type: "bool", repeated: false };
    case "any":
      return { type: "google.protobuf.Value", repeated: false };
    case "openMap":
      return { type: "google.protobuf.Struct", repeated: false };
    case "array": {
      const items = protoType(defs, type.items, where);
      if ("flatten" in items || items.repeated) {
        throw new WireError("unsupported nested repetition");
      }
      return { type: items.type, repeated: true };
    }
    case "union":
      throw new WireError("inline unions map through their definitions only");
    case "ref": {
      const target = defOf(defs, type.name);
      if (target.kind === "alias") {
        return protoType(defs, resolveAlias(defs, type), where);
      }
      if (target.kind === "enum") return { type: "string", repeated: false };
      if (target.kind === "union") {
        const strategy = UNION_STRATEGY[target.name];
        if (strategy === "flatten") return { flatten: target };
        if (
          strategy === "merge" ||
          strategy === "oneof" ||
          strategy === "tagged"
        ) {
          return { type: protoName(target.name), repeated: false };
        }
        throw new WireError(
          `union ${target.name} has no wire strategy for field use`,
        );
      }
      // FunctionCall has no message of its own: it is written as the nested
      // Function message of whatever declares it, which emitObjectMessage
      // reaches only through a direct reference. Any other position — an
      // array of them, a merged or tagged union member — would emit a .proto
      // naming a type no file declares, and protoc would be the first to say
      // so, long after generation succeeded.
      if (target.name === "FunctionCall") {
        throw new WireError(
          `${where}: FunctionCall is only carried as the nested Function message of a ` +
            "direct reference, so this position would name a type no .proto declares — " +
            "give it a message of its own before the schema puts it here",
        );
      }
      return { type: protoName(target.name), repeated: false };
    }
  }
}

/** Special-cased: JsonPatch is an alias for an array of the tagged union. */
function fieldWireType(
  defs: Map<string, Definition>,
  field: Field,
  where: string,
): { type: string; repeated: boolean } | { flatten: UnionDefinition } {
  let type = field.type;
  // Follow aliases so `delta: JsonPatch` becomes `repeated JsonPatchOperation`.
  if (type.kind === "ref") {
    const target = defs.get(type.name);
    if (target?.kind === "alias" && target.type.kind === "array") {
      type = target.type;
    }
  }
  if (type.kind === "union") {
    // The one inline union (user content: string | parts) is handled by the
    // merge strategy before this is reached.
    throw new WireError(`inline union on field ${field.name}`);
  }
  return protoType(defs, type, where);
}

function makeField(
  freeze: WireFreeze,
  scope: string,
  name: string,
  type: string,
  options: {
    repeated?: boolean;
    optional?: boolean;
    comment?: string;
    jsonName?: string;
  },
): WireField {
  const key = `${scope}.${name}`;
  return {
    name,
    type: WIRE_TYPE_OVERRIDE[key] ?? type,
    label: options.repeated ? "repeated " : options.optional ? "optional " : "",
    number: freeze.numberFor(`${scope}.${name}`, "field"),
    comment: options.comment,
    jsonName: options.jsonName,
  };
}

/** The fields a definition contributes to a message, flattening included. */
function messageFields(
  defs: Map<string, Definition>,
  freeze: WireFreeze,
  scope: string,
  fields: Field[],
  exclude: Set<string>,
): WireField[] {
  const out: WireField[] = [];
  for (const field of fields) {
    if (exclude.has(field.name)) continue;
    const wire = fieldWireType(defs, field, `${scope}.${field.name}`);
    if ("flatten" in wire) {
      // The union dissolves: a string discriminator named after the field,
      // then every member's non-discriminator field.
      const union = wire.flatten;
      out.push(
        makeField(freeze, scope, snakeCase(field.name), "string", {
          comment: field.description,
          jsonName: field.name,
        }),
      );
      const seen = new Set<string>();
      const discriminator = union.discriminator;
      for (const memberName of union.members) {
        const member = defOf(defs, memberName);
        if (member.kind !== "object") {
          throw new WireError(
            `flatten union member ${memberName} is not an object`,
          );
        }
        for (const memberField of member.fields) {
          if (memberField.name === discriminator || seen.has(memberField.name))
            continue;
          seen.add(memberField.name);
          const memberWire = fieldWireType(
            defs,
            memberField,
            `${scope}.${memberField.name}`,
          );
          if ("flatten" in memberWire) {
            throw new WireError("nested flatten unions are not modelled");
          }
          out.push(
            makeField(
              freeze,
              scope,
              snakeCase(memberField.name),
              memberWire.type,
              {
                repeated: memberWire.repeated,
                optional: !memberWire.repeated,
                comment: memberField.description,
                jsonName: memberField.name,
              },
            ),
          );
        }
      }
      continue;
    }
    out.push(
      makeField(freeze, scope, snakeCase(field.name), wire.type, {
        repeated: wire.repeated,
        optional: !field.required && !wire.repeated,
        comment: field.description,
        jsonName: field.name,
      }),
    );
  }
  return out;
}

/**
 * The wire fields one merged member field lands on. A union-typed field splits
 * across a wire field per variant — only one of which is ever present, so none
 * of them can be required — and everything else keeps a field of its own.
 */
function mergeVariants(
  field: Field,
): Array<{ wireName: string; type: TypeExpr }> {
  const name = snakeCase(field.name);
  if (field.type.kind === "union") {
    return field.type.members.map((variant) => ({
      wireName: mergeSplit(variant.kind, field.name)(name),
      type: variant,
    }));
  }
  return [
    {
      wireName:
        field.type.kind === "openMap" ? MERGE_SPLIT.openMap(name) : name,
      type: field.type,
    },
  ];
}

/** Builds the merged Message: the union of every member's fields. */
function mergeUnion(
  defs: Map<string, Definition>,
  freeze: WireFreeze,
  union: UnionDefinition,
): WireMessage {
  const scope = protoName(union.name);
  const fields = new Map<string, WireField>();
  /** Per member: the wire fields it carries, and whether it requires each. */
  const carried: Array<Map<string, boolean>> = [];

  for (const memberName of union.members) {
    const member = defOf(defs, memberName);
    if (member.kind !== "object") {
      throw new WireError(`merge union member ${memberName} is not an object`);
    }
    const mine = new Map<string, boolean>();
    for (const field of member.fields) {
      const variants = mergeVariants(field);
      for (const variant of variants) {
        const wire = protoType(defs, variant.type, `${scope}.${field.name}`);
        if ("flatten" in wire) {
          throw new WireError("flatten union inside a merged message");
        }
        if (!fields.has(variant.wireName)) {
          fields.set(
            variant.wireName,
            makeField(freeze, scope, variant.wireName, wire.type, {
              repeated: wire.repeated,
              optional: !wire.repeated,
              comment: field.description,
              jsonName: field.name,
            }),
          );
        }
        mine.set(variant.wireName, field.required && variants.length === 1);
      }
    }
    carried.push(mine);
  }

  // Requiredness is a fact about the whole union, so it is settled only once
  // every member has been read: computing it as the members go past leaves a
  // field first introduced by the third member never tested against the first
  // two, and the answer then depends on the order the schema happens to list
  // them in. On the wire that is the difference between explicit and implicit
  // presence on the same field number — a semantic difference the freeze,
  // which pins numbers alone, cannot see.
  const wireFields = [...fields.values()].map((field) => ({
    ...field,
    label: (field.label === "repeated "
      ? "repeated "
      : carried.every((member) => member.get(field.name) === true)
        ? ""
        : "optional ") as WireField["label"],
  }));

  return {
    name: scope,
    comment: union.description,
    fields: wireFields.sort((a, b) => a.number - b.number),
    nested: [],
    reserved: freeze.reservedIn(scope),
    file: FILE_OF[union.name] ?? DEFAULT_FILE,
  };
}

/**
 * Definitions the binary transport deliberately does not carry, each with the
 * reason it does not. Everything else the schema declares as an object or a
 * union must reach a message, or it is simply absent from the wire while the
 * JSON targets emit it — with generation succeeding and the drift gate, which
 * compares the generator only against its own output, agreeing.
 */
const NOT_ON_THE_WIRE = new Set([
  // The capability model describes an AGENT, not a run: it is served over
  // HTTP as JSON, never streamed as an event, so it has no wire slot. Adding
  // one is a transport decision, not a mechanical consequence of the schema.
  "AgentCapabilities",
  "ExecutionCapabilities",
  "HumanInTheLoopCapabilities",
  "IdentityCapabilities",
  "MultiAgentCapabilities",
  "MultimodalCapabilities",
  "MultimodalInputCapabilities",
  "MultimodalOutputCapabilities",
  "OutputCapabilities",
  "ReasoningCapabilities",
  "StateCapabilities",
  "ToolsCapabilities",
  "TransportCapabilities",
  // Reached only from MultiAgentCapabilities.subagents, so it is off the wire
  // for exactly the same reason the capabilities are.
  "SubagentInfo",
]);

/**
 * Every object and union either reaches a message or says why it does not.
 * `emitted` is what the walk wrote; `dissolved` is what a union strategy
 * absorbed into another message rather than writing on its own.
 */
function assertEveryDefinitionIsOnTheWire(
  model: ProtocolModel,
  emitted: Set<string>,
  dissolved: Set<string>,
): void {
  const missing = model.definitions
    .filter(
      (definition) =>
        (definition.kind === "object" || definition.kind === "union") &&
        !emitted.has(definition.name) &&
        !dissolved.has(definition.name) &&
        !NOT_ON_THE_WIRE.has(definition.name),
    )
    .map((definition) => definition.name);
  if (missing.length > 0) {
    throw new WireError(
      `nothing on the wire carries ${missing.join(", ")} — the walk starts at the events, ` +
        "so a definition they cannot reach is silently absent from the binary transport " +
        "while TypeScript and Python emit it; give it a field an event reaches, or add it " +
        "to NOT_ON_THE_WIRE with the reason it is not carried",
    );
  }
}

export function buildWireModel(
  model: ProtocolModel,
  freezeText: string,
): WireModel {
  assertTableKeys("PROTO_NAME", Object.keys(PROTO_NAME), model);
  assertTableKeys("UNION_STRATEGY", Object.keys(UNION_STRATEGY), model);
  assertTableKeys("FILE_OF", Object.keys(FILE_OF), model);
  assertTableKeys(
    "WIRE_TYPE_OVERRIDE",
    Object.keys(WIRE_TYPE_OVERRIDE),
    model,
    // Keyed by the wire's spelling of both halves, not the schema's.
    { definitionName: protoName, fieldName: snakeCase },
  );
  const freeze = new WireFreeze(freezeText);
  const defs = new Map(model.definitions.map((d) => [d.name, d]));
  const enums: WireEnum[] = [];
  const messages: WireMessage[] = [];
  const emitted = new Set<string>();
  /** Definitions a union strategy absorbed into another message. */
  const dissolved = new Set<string>();

  const eventUnion = defOf(defs, "Event");
  if (eventUnion.kind !== "union") throw new WireError("Event is not a union");

  const baseMixin = model.mixinShapes.find((m) => m.name === "BaseEvent");
  if (!baseMixin) throw new WireError("no BaseEvent mixin shape");
  const baseFieldNames = baseMixin.fields.map((field) => field.name);

  // EventType, with every value's number frozen.
  const eventTypeDef = defOf(defs, "EventType");
  if (eventTypeDef.kind !== "enum")
    throw new WireError("EventType is not an enum");
  enums.push({
    name: "EventType",
    comment: eventTypeDef.description,
    values: eventTypeDef.values
      .map((value) => ({
        name: value,
        number: freeze.numberFor(`EventType.${value}`, "enum"),
      }))
      .sort((a, b) => a.number - b.number),
    reserved: freeze.reservedIn("EventType"),
    file: "events.proto",
  });

  // BaseEvent, from the mixin's own shape. `type` references the enum.
  messages.push({
    name: "BaseEvent",
    comment: baseMixin.description,
    fields: baseMixin.fields
      .map((field) => {
        const wire =
          field.name === "type"
            ? { type: "EventType", repeated: false }
            : (fieldWireType(defs, field, `BaseEvent.${field.name}`) as {
                type: string;
                repeated: boolean;
              });
        return makeField(
          freeze,
          "BaseEvent",
          snakeCase(field.name),
          wire.type,
          {
            repeated: wire.repeated,
            optional: !field.required && !wire.repeated,
            comment: field.description,
            jsonName: field.name,
          },
        );
      })
      .sort((a, b) => a.number - b.number),
    nested: [],
    reserved: freeze.reservedIn("BaseEvent"),
    file: "events.proto",
  });
  emitted.add("BaseEvent");

  /** Emits an object definition as a plain message. */
  const emitObjectMessage = (
    definition: ObjectDefinition,
    options?: {
      dropDiscriminator?: string;
      isEvent?: boolean;
    },
  ): WireMessage => {
    const scope = protoName(definition.name);
    const exclude = new Set<string>(options?.isEvent ? baseFieldNames : []);
    if (options?.dropDiscriminator) exclude.add(options.dropDiscriminator);

    // FunctionCall nests inside ToolCall on the wire.
    const nested: WireMessage[] = [];
    const fields: WireField[] = [];
    if (options?.isEvent) {
      fields.push(
        makeField(freeze, scope, "base_event", "BaseEvent", {
          comment: "The fields every event carries.",
        }),
      );
    }
    for (const field of definition.fields) {
      if (exclude.has(field.name)) continue;
      // Nested-message convention: a required ref to FunctionCall becomes the
      // nested Function message, matching the deployed wire.
      if (field.type.kind === "ref" && field.type.name === "FunctionCall") {
        const functionDef = defOf(defs, "FunctionCall");
        if (functionDef.kind !== "object")
          throw new WireError("FunctionCall shape");
        nested.push({
          name: "Function",
          comment: functionDef.description,
          fields: messageFields(
            defs,
            freeze,
            `${scope}.Function`,
            functionDef.fields,
            new Set(),
          ).sort((a, b) => a.number - b.number),
          nested: [],
          reserved: freeze.reservedIn(`${scope}.Function`),
          file: FILE_OF[definition.name] ?? DEFAULT_FILE,
        });
        fields.push(
          makeField(freeze, scope, snakeCase(field.name), "Function", {
            optional: !field.required,
            comment: field.description,
            jsonName: field.name,
          }),
        );
        emitted.add("FunctionCall");
        continue;
      }
      fields.push(...messageFields(defs, freeze, scope, [field], new Set()));
    }
    return {
      name: scope,
      comment: definition.description,
      fields: fields.sort((a, b) => a.number - b.number),
      nested,
      reserved: freeze.reservedIn(scope),
      file: options?.isEvent
        ? "events.proto"
        : (FILE_OF[definition.name] ?? DEFAULT_FILE),
    };
  };

  // Every event message.
  for (const eventName of eventUnion.members) {
    const definition = defOf(defs, eventName);
    if (definition.kind !== "object") throw new WireError(`${eventName} shape`);
    messages.push(emitObjectMessage(definition, { isEvent: true }));
    emitted.add(eventName);
  }

  // The envelope.
  const envelope = eventUnion.members.map((eventName) => ({
    entry: snakeCase(eventName.replace(/Event$/, "")),
    definition: eventName,
  }));
  messages.push({
    name: "Event",
    comment: eventUnion.description,
    fields: [],
    oneof: {
      name: "event",
      entries: envelope
        .map(({ entry, definition }) => ({
          name: entry,
          type: definition,
          label: "" as const,
          number: freeze.numberFor(`Event.event.${entry}`, "field"),
        }))
        .sort((a, b) => a.number - b.number),
    },
    nested: [],
    reserved: freeze.reservedIn("Event"),
    file: "events.proto",
  });
  emitted.add("Event");

  // Everything the events reach, by strategy.
  const visit = (name: string): void => {
    if (emitted.has(name)) return;
    const definition = defOf(defs, name);
    emitted.add(name);
    switch (definition.kind) {
      case "alias":
      case "enum":
        return; // aliases resolve to builtins; enums ride as strings
      case "union": {
        const strategy = UNION_STRATEGY[name];
        if (strategy === undefined) {
          throw new WireError(
            `union ${name} has no wire strategy — decide one before it ships`,
          );
        }
        if (strategy === "flatten") {
          // The union dissolves into its parent; nothing to emit, but the
          // members' field types (Interrupt, ...) must still be reached.
          for (const member of definition.members) {
            dissolved.add(member);
            const memberDef = defOf(defs, member);
            if (memberDef.kind === "object") {
              for (const field of memberDef.fields) visitField(field);
            }
          }
          return;
        }
        if (strategy === "merge") {
          for (const member of definition.members) {
            dissolved.add(member);
            const memberDef = defOf(defs, member);
            if (memberDef.kind === "object") {
              for (const field of memberDef.fields) visitField(field);
            }
          }
          messages.push(mergeUnion(defs, freeze, definition));
          return;
        }
        if (strategy === "oneof") {
          const scope = protoName(name);
          const oneofName = name === "InputContentSource" ? "source" : "part";
          const entries: WireField[] = [];
          for (const memberName of definition.members) {
            const member = defOf(defs, memberName);
            if (member.kind !== "object")
              throw new WireError(`${memberName} shape`);
            const discriminatorField = member.fields.find(
              (field) => field.name === definition.discriminator,
            );
            if (
              discriminatorField === undefined ||
              discriminatorField.type.kind !== "literal"
            ) {
              throw new WireError(`${memberName} has no literal discriminator`);
            }
            messages.push(
              emitObjectMessage(member, {
                dropDiscriminator: definition.discriminator,
              }),
            );
            emitted.add(memberName);
            for (const field of member.fields) visitField(field);
            entries.push({
              name: discriminatorField.type.value,
              type: protoName(memberName),
              label: "",
              number: freeze.numberFor(
                `${scope}.${oneofName}.${discriminatorField.type.value}`,
                "field",
              ),
            });
          }
          messages.push({
            name: scope,
            comment: definition.description,
            fields: [],
            oneof: {
              name: oneofName,
              entries: entries.sort((a, b) => a.number - b.number),
            },
            nested: [],
            reserved: freeze.reservedIn(scope),
            file: FILE_OF[name] ?? DEFAULT_FILE,
          });
          return;
        }
        if (strategy === "tagged") {
          const scope = protoName(name);
          const enumName = `${scope}Type`;
          const values: Array<{ name: string; number: number }> = [];
          const merged = new Map<string, WireField>();
          const requiredEverywhere = new Map<string, number>();
          for (const memberName of definition.members) {
            dissolved.add(memberName);
            const member = defOf(defs, memberName);
            if (member.kind !== "object")
              throw new WireError(`${memberName} shape`);
            const discriminator = member.fields.find(
              (field) => field.name === definition.discriminator,
            );
            if (discriminator?.type.kind !== "literal") {
              throw new WireError(`${memberName} discriminator`);
            }
            values.push({
              name: discriminator.type.value.toUpperCase(),
              number: freeze.numberFor(
                `${enumName}.${discriminator.type.value.toUpperCase()}`,
                "enum",
              ),
            });
            for (const field of member.fields) {
              if (field.name === definition.discriminator) continue;
              visitField(field);
              const wireName = snakeCase(field.name);
              if (!merged.has(wireName)) {
                const wire = fieldWireType(
                  defs,
                  field,
                  `${scope}.${field.name}`,
                );
                if ("flatten" in wire)
                  throw new WireError("flatten in tagged union");
                merged.set(
                  wireName,
                  makeField(freeze, scope, wireName, wire.type, {
                    repeated: wire.repeated,
                    optional: !wire.repeated,
                    comment: field.description,
                    jsonName: field.name,
                  }),
                );
                requiredEverywhere.set(wireName, 0);
              }
              if (field.required) {
                requiredEverywhere.set(
                  wireName,
                  (requiredEverywhere.get(wireName) ?? 0) + 1,
                );
              }
            }
          }
          enums.push({
            name: enumName,
            comment: `The ${definition.discriminator} discriminator of ${scope}.`,
            values: values.sort((a, b) => a.number - b.number),
            reserved: freeze.reservedIn(enumName),
            file: FILE_OF[name] ?? DEFAULT_FILE,
          });
          const fields: WireField[] = [
            makeField(
              freeze,
              scope,
              snakeCase(definition.discriminator ?? "op"),
              enumName,
              {
                comment: "Which operation this is.",
                jsonName: definition.discriminator,
              },
            ),
            ...[...merged.values()].map((field) => ({
              ...field,
              label: (field.label === "repeated "
                ? "repeated "
                : requiredEverywhere.get(field.name) ===
                    definition.members.length
                  ? ""
                  : "optional ") as WireField["label"],
            })),
          ];
          messages.push({
            name: scope,
            comment: definition.description,
            fields: fields.sort((a, b) => a.number - b.number),
            nested: [],
            reserved: freeze.reservedIn(scope),
            file: FILE_OF[name] ?? DEFAULT_FILE,
          });
          return;
        }
        throw new WireError(
          `union ${name}: strategy ${strategy} in field position`,
        );
      }
      case "object": {
        for (const field of definition.fields) visitField(field);
        messages.push(emitObjectMessage(definition));
        return;
      }
    }
  };

  const visitField = (field: Field): void => {
    const walk = (type: TypeExpr): void => {
      switch (type.kind) {
        case "ref": {
          const target = defs.get(type.name);
          if (target?.kind === "alias") {
            walk(target.type);
            return;
          }
          if (type.name !== "FunctionCall") visit(type.name);
          return;
        }
        case "array":
          walk(type.items);
          return;
        case "union":
          type.members.forEach(walk);
          return;
        default:
          return;
      }
    };
    walk(field.type);
  };

  // Walk from every event's fields.
  for (const eventName of eventUnion.members) {
    const definition = defOf(defs, eventName);
    if (definition.kind === "object") {
      for (const field of definition.fields) visitField(field);
    }
  }

  assertEveryDefinitionIsOnTheWire(model, emitted, dissolved);

  return {
    enums,
    messages,
    envelope,
    baseFieldNames,
    model,
    defs,
    freeze,
  };
}

/* ------------------------------------------------------------------ */
/* .proto rendering                                                    */
/* ------------------------------------------------------------------ */

function protoBanner(model: ProtocolModel): string {
  return [
    "// @generated by spec/generator — DO NOT EDIT.",
    `// Source: ${model.schemaId}`,
    "// Wire numbers: spec/draft/proto-freeze.txt (append-only; never renumber).",
    "// Regenerate: pnpm --filter @ag-ui/spec generate",
  ].join("\n");
}

function comment(text: string | undefined, indent: string): string[] {
  if (!text) return [];
  const width = 78 - indent.length;
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length > width && current !== "") {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines.map((line) => `${indent}// ${line}`);
}

function renderMessage(message: WireMessage, indent = ""): string[] {
  const lines: string[] = [];
  lines.push(...comment(message.comment, indent));
  lines.push(`${indent}message ${message.name} {`);
  if (message.reserved.length > 0) {
    lines.push(`${indent}  reserved ${message.reserved.join(", ")};`);
  }
  for (const nested of message.nested) {
    lines.push(...renderMessage(nested, `${indent}  `));
  }
  for (const field of message.fields) {
    lines.push(...comment(field.comment, `${indent}  `));
    lines.push(
      `${indent}  ${field.label}${field.type} ${field.name} = ${field.number};`,
    );
  }
  if (message.oneof) {
    lines.push(`${indent}  oneof ${message.oneof.name} {`);
    for (const entry of message.oneof.entries) {
      lines.push(`${indent}    ${entry.type} ${entry.name} = ${entry.number};`);
    }
    lines.push(`${indent}  }`);
  }
  lines.push(`${indent}}`);
  return lines;
}

function renderEnum(wireEnum: WireEnum): string[] {
  // proto3 requires the first enum value to be zero, so an orphaned zero
  // cannot simply become reserved — retiring it is a wire design decision
  // (an UNSPECIFIED placeholder, usually), not something to generate blind.
  if (wireEnum.reserved.includes(0)) {
    throw new WireError(
      `enum ${wireEnum.name}: the zero value was removed — decide its replacement before generating`,
    );
  }
  const lines: string[] = [];
  lines.push(...comment(wireEnum.comment, ""));
  lines.push(`enum ${wireEnum.name} {`);
  if (wireEnum.reserved.length > 0) {
    lines.push(`  reserved ${wireEnum.reserved.join(", ")};`);
  }
  for (const value of wireEnum.values) {
    lines.push(`  ${value.name} = ${value.number};`);
  }
  lines.push("}");
  return lines;
}

const FILE_IMPORTS: Record<string, string[]> = {
  "events.proto": [
    "google/protobuf/struct.proto",
    "patch.proto",
    "types.proto",
  ],
  "types.proto": ["google/protobuf/struct.proto"],
  "patch.proto": ["google/protobuf/struct.proto"],
};

export function emitProtoFiles(
  wire: WireModel,
): Array<{ name: string; content: string }> {
  const files = ["events.proto", "patch.proto", "types.proto"];
  // Each message and enum names the file it belongs in, and the rendering
  // below filters by that name — so a FILE_OF entry naming a file this list
  // does not have drops its message from the output entirely, with generation
  // still succeeding and nothing anywhere saying the type is gone.
  const known = new Set(files);
  const homeless = [
    ...wire.enums
      .filter((wireEnum) => !known.has(wireEnum.file))
      .map((wireEnum) => `enum ${wireEnum.name} -> ${wireEnum.file}`),
    ...wire.messages
      .filter((message) => !known.has(message.file))
      .map((message) => `message ${message.name} -> ${message.file}`),
  ];
  if (homeless.length > 0) {
    throw new WireError(
      `no .proto file is emitted for ${homeless.join(", ")} — add the file to the list ` +
        "here, or fix the FILE_OF entry that routes it there",
    );
  }
  return files.map((file) => {
    const sections: string[] = [
      protoBanner(wire.model),
      'syntax = "proto3";',
      "package ag_ui;",
      "// C#-only option (ignored by the TypeScript and Python generators).",
      'option csharp_namespace = "AGUI.ProtocolBuffers";',
      ...FILE_IMPORTS[file].map((path) => `import "${path}";`),
      ...wire.enums
        .filter((wireEnum) => wireEnum.file === file)
        .map((wireEnum) => renderEnum(wireEnum).join("\n")),
      ...wire.messages
        .filter((message) => message.file === file)
        .map((message) => renderMessage(message).join("\n")),
    ];
    return { name: file, content: sections.join("\n\n") + "\n" };
  });
}

export function emitFreeze(wire: WireModel): string {
  return wire.freeze.emit(
    [
      "# @generated by spec/generator — DO NOT EDIT.",
      `# Source: ${wire.model.schemaId}`,
      "# The protobuf wire freeze: every slot the binary transport has ever",
      "# shipped. Append-only — the generator assigns the next free number to a",
      "# new slot and writes it here; a slot whose schema field is gone becomes",
      "# a reserved number. Nobody authors a number by hand.",
      "# Regenerate: pnpm --filter @ag-ui/spec generate",
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------ */
/* Scan graph                                                          */
/* ------------------------------------------------------------------ */

/**
 * One message level of the malformed-wire scan both runtime translations
 * generate. Canonical protobuf parsers MERGE a repeated occurrence of a
 * singular message-typed field where ts-proto REPLACES it, so the same
 * malformed bytes would materialise differently across runtimes; the scan
 * rejects them instead. Distinct oneof arms are exclusive for the same
 * reason. google.protobuf.* payloads are counted (a duplicate Value or
 * Struct field rejects) but their insides are the runtime library's —
 * the scan does not descend into them.
 */
export interface ScanMessageSpec {
  name: string;
  /** Singular message-typed field numbers: a duplicate occurrence rejects. */
  singular: number[];
  /** Field number -> child message name, descended into recursively. */
  descend: Array<{ number: number; child: string }>;
  /** Oneof arm field numbers: more than one distinct arm rejects. */
  arms?: { name: string; numbers: number[] };
}

export interface ScanGraph {
  /** Envelope entry number -> event message name, all descended into. */
  envelope: Array<{ number: number; child: string }>;
  /** Message specs, only for messages the scan has a reason to visit. */
  specs: ScanMessageSpec[];
}

export function buildScanGraph(wire: WireModel): ScanGraph {
  const byName = new Map<string, WireMessage>();
  const collect = (message: WireMessage): void => {
    byName.set(message.name, message);
    message.nested.forEach(collect);
  };
  wire.messages.forEach(collect);

  const isGoogleType = (type: string): boolean =>
    type.startsWith("google.protobuf.");

  const specOf = (message: WireMessage): ScanMessageSpec => {
    const fields = [...message.fields, ...(message.oneof?.entries ?? [])];
    const singular = fields
      .filter(
        (field) =>
          field.label !== "repeated " &&
          (byName.has(field.type) || isGoogleType(field.type)),
      )
      .map((field) => field.number)
      .sort((a, b) => a - b);
    const descend = fields
      .filter((field) => byName.has(field.type))
      .map((field) => ({ number: field.number, child: field.type }))
      .sort((a, b) => a.number - b.number);
    const arms = message.oneof
      ? {
          name: message.oneof.name,
          numbers: message.oneof.entries
            .map((entry) => entry.number)
            .sort((a, b) => a - b),
        }
      : undefined;
    for (const number of [
      ...singular,
      ...descend.map((entry) => entry.number),
    ]) {
      // Both emitters track duplicates in a 64-bit mask.
      if (number >= 64) {
        throw new WireError(
          `${message.name} field ${number} exceeds the scan's 64-bit mask`,
        );
      }
    }
    return { name: message.name, singular, descend, arms };
  };

  // Walk from the envelope; keep only specs with something to check, and
  // prune descents into messages whose subtree checks nothing.
  const specs = new Map<string, ScanMessageSpec>();
  const visit = (name: string): void => {
    if (specs.has(name)) return;
    const message = byName.get(name);
    if (!message) throw new WireError(`scan graph: no message named ${name}`);
    const spec = specOf(message);
    specs.set(name, spec);
    spec.descend.forEach((entry) => visit(entry.child));
  };
  const envelope = (byName.get("Event")?.oneof?.entries ?? []).map((entry) => ({
    number: entry.number,
    child: entry.type,
  }));
  envelope.forEach((entry) => visit(entry.child));

  // A spec is worthwhile when it checks something itself or leads to one
  // that does. Iterate to a fixpoint, then drop pointless descents.
  const worthwhile = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const spec of specs.values()) {
      if (worthwhile.has(spec.name)) continue;
      if (
        spec.singular.length > 0 ||
        spec.arms !== undefined ||
        spec.descend.some((entry) => worthwhile.has(entry.child))
      ) {
        worthwhile.add(spec.name);
        changed = true;
      }
    }
  }
  const kept = [...specs.values()]
    .filter((spec) => worthwhile.has(spec.name))
    .map((spec) => ({
      ...spec,
      descend: spec.descend.filter((entry) => worthwhile.has(entry.child)),
    }));
  return {
    envelope: envelope.filter((entry) => worthwhile.has(entry.child)),
    specs: kept,
  };
}
