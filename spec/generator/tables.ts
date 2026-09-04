/**
 * The check every name-keyed idiom table needs.
 *
 * Each emitter carries tables keyed by a definition name, or by
 * `Definition.field`, that say how one specific thing is rendered: which enum
 * becomes a real enum, which required string stays nullable, which definition
 * lands in which .proto file. They are keyed by NAME, so a rename in the schema
 * does not fail them — it silently stops matching, and the entry reverts to the
 * emitter's default. That is the quietest kind of drift there is: the generator
 * succeeds, the drift gate compares the generator only against its own output,
 * and the deliberate idiom is simply gone.
 *
 * So every table asserts its keys still name something the model has, and says
 * which table and which key went stale when they do not.
 */

import type { ProtocolModel } from "./ir";

/**
 * How a table spells the names it is keyed by, where that is not the schema's
 * own spelling — the protobuf tables are keyed by wire names, for instance.
 */
export interface TableKeySpelling {
  /** The table's spelling of a definition name. Identity by default. */
  definitionName?: (name: string) => string;
  /** The table's spelling of a field name. Identity by default. */
  fieldName?: (name: string) => string;
}

/**
 * Asserts every key of a name-keyed table still names a definition (or a
 * mixin), and — for a `Definition.field` key — a field that definition has.
 */
export function assertTableKeys(
  table: string,
  keys: Iterable<string>,
  model: ProtocolModel,
  spelling: TableKeySpelling = {},
): void {
  const spellDefinition = spelling.definitionName ?? ((name: string) => name);
  const spellField = spelling.fieldName ?? ((name: string) => name);

  const fieldsOf = new Map<string, Set<string>>();
  const shapes = [...model.definitions, ...model.mixinShapes];
  for (const definition of shapes) {
    const fields =
      definition.kind === "object"
        ? definition.fields.map((field) => spellField(field.name))
        : [];
    fieldsOf.set(spellDefinition(definition.name), new Set(fields));
  }

  const complaints: string[] = [];
  for (const key of keys) {
    const dot = key.indexOf(".");
    const definitionName = dot === -1 ? key : key.slice(0, dot);
    const fields = fieldsOf.get(definitionName);
    if (fields === undefined) {
      complaints.push(`${key} (no definition named ${definitionName})`);
      continue;
    }
    if (dot === -1) continue;
    const fieldName = key.slice(dot + 1);
    if (!fields.has(fieldName)) {
      complaints.push(`${key} (${definitionName} has no field ${fieldName})`);
    }
  }

  if (complaints.length > 0) {
    throw new Error(
      `${table} names things the schema does not have: ${complaints.join(", ")} — ` +
        "the table is keyed by name, so a rename does not fail it, it just stops " +
        "matching and reverts the entry to the emitter's default; update the table",
    );
  }
}
