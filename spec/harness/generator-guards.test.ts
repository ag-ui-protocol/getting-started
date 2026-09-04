/**
 * The generator's guards, exercised against schemas the real one is not.
 *
 * Every check here mutates a deep copy of the committed schema, or builds a
 * minimal synthetic document, and asserts the generator FAILS on it by name.
 * The companion assertion in each case is that the real schema still passes —
 * a guard that would reject today's contract is not a guard, it is a bug.
 *
 * These are the defects a generator review found by running the emitters
 * against mutated schemas: constructs that were silently degraded to `any`,
 * tables that quietly stopped matching, definitions that vanished from one
 * target while the drift gate stayed green.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildModel } from "../generator/ir";
import type { ObjectDefinition } from "../generator/ir";
import { FREEZE_PATH, SCHEMA_PATH } from "../generator/generate";
import { emitDotnet } from "../generator/dotnet";
import { emitDotnetModels } from "../generator/dotnet-models";
import { buildWireModel, emitProtoFiles } from "../generator/protobuf";
import { emitModels } from "../generator/python";
import { emitSchemaReference } from "../generator/schema-reference";
import { assertTableKeys } from "../generator/tables";
import { emitTypeScript } from "../generator/typescript";

type Json = Record<string, any>;

const RAW_SCHEMA = readFileSync(SCHEMA_PATH, "utf8");
const FREEZE = readFileSync(FREEZE_PATH, "utf8");

/** A deep copy of the committed schema, free to mutate. */
const realSchema = (): Json => JSON.parse(RAW_SCHEMA) as Json;

/** A minimal document with the same shape the reader expects of the real one. */
const doc = (defs: Json): Json => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ag-ui.example/spec/draft/schema.json",
  description: "A synthetic document, built to exercise one guard.",
  $defs: defs,
});

/** One object definition with a single field, for the field-position guards. */
const fieldDoc = (field: Json): Json =>
  doc({
    Thing: {
      type: "object",
      description: "A thing.",
      properties: { value: field },
      required: ["value"],
    },
  });

const realModel = buildModel(realSchema());
const realWire = buildWireModel(realModel, FREEZE);

