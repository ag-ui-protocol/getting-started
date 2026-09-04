import { describe, expect, it } from "vitest";
import {
  createAjv,
  definitionNames,
  eventDefinitions,
  shapedDefinitions,
  schema,
  SCHEMA_ID,
  unionMembers,
  validatorFor,
} from "./validator";

/** Every keyword JSON Schema 2020-12 defines, plus the annotations it defines.
 *  A keyword outside this set is a custom annotation, which this contract
 *  deliberately does not use: the whole reason for staying inside the standard
 *  vocabulary is that any generic validator can read the file. */
const STANDARD_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$ref",
  "$defs",
  "$comment",
  "$vocabulary",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "prefixItems",
  "items",
  "contains",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxContains",
  "minContains",
  "maxProperties",
  "minProperties",
  "required",
  "dependentRequired",
  "format",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
]);

/**
 * The keywords this contract actually uses.
 *
 * Tighter than the standard vocabulary on purpose. A keyword outside this set
 * can quietly change what a document means — `propertyNames` or a conditional
 * would reshape validation in ways none of these tests look for. So the
 * vocabulary is pinned rather than policed one keyword at a time. Adding one
 * fails this test, which is the prompt to decide what it means for the contract
 * before the contract starts relying on it.
 */
const USED_KEYWORDS = new Set([
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

/**
 * The shaped definitions that stay open, each for a stated reason. Everything
 * else describing an object closes with `unevaluatedProperties: false`: the
 * schema defines exactly what exists, and tolerating fields from a newer
 * version is the receiver's job, not the validator's.
 */
// Mixins, composed into other definitions via allOf. The composing definition
// closes the whole shape; a mixin that closed itself would reject the very
// properties its composers add, because evaluation runs bottom-up.
const MIXINS = new Set(["BaseEvent", "Attributable", "BaseMessage"]);

const OPEN_DEFINITIONS = new Set([
  ...MIXINS,
  // RFC 6902 operations. Section 4 requires members an operation does not
  // define to be ignored rather than rejected, so closing them would make this
  // copy unfaithful to the standard it mirrors.
  "AddOperation",
  "RemoveOperation",
  "ReplaceOperation",
  "MoveOperation",
  "CopyOperation",
  "TestOperation",
]);

type Json = Record<string, unknown>;

/** Walks the file, calling back at every schema position with its keywords. */
function walkSchema(
  root: Json,
  visit: (node: Json, path: string) => void,
): void {
  const step = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return;
    const object = node as Json;
    visit(object, path);
    for (const [key, value] of Object.entries(object)) {
      if (
        key === "properties" ||
        key === "$defs" ||
        key === "patternProperties" ||
        key === "dependentSchemas"
      ) {
        for (const [name, child] of Object.entries(value as Json)) {
          step(child, `${path}/${key}/${name}`);
        }
      } else if (
        key === "oneOf" ||
        key === "anyOf" ||
        key === "allOf" ||
        key === "prefixItems"
      ) {
        (value as unknown[]).forEach((child, index) =>
          step(child, `${path}/${key}/${index}`),
        );
      } else if (
        key === "items" ||
        key === "not" ||
        key === "if" ||
        key === "then" ||
        key === "else" ||
        key === "contains" ||
        key === "additionalProperties" ||
        key === "propertyNames" ||
        key === "unevaluatedProperties" ||
        key === "unevaluatedItems" ||
        key === "contentSchema"
      ) {
        step(value, `${path}/${key}`);
      }
    }
  };
  step(root, "");
}

describe("the schema file itself", () => {
  it("validates against the 2020-12 meta-schema", () => {
    const ajv = createAjv();
    expect(ajv.validateSchema(schema)).toBe(true);
  });

  it("compiles every definition, so strict mode sees every corner of the file", () => {
    // Registering a schema does not compile it, and strict mode's unknown-keyword
    // check runs at compile time. So a misspelled keyword in a definition nothing
    // happened to compile would sit there unreported. Compiling all of them is
    // what turns strict mode into a real gate.
    const ajv = createAjv();
    const targets = [
      ...definitionNames().map((name) => `${SCHEMA_ID}#/$defs/${name}`),
      SCHEMA_ID,
    ];
    for (const target of targets) {
      expect(() => ajv.getSchema(target), target).not.toThrow();
      expect(ajv.getSchema(target), `${target} did not compile`).toBeTypeOf(
        "function",
      );
    }
  });

  it("still rejects a misspelled keyword, despite $anchor being declared", () => {
    // `$anchor` has to be declared to ajv because its strict-mode allowlist omits
    // this one standard keyword. That declaration must not become a hole: a
    // genuine typo has to keep failing, or strict mode is decoration.
    const ajv = createAjv();
    expect(() =>
      ajv.compile({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        requred: ["id"],
      }),
    ).toThrow(/unknown keyword/);
  });

  it("resolves every anchor, so the published per-definition addresses work", () => {
    const ajv = createAjv();
    for (const name of definitionNames()) {
      const validate = ajv.getSchema(`${SCHEMA_ID}#${name}`);
      expect(validate, `${SCHEMA_ID}#${name} does not resolve`).toBeTypeOf(
        "function",
      );
    }
  });

  it("gives every definition an anchor matching its name", () => {
    const missing: string[] = [];
    for (const [name, def] of Object.entries(
      (schema.$defs ?? {}) as Record<string, Json>,
    )) {
      if (def.$anchor !== name) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it("uses only the keywords the harness understands", () => {
    const unexpected = new Set<string>();
    walkSchema(schema, (node) => {
      for (const key of Object.keys(node)) {
        if (!USED_KEYWORDS.has(key)) unexpected.add(key);
      }
    });
    expect([...unexpected].sort()).toEqual([]);
  });

  it("uses no keyword outside the standard vocabulary", () => {
    const offenders: string[] = [];
    walkSchema(schema, (node, path) => {
      for (const key of Object.keys(node)) {
        if (!STANDARD_KEYWORDS.has(key)) offenders.push(`${path}: ${key}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it("resolves every reference within the file, with nothing dangling", () => {
    const dangling: string[] = [];
    const defs = (schema.$defs ?? {}) as Json;
    const anchors = new Set<string>();
    walkSchema(schema, (node) => {
      if (typeof node.$anchor === "string") anchors.add(node.$anchor);
    });

    walkSchema(schema, (node, path) => {
      const ref = node.$ref;
      if (typeof ref !== "string") return;
      const [target, fragment = ""] = ref.split("#");
      if (target !== "") {
        // The file is self-contained on purpose: a consumer downloads one file
        // and validates, with nothing else to fetch or register.
        dangling.push(`${path}: reference to another file "${target}"`);
        return;
      }
      if (fragment.startsWith("/$defs/")) {
        const name = fragment.replace("/$defs/", "");
        if (!(name in defs)) {
          dangling.push(`${path}: no definition "${name}"`);
        }
      } else if (fragment !== "" && !anchors.has(fragment)) {
        dangling.push(`${path}: no anchor "${fragment}"`);
      }
    });

    expect(dangling).toEqual([]);
  });

  it("names every property in camelCase, because it describes the wire and not a language", () => {
    const offenders: string[] = [];
    walkSchema(schema, (node, path) => {
      const properties = node.properties as Json | undefined;
      for (const name of Object.keys(properties ?? {})) {
        if (!/^[a-z][a-zA-Z0-9]*$/.test(name))
          offenders.push(`${path}: ${name}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it("gives every field a description, so no meaning has to live in a generator template", () => {
    const undocumented: string[] = [];
    const defs = (schema.$defs ?? {}) as Record<string, Json>;

    /** The property names a definition inherits by composition. A property the
     *  definition then redeclares is narrowing an inherited field — the `type`
     *  const on each event, the `role` const on each message — and its meaning
     *  is documented once on the field it narrows, not once per event. */
    const inheritedNames = (def: Json): Set<string> => {
      const names = new Set<string>();
      for (const parent of (def.allOf as
        | Array<{ $ref?: string }>
        | undefined) ?? []) {
        const ref = parent.$ref;
        if (!ref?.startsWith("#/$defs/")) continue;
        const parentDef = defs[ref.replace("#/$defs/", "")];
        if (!parentDef) continue;
        for (const name of Object.keys((parentDef.properties ?? {}) as Json))
          names.add(name);
        for (const name of inheritedNames(parentDef)) names.add(name);
      }
      return names;
    };

    walkSchema(schema, (node, path) => {
      const properties = node.properties as Json | undefined;
      if (!properties) return;
      const inherited = inheritedNames(node);
      for (const [name, child] of Object.entries(properties)) {
        const subschema = child as Json;
        if (typeof subschema.description === "string") continue;
        // A field that only $refs a definition inherits that definition's
        // description — but only if the definition actually has one. Exempting
        // the reference without following it left `snapshot` undocumented while
        // this test reported success.
        const ref = subschema.$ref;
        if (typeof ref === "string") {
          const target = ref.startsWith("#/$defs/")
            ? (defs[ref.replace("#/$defs/", "")] as Json | undefined)
            : undefined;
          if (typeof target?.description === "string") continue;
          undocumented.push(`${path}/${name} (via ${ref})`);
          continue;
        }
        if (inherited.has(name)) continue;
        undocumented.push(`${path}/${name}`);
      }
    });

    expect(undocumented).toEqual([]);
  });
});

describe("closure", () => {
  it("closes every shaped definition, except the ones open for a stated reason", () => {
    // The schema is exact: a property it does not declare fails validation.
    // Tolerating fields from a newer minor version is the receiver's job — the
    // generated SDK boundaries strip what they do not recognise and warn — and
    // a validator cannot express strip-and-warn, so it does not try.
    const wrong: string[] = [];
    for (const name of shapedDefinitions()) {
      const def = (schema.$defs as Record<string, Json>)[name];
      const closed = def.unevaluatedProperties === false;
      if (OPEN_DEFINITIONS.has(name) && "unevaluatedProperties" in def) {
        wrong.push(`${name} is on the open list but declares closure`);
      }
      if (!OPEN_DEFINITIONS.has(name) && !closed) {
        wrong.push(`${name} is not closed`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("declares unevaluatedProperties only as false, directly on a definition", () => {
    // `unevaluatedProperties: true` inside an allOf member evaluates every
    // property, which neutralises the composing definition's own
    // `unevaluatedProperties: false` — annotations flow up from successfully
    // evaluated subschemas. So the keyword is confined to the one position and
    // the one value the closure design uses.
    const offenders: string[] = [];
    walkSchema(schema, (node, path) => {
      if (!("unevaluatedProperties" in node)) return;
      if (
        node.unevaluatedProperties !== false ||
        !/^\/\$defs\/[A-Za-z]+$/.test(path)
      ) {
        offenders.push(path);
      }
    });
    expect(offenders).toEqual([]);
  });

  it("composes only the mixins, so no allOf member can reopen a closed shape", () => {
    // An allOf member is evaluated alongside the definition's own schema, so a
    // member that evaluates arbitrary properties — an inline
    // `unevaluatedProperties: true`, or a reference to an open-by-key
    // definition such as Metadata — would make every property "evaluated" and
    // switch the closure off. Composition in this schema means one thing:
    // pulling in a mixin. Anything else fails here.
    const offenders: string[] = [];
    walkSchema(schema, (node, path) => {
      const allOf = node.allOf as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(allOf)) return;
      allOf.forEach((member, index) => {
        const keys = Object.keys(member);
        const ref = member.$ref as string | undefined;
        const target = ref?.replace("#/$defs/", "");
        if (keys.length !== 1 || !ref || !target || !MIXINS.has(target)) {
          offenders.push(`${path}/allOf/${index}`);
        }
      });
    });
    // A `$ref` sitting directly on a definition is composition by another
    // name — in 2020-12 it applies in place, alongside the definition's own
    // keywords, so one pointing at an open schema would reopen the shape just
    // like a rogue allOf member. Definitions reference; they do not carry a
    // sibling $ref.
    for (const [name, def] of Object.entries(
      (schema.$defs ?? {}) as Record<string, Json>,
    )) {
      if ("$ref" in def) offenders.push(`/$defs/${name}: sibling $ref`);
    }
    expect(offenders).toEqual([]);
  });

  it("lists no definition as open that does not exist or has no shape", () => {
    // A renamed definition must not leave a stale exemption behind that would
    // silently apply to nothing — or worse, to a future definition reusing the
    // name.
    const shaped = new Set(shapedDefinitions());
    const stale = [...OPEN_DEFINITIONS].filter((name) => !shaped.has(name));
    expect(stale).toEqual([]);
  });

  it("uses additionalProperties only at the pinned open-by-key positions", () => {
    // `additionalProperties: true` evaluates every property, which neutralises
    // an `unevaluatedProperties: false` on the same schema — so one added to a
    // closed definition would quietly reopen it while the closure test above
    // stayed green. The keyword is therefore pinned by exact location: the
    // objects that are open by meaning, and nowhere else. A value other than
    // `true` is never legitimate — `false` or a schema would be a second
    // closure mechanism.
    const OPEN_BY_KEY = new Set([
      "/$defs/Metadata",
      "/$defs/ActivitySnapshotEvent/properties/content",
      "/$defs/ActivityMessage/properties/content",
      "/$defs/Interrupt/properties/responseSchema",
      // The capability model's escape hatch: an integration declares whatever
      // the standard categories do not cover, so the protocol cannot know the
      // keys and does not constrain the values.
      "/$defs/AgentCapabilities/properties/custom",
    ]);
    const offenders: string[] = [];
    const seen = new Set<string>();
    walkSchema(schema, (node, path) => {
      if ("additionalProperties" in node) {
        seen.add(path);
        if (node.additionalProperties !== true || !OPEN_BY_KEY.has(path)) {
          offenders.push(path);
        }
      }
      // `not` can reject properties just as effectively, and boolean-false
      // property schemas close an object against a field it claims to have.
      if ("not" in node) offenders.push(`${path}: not`);
      for (const [name, child] of Object.entries(
        (node.properties ?? {}) as Record<string, unknown>,
      )) {
        if (child === false)
          offenders.push(`${path}/properties/${name}: false`);
      }
    });
    expect(offenders).toEqual([]);
    // And no stale pin: a renamed or removed open-by-key position must not
    // leave an exemption behind.
    expect([...OPEN_BY_KEY].filter((path) => !seen.has(path))).toEqual([]);
  });

  it("pins every position that accepts any JSON at all", () => {
    // OPEN_BY_KEY above pins the KEYWORD, not the openness. It fires only
    // where the literal `additionalProperties` appears, so a slot that accepts
    // anything WITHOUT saying so is invisible to it: `{"type": "object"}` with
    // no `properties`, or a slot with no `type` at all. Both accept every
    // document a wide-open `additionalProperties: true` would.
    //
    // Measured against this schema, by calling the generator's IR reader
    // (`buildModel` from ../generator/ir) on a doctored copy:
    //
    //   - `"sidecar": {"type": "object"}` on the closed CustomEvent, and a
    //     whole new property-less `OpenBlob` definition of the same shape, are
    //     both REFUSED before anything here runs: ir.ts throws
    //     `object without additionalProperties: true` on each. So neither is
    //     silently accepted — but the refusal comes from the generator
    //     declining to read the schema, not from any closure check having seen
    //     an open slot. The closure check in this file does not see them
    //     either: `shapedDefinitions()` filters on
    //     `effectiveProperties(name).length > 0`, and a property-less
    //     definition has none.
    //   - Write either as `{"type": "object", "additionalProperties": true}`
    //     and buildModel accepts it — at which point OPEN_BY_KEY above catches
    //     it, because that pin fires on the literal keyword.
    //   - The shape nothing above catches is a slot with NO `type` and no
    //     keyword at all: `{"description": "…"}` in a property position.
    //     buildModel accepts that, and OPEN_BY_KEY has no keyword to fire on.
    //     It admits every document a wide-open `additionalProperties: true`
    //     would.
    //
    // That last one is what this check exists for.
    //
    // So the unconstrained positions get the same treatment as the open-by-key
    // ones: pinned by exact location with a reason, and a stale pin fails too.
    // Sixteen slots in this schema are deliberately "any JSON" — every one of
    // them is a place the protocol carries a payload it does not own.
    const UNCONSTRAINED_BY_KEY = new Map([
      [
        "/$defs/BaseEvent/properties/rawEvent",
        "the producer's own event, carried verbatim; the protocol never reads it",
      ],
      ["/$defs/State", "agent state is any JSON value, falsy and null included"],
      [
        "/$defs/RawEvent/properties/event",
        "the whole point of RAW is that the payload is not ours",
      ],
      [
        "/$defs/CustomEvent/properties/value",
        "an integration's own payload, routed by `name` and never interpreted",
      ],
      [
        "/$defs/RunFinishedEvent/properties/result",
        "whatever the agent returns; the protocol does not model return values",
      ],
      [
        "/$defs/SubagentFinishedEvent/properties/result",
        "same as the run's result, one level down",
      ],
      [
        "/$defs/ResumeEntry/properties/payload",
        "the answer to an interrupt, shaped by that interrupt's responseSchema",
      ],
      [
        "/$defs/ImageInputContent/properties/metadata",
        "producer metadata about the attachment; not protocol vocabulary",
      ],
      [
        "/$defs/AudioInputContent/properties/metadata",
        "producer metadata about the attachment; not protocol vocabulary",
      ],
      [
        "/$defs/VideoInputContent/properties/metadata",
        "producer metadata about the attachment; not protocol vocabulary",
      ],
      [
        "/$defs/DocumentInputContent/properties/metadata",
        "producer metadata about the attachment; not protocol vocabulary",
      ],
      [
        "/$defs/Tool/properties/parameters",
        "a JSON Schema document belonging to the tool, not to this contract",
      ],
      [
        "/$defs/RunAgentInput/properties/forwardedProps",
        "the caller's passthrough bag, forwarded untouched to the agent",
      ],
      [
        "/$defs/AddOperation/properties/value",
        "RFC 6902 operand: state is any JSON, so the operand is too",
      ],
      [
        "/$defs/ReplaceOperation/properties/value",
        "RFC 6902 operand: state is any JSON, so the operand is too",
      ],
      [
        "/$defs/TestOperation/properties/value",
        "RFC 6902 operand: state is any JSON, so the operand is too",
      ],
    ]);

    // A slot is constrained when it says ANYTHING about what may sit there:
    // it declares properties, composes, enumerates, pins a constant, refers to
    // a definition, or pins a type that is not `object`. `description` alone
    // says nothing a validator can act on.
    const CONSTRAINING = [
      "properties",
      "additionalProperties",
      "unevaluatedProperties",
      "patternProperties",
      "$ref",
      "allOf",
      "oneOf",
      "anyOf",
      "enum",
      "const",
    ];
    const isUnconstrained = (node: Json): boolean => {
      if (CONSTRAINING.some((keyword) => keyword in node)) return false;
      const declared = node.type;
      const types = Array.isArray(declared)
        ? (declared as string[])
        : declared === undefined
          ? []
          : [declared as string];
      // `"null"` alongside `"object"` narrows nothing that matters here.
      const meaningful = types.filter((name) => name !== "null");
      return meaningful.length === 0 || meaningful.includes("object");
    };

    const found: string[] = [];
    walkSchema(schema, (node, path) => {
      if (isUnconstrained(node)) found.push(path);
    });
    // The root itself composes, so it never reaches this list; if it ever
    // does, the walk found nothing and the whole check is vacuous.
    expect(found, "the walk found no schema nodes at all").not.toEqual([]);
    expect(
      found.filter((path) => !UNCONSTRAINED_BY_KEY.has(path)),
      "a new position accepts any JSON without being pinned. If that is " +
        "deliberate, add it to UNCONSTRAINED_BY_KEY with the reason; if it is " +
        "not, give it a type, a $ref or properties — an unpinned open slot is " +
        "invisible to every closure check in this file.",
    ).toEqual([]);
    expect(
      [...UNCONSTRAINED_BY_KEY.keys()].filter((path) => !found.includes(path)),
      "a pinned unconstrained position no longer exists, or is no longer open",
    ).toEqual([]);
  });
});

describe("the event union", () => {
  it("has no duplicates", () => {
    const members = unionMembers();
    expect(new Set(members).size).toBe(members.length);
  });

  it("contains every definition that is an event, and nothing that is not", () => {
    expect([...eventDefinitions().values()].sort()).toEqual(
      [...unionMembers()].sort(),
    );
  });

  it("declares every event type in the EventType enum, and no others", () => {
    const enumValues = (schema.$defs as Json).EventType as Json;
    expect((enumValues.enum as string[]).slice().sort()).toEqual(
      [...eventDefinitions().keys()].sort(),
    );
  });

  it("gives every member an anchor matching its definition name", () => {
    const defs = schema.$defs as Record<string, Json>;
    for (const member of unionMembers()) {
      expect(defs[member].$anchor, `${member} has no matching anchor`).toBe(
        member,
      );
    }
  });
});

describe("each event's own definition rejects the others", () => {
  const definitions = [...eventDefinitions().entries()];

  it.each(definitions)(
    "a %s document fails against every other definition",
    (type, name) => {
      // A minimal document is not enough here: it has to be one the event's own
      // definition accepts, otherwise the rejection elsewhere proves nothing.
      const validateOwn = validatorFor(name);
      const document = MINIMAL_EVENTS[type];
      expect(document, `no minimal document for ${type}`).toBeDefined();
      expect(validateOwn(document), JSON.stringify(validateOwn.errors)).toBe(
        true,
      );

      for (const [otherType, otherName] of definitions) {
        if (otherName === name) continue;
        const validateOther = validatorFor(otherName);
        expect(
          validateOther(document),
          `${type} was accepted by ${otherType}`,
        ).toBe(false);
      }
    },
  );
});

/** One accepted document per event, used only to prove cross-type rejection.
 *  The fixture tree is where documents are covered properly; these exist so the
 *  all-against-all comparison does not depend on which fixtures happen to be
 *  present. */
const MINIMAL_EVENTS: Record<string, Json> = {
  TEXT_MESSAGE_START: { type: "TEXT_MESSAGE_START", messageId: "m1" },
  TEXT_MESSAGE_CONTENT: {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "m1",
    delta: "hi",
  },
  TEXT_MESSAGE_END: { type: "TEXT_MESSAGE_END", messageId: "m1" },
  TEXT_MESSAGE_CHUNK: { type: "TEXT_MESSAGE_CHUNK" },
  TOOL_CALL_START: {
    type: "TOOL_CALL_START",
    toolCallId: "c1",
    toolCallName: "search",
  },
  TOOL_CALL_ARGS: { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: "{" },
  TOOL_CALL_END: { type: "TOOL_CALL_END", toolCallId: "c1" },
  TOOL_CALL_CHUNK: { type: "TOOL_CALL_CHUNK" },
  TOOL_CALL_RESULT: {
    type: "TOOL_CALL_RESULT",
    messageId: "m2",
    toolCallId: "c1",
    content: "done",
  },
  STATE_SNAPSHOT: { type: "STATE_SNAPSHOT", snapshot: { count: 1 } },
  STATE_DELTA: {
    type: "STATE_DELTA",
    delta: [{ op: "replace", path: "/count", value: 2 }],
  },
  MESSAGES_SNAPSHOT: { type: "MESSAGES_SNAPSHOT", messages: [] },
  ACTIVITY_SNAPSHOT: {
    type: "ACTIVITY_SNAPSHOT",
    messageId: "m3",
    activityType: "search",
    content: {},
  },
  ACTIVITY_DELTA: {
    type: "ACTIVITY_DELTA",
    messageId: "m3",
    activityType: "search",
    patch: [],
  },
  RAW: { type: "RAW", event: { kind: "provider.thing" } },
  CUSTOM: { type: "CUSTOM", name: "app.thing", value: 1 },
  RUN_STARTED: { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
  RUN_FINISHED: { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
  RUN_ERROR: { type: "RUN_ERROR", message: "boom" },
  STEP_STARTED: { type: "STEP_STARTED", stepName: "plan" },
  STEP_FINISHED: { type: "STEP_FINISHED", stepName: "plan" },
  REASONING_START: { type: "REASONING_START", messageId: "m4" },
  REASONING_MESSAGE_START: {
    type: "REASONING_MESSAGE_START",
    messageId: "m4",
    role: "reasoning",
  },
  REASONING_MESSAGE_CONTENT: {
    type: "REASONING_MESSAGE_CONTENT",
    messageId: "m4",
    delta: "because",
  },
  REASONING_MESSAGE_END: { type: "REASONING_MESSAGE_END", messageId: "m4" },
  REASONING_MESSAGE_CHUNK: { type: "REASONING_MESSAGE_CHUNK" },
  REASONING_END: { type: "REASONING_END", messageId: "m4" },
  REASONING_ENCRYPTED_VALUE: {
    type: "REASONING_ENCRYPTED_VALUE",
    subtype: "message",
    entityId: "m4",
    encryptedValue: "opaque",
  },
  SUBAGENT_STARTED: {
    type: "SUBAGENT_STARTED",
    subagentRunId: "s1",
    name: "researcher",
  },
  SUBAGENT_FINISHED: { type: "SUBAGENT_FINISHED", subagentRunId: "s1" },
  SUBAGENT_ERROR: {
    type: "SUBAGENT_ERROR",
    subagentRunId: "s1",
    message: "boom",
  },
};