describe("the reader's vocabulary", () => {
  it("reads the real schema", () => {
    expect(realModel.definitions.length).toBeGreaterThan(80);
  });

  // An unconstrained position is arbitrary JSON; a position carrying keywords
  // the reader does not model is NOT, and used to become `any` on a comment's
  // say-so — `any` in TypeScript, `Any` in Python, `JsonElement` in .NET, and
  // google.protobuf.Value on the wire, with nothing said anywhere.
  it.each([
    ["a composition", { allOf: [{ $ref: "#/$defs/Thing" }] }, "allOf"],
    [
      "an inline shape",
      { properties: { a: { type: "string" } } },
      "properties",
    ],
    ["a numeric range", { minimum: 0, maximum: 10 }, "maximum"],
    ["a pattern", { pattern: "^x$" }, "pattern"],
    ["a length bound", { minItems: 2 }, "minItems"],
  ])("refuses %s with no type", (_what, keywords, offender) => {
    // Keyed on the offence, not the path: `#/$defs/Thing/properties/value`
    // carries the word "properties" itself, so /properties/ alone passed on
    // any SchemaReadError raised anywhere under that field.
    expect(() =>
      buildModel(fieldDoc({ description: "A value.", ...keywords })),
    ).toThrow(new RegExp(`typeless position carrying .*"${offender}"`));
  });

  it("still reads a genuinely unconstrained position as any", () => {
    const model = buildModel(fieldDoc({ description: "Arbitrary JSON." }));
    const thing = model.definitions.find((d) => d.name === "Thing");
    expect(thing?.kind === "object" && thing.fields[0].type.kind).toBe("any");
  });

  it("refuses a constraint parked next to a const", () => {
    expect(() =>
      buildModel(
        fieldDoc({ description: "A value.", const: "abc", pattern: "^x$" }),
      ),
    ).toThrow(/unmodelled sibling "pattern" next to a const/);
  });

  // PURE_ANNOTATIONS is the reader's one list of keywords that constrain
  // nothing. The $ref branch used to carry a hand-copied subset of it, which
  // had fallen an $anchor behind: a pure annotation, refused as a sibling that
  // would silently combine with the reference's target.
  it("accepts an annotation next to a $ref", () => {
    const model = buildModel(
      doc({
        Named: { type: "string", description: "A name." },
        Thing: {
          type: "object",
          description: "A thing.",
          properties: {
            value: {
              $ref: "#/$defs/Named",
              $anchor: "value",
              description: "A value.",
            },
          },
          required: ["value"],
        },
      }),
    );
    const thing = model.definitions.find((d) => d.name === "Thing");
    expect(thing?.kind === "object" && thing.fields[0].type).toEqual({
      kind: "ref",
      name: "Named",
    });
  });

  it("refuses a definition-level enum whose members are not strings", () => {
    // Keyed on the offence: the path `#/$defs/Count` prefixes every
    // SchemaReadError this definition could raise, so /Count/ passed on all of
    // them rather than on this one.
    expect(() =>
      buildModel(
        doc({
          Count: {
            type: "integer",
            description: "How many.",
            enum: [1, 2, 3],
          },
        }),
      ),
    ).toThrow(/enum on a non-string definition/);
  });

  // `title` is an annotation nothing models. The document has one; a
  // definition with one would be silently dropped from every output.
  it("accepts title on the document and refuses it on a definition", () => {
    expect(JSON.parse(RAW_SCHEMA).title).toBeTypeOf("string");
    expect(() =>
      buildModel(
        doc({
          Thing: {
            type: "string",
            title: "A Thing",
            description: "A thing.",
          },
        }),
      ),
    ).toThrow(/keyword "title" is not modelled by the generator/);
  });

  /**
   * A union named Either over the members given, each pinning the fields it is
   * given to a const of that value. Every member also gets a field of its own,
   * so the members differ in shape whatever they pin — a union of two
   * identical objects is meaningless for reasons that are not the point here.
   */
  const unionDoc = (members: Record<string, Record<string, string>>): Json =>
    doc({
      ...Object.fromEntries(
        Object.entries(members).map(([name, pins], index) => [
          name,
          {
            type: "object",
            description: `The ${name} one.`,
            properties: {
              ...Object.fromEntries(
                Object.entries(pins).map(([field, value]) => [
                  field,
                  { const: value, description: `The ${field}.` },
                ]),
              ),
              [`own${index}`]: { type: "string", description: "Its own." },
            },
            required: [...Object.keys(pins), `own${index}`],
          },
        ]),
      ),
      Either: {
        description: "One of them.",
        oneOf: Object.keys(members).map((name) => ({
          $ref: `#/$defs/${name}`,
        })),
      },
    });

  /** The discriminator the reader found for that union. */
  const discriminatorOf = (
    members: Record<string, Record<string, string>>,
  ): string | undefined => {
    const either = buildModel(unionDoc(members)).definitions.find(
      (definition) => definition.name === "Either",
    );
    if (either?.kind !== "union") throw new Error("no Either union");
    return either.discriminator;
  };

  // A field every member pins to the SAME value is a constant they share — a
  // version tag every member carries — not a botched discriminator. Such a
  // union is genuinely tagless, and a plain union is the right output.
  it("reads a union whose members share a constant as tagless", () => {
    expect(
      discriminatorOf({ Left: { version: "1" }, Right: { version: "1" } }),
    ).toBeUndefined();
  });

  // Members pinning DIFFERENT fields is the other tagless shape: no field is
  // pinned everywhere, so there is nothing to narrow on and nothing wrong.
  it("reads a union whose members pin different fields as tagless", () => {
    expect(
      discriminatorOf({ Left: { kind: "left" }, Right: { flavour: "right" } }),
    ).toBeUndefined();
  });

  // A field some members pin alike and others pin differently is neither: the
  // emitters used to fall back to an un-narrowed union with no warning.
  it("refuses a union whose discriminator values partially collide", () => {
    expect(() =>
      discriminatorOf({ A: { kind: "x" }, B: { kind: "x" }, C: { kind: "y" } }),
    ).toThrow(
      /kind \(x\)[\s\S]*neither discriminates the union nor is a constant every member shares/,
    );
  });

  // And a colliding field does not hide a real one: the union is narrowed on
  // the field that does discriminate, whichever order they are declared in.
  it("takes the field that discriminates over one that collides", () => {
    expect(
      discriminatorOf({
        A: { group: "g", tag: "a" },
        B: { group: "g", tag: "b" },
        C: { group: "h", tag: "c" },
      }),
    ).toBe("tag");
  });
});

describe("the protobuf emitter", () => {
  /** The merged Message message, as a wire name -> presence label map. */
  const messagePresence = (schema: Json): Record<string, string> => {
    const wire = buildWireModel(buildModel(schema), FREEZE);
    const message = wire.messages.find((entry) => entry.name === "Message");
    if (!message) throw new Error("no merged Message message");
    return Object.fromEntries(
      message.fields.map((field) => [field.name, field.label]),
    );
  };

  it("gives a merged union the same presence whatever order its members are in", () => {
    const reordered = realSchema();
    const members = reordered.$defs.Message.oneOf as Json[];
    const activity = members.findIndex(
      (member) => member.$ref === "#/$defs/ActivityMessage",
    );
    expect(activity).toBeGreaterThan(-1);
    members.push(...members.splice(activity, 1));

    // activity_type belongs to one member of seven, so it is optional however
    // the schema lists them. Moving that member last used to flip it to
    // implicit presence: the same field number, different wire semantics, and
    // the freeze pins numbers only.
    expect(messagePresence(realSchema()).activity_type).toBe("optional ");
    expect(messagePresence(reordered)).toEqual(messagePresence(realSchema()));
  });

  it("refuses a merged union variant it has no wire bucket for", () => {
    const schema = realSchema();
    schema.$defs.ActivityMessage.properties.weight = {
      description: "A label or a count.",
      oneOf: [{ type: "string" }, { type: "integer" }],
    };
    expect(() => buildWireModel(buildModel(schema), FREEZE)).toThrow(
      /a "integer" variant has no MERGE_SPLIT bucket/,
    );
  });

  it("refuses a definition no .proto file carries", () => {
    const schema = realSchema();
    schema.$defs.BrandNewThing = {
      type: "object",
      description: "A definition nothing references.",
      properties: { label: { type: "string", description: "A label." } },
      required: ["label"],
    };
    expect(() => buildWireModel(buildModel(schema), FREEZE)).toThrow(
      /nothing on the wire carries BrandNewThing/,
    );
  });

  it("refuses a message routed to a file nothing emits", () => {
    const wire = buildWireModel(buildModel(realSchema()), FREEZE);
    const message = wire.messages.find((entry) => entry.name === "Tool");
    if (!message) throw new Error("no Tool message");
    message.file = "nowhere.proto";
    expect(() => emitProtoFiles(wire)).toThrow(
      /no \.proto file is emitted for message Tool/,
    );
  });

  it("refuses FunctionCall anywhere but the nested position it is written in", () => {
    const schema = realSchema();
    schema.$defs.ToolCall.properties.retries = {
      type: "array",
      items: { $ref: "#/$defs/FunctionCall" },
      description: "Earlier attempts at this call.",
    };
    expect(() => buildWireModel(buildModel(schema), FREEZE)).toThrow(
      /FunctionCall is only carried as the nested Function message/,
    );
  });

  it("emits every .proto file the real schema needs", () => {
    expect(emitProtoFiles(realWire).map((file) => file.name)).toEqual([
      "events.proto",
      "patch.proto",
      "types.proto",
    ]);
  });
});

describe("the .NET emitters", () => {
  it("refuses a definition no C# class carries", () => {
    const schema = realSchema();
    schema.$defs.BrandNewThing = {
      type: "object",
      description: "A definition nothing references.",
      properties: { label: { type: "string", description: "A label." } },
      required: ["label"],
    };
    expect(() => emitDotnetModels(buildModel(schema))).toThrow(
      /the \.NET models write no class for BrandNewThing/,
    );
  });

  it("refuses an event field the mappers have no encode and decode for", () => {
    const schema = realSchema();
    schema.$defs.StepStartedEvent.properties.labels = {
      type: "array",
      items: { type: "string", description: "A label." },
      description: "Labels on the step.",
    };
    const wire = buildWireModel(buildModel(schema), FREEZE);
    expect(() => emitDotnet(wire)).toThrow(/encode: unhandled kind stringArray/);
  });

  it("writes the real models and mappers", () => {
    expect(emitDotnetModels(realModel).length).toBeGreaterThan(0);
    expect(emitDotnet(realWire).length).toBe(3);
  });
});

describe("the name-keyed idiom tables", () => {
  it("accepts keys the model has", () => {
    expect(() =>
      assertTableKeys(
        "A_TABLE",
        ["RunAgentInput", "RunAgentInput.state", "BaseEvent.timestamp"],
        realModel,
      ),
    ).not.toThrow();
  });

  it("names the table and the stale key", () => {
    expect(() =>
      assertTableKeys("A_TABLE", ["NoSuchDefinition.state"], realModel),
    ).toThrow(/\(no definition named NoSuchDefinition\)/);
    expect(() =>
      assertTableKeys("A_TABLE", ["RunAgentInput.noSuchField"], realModel),
    ).toThrow(/\(RunAgentInput has no field noSuchField\)/);
  });

  // The emitter-level version of the same thing: rename the definition an
  // entry is keyed by and the entry stops matching, silently reverting the
  // field to the emitter's default.
  it("fails the TypeScript emitter when a table stops matching", () => {
    const schema = realSchema();
    schema.$defs.RunAgentInputRenamed = schema.$defs.RunAgentInput;
    delete schema.$defs.RunAgentInput;
    const raw = JSON.stringify(schema).replace(
      /#\/\$defs\/RunAgentInput"/g,
      '#/$defs/RunAgentInputRenamed"',
    );
    expect(() => emitTypeScript(buildModel(JSON.parse(raw)))).toThrow(
      /NULL_MEANS_ABSENT.*RunAgentInput\.state/s,
    );
  });
});

describe("the Python emitter", () => {
  /** The index of the first line starting with `needle`. */
  const lineOf = (source: string[], needle: string): number => {
    const index = source.findIndex((line) => line.startsWith(needle));
    if (index === -1) throw new Error(`no line starting "${needle}"`);
    return index;
  };

  /**
   * A mixin's class can annotate a field with ANOTHER mixin's class, and the
   * shapes arrive alphabetically, so the two bounds the placement already
   * respects — after everything the mixin names, before the first definition
   * that inherits it — leave the mixins' order among themselves to the
   * alphabet. No schema the reader accepts builds this case today (a
   * definition referenced from anywhere but an allOf stops being a mixin), so
   * it is built into the model by hand. Python is read top to bottom either
   * way, and the wrong order costs a NameError at import time while every
   * generated file still regenerates byte for byte.
   */
  it("declares a mixin another mixin's field names before that mixin", () => {
    const model = buildModel(realSchema());
    const span: ObjectDefinition = {
      kind: "object",
      name: "ZSpanBase",
      description: "A mixin an alphabetically earlier mixin names.",
      fields: [
        {
          name: "traceId",
          description: "The trace this belongs to.",
          required: true,
          type: { kind: "string" },
        },
      ],
      closed: false,
      composedMixins: [],
    };
    const attributable = model.mixinShapes.find(
      (shape) => shape.name === "Attributable",
    );
    if (!attributable) throw new Error("no Attributable mixin");
    attributable.fields = [
      ...attributable.fields,
      {
        name: "span",
        description: "Where this ran.",
        required: false,
        type: { kind: "ref", name: "ZSpanBase" },
      },
    ];
    model.mixinShapes = [...model.mixinShapes, span].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    model.mixins = model.mixinShapes.map((shape) => shape.name);

    const source = emitModels(model).split("\n");
    expect(lineOf(source, "class ZSpanBase(")).toBeLessThan(
      lineOf(source, "class Attributable("),
    );
  });

  it("declares a mixin's references before the mixin that uses them", () => {
    const schema = realSchema();
    schema.$defs.BaseMessage.properties.role = {
      $ref: "#/$defs/Role",
      description:
        "Who the message is from. Each message definition narrows this to a single value.",
    };
    const source = emitModels(buildModel(schema)).split("\n");
    const at = (needle: string): number => {
      const index = source.findIndex((line) => line.startsWith(needle));
      if (index === -1) throw new Error(`no line starting "${needle}"`);
      return index;
    };
    expect(at("Role = Literal[")).toBeLessThan(at("class BaseMessage("));
    // And the mixin every event subclasses is still declared before them.
    expect(at("class BaseEvent(")).toBeLessThan(
      at("class TextMessageStartEvent("),
    );
  });

  it("keeps the constraints on an array's items", () => {
    const schema = realSchema();
    schema.$defs.Context.properties.weights = {
      type: "array",
      items: { type: "integer", minimum: 0, description: "A weight." },
      description: "How much each entry counts for.",
    };
    // zodType already recurses and keeps these; pyType returned a bare List.
    expect(emitModels(buildModel(schema))).toContain(
      "List[Annotated[int, Field(ge=0)]]",
    );
  });
});

describe("the schema reference page", () => {
  it("refuses a definition two sections both claim", () => {
    const schema = realSchema();
    schema.$defs.InputContentOutcome = {
      type: "object",
      description: "A name both the input and the outcome section match.",
      properties: { label: { type: "string", description: "A label." } },
      required: ["label"],
    };
    expect(() => emitSchemaReference(buildModel(schema))).toThrow(
      /InputContentOutcome would be rendered in both/,
    );
  });

  it("renders the real page", () => {
    expect(emitSchemaReference(realModel)).toContain("## Events");
  });
});
