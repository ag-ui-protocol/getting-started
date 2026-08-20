import { describe, expect, it } from "vitest";
import {
  createAjv,
  definitionNames,
  effectiveProperties,
  effectiveRequired,
  eventDefinitions,
  constPositions,
  constraintMap,
  enumPositions,
  shapedDefinitions,
  unionPositions,
  JSON_PATCH_ID,
  jsonPatchDefinitionNames,
  jsonPatchSchema,
  schema,
  SCHEMA_ID,
  unionMembers,
  validatorFor,
} from "./validator";
import {
  EVENT_PROPERTIES,
  EVENT_REQUIRED,
  PATCH_PROPERTIES,
  PATCH_REQUIRED,
  CONST_VALUES,
  ENUM_MEMBERS,
  PATCH_CONST_VALUES,
  PATCH_UNION_MEMBERS,
  TYPE_PROPERTIES,
  TYPE_REQUIRED,
  UNION_MEMBERS,
} from "./property-sets";

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
 * Tighter than the standard vocabulary on purpose. The harness understands a
 * specific set of constructs — `properties` and `allOf` for shape, `required`
 * for obligation — and a keyword outside that set can quietly change what a
 * document means while every assertion here stays green. `propertyNames`,
 * `maxProperties` or a conditional would each make an unknown property fatal
 * without tripping the openness check; `dependentRequired` would add an
 * obligation the required pin cannot see.
 *
 * So the vocabulary is pinned rather than policed one keyword at a time. Adding
 * one fails this test, which is the prompt to teach the harness what it means
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
  "not",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
]);

/**
 * The only places `not` is allowed, by exact location.
 *
 * Both stop a success outcome from carrying the field that belongs to its
 * suspended sibling — a contradiction rather than a forward-compatible
 * extension. Anywhere else, `not` would quietly close an object.
 */
const INTENTIONAL_NOT = new Set([
  "schema.json/$defs/RunFinishedSuccessOutcome/properties/interrupts",
  "schema.json/$defs/SubagentFinishedSuccessOutcome/properties/interruptIds",
]);

type Json = Record<string, unknown>;

/** Walks both files, calling back at every schema position with its keywords. */
function walkSchemas(
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

const FILES: Array<[string, Json]> = [
  ["schema.json", schema],
  ["json-patch.json", jsonPatchSchema],
];

describe("the schema files themselves", () => {
  it.each(FILES)(
    "%s validates against the 2020-12 meta-schema",
    (_name, file) => {
      const ajv = createAjv();
      expect(ajv.validateSchema(file)).toBe(true);
    },
  );

  it("compiles every definition, so strict mode sees every corner of both files", () => {
    // Registering a schema does not compile it, and strict mode's unknown-keyword
    // check runs at compile time. So a misspelled keyword in a definition nothing
    // happened to compile would sit there unreported. Compiling all of them is
    // what turns strict mode into a real gate.
    const ajv = createAjv();
    const targets = [
      ...definitionNames().map((name) => `${SCHEMA_ID}#/$defs/${name}`),
      ...jsonPatchDefinitionNames().map(
        (name) => `${JSON_PATCH_ID}#/$defs/${name}`,
      ),
      SCHEMA_ID,
      JSON_PATCH_ID,
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
    for (const name of jsonPatchDefinitionNames()) {
      const validate = ajv.getSchema(`${JSON_PATCH_ID}#${name}`);
      expect(validate, `${JSON_PATCH_ID}#${name} does not resolve`).toBeTypeOf(
        "function",
      );
    }
  });

  it("gives every definition an anchor matching its name", () => {
    const missing: string[] = [];
    for (const [fileName, file] of FILES) {
      for (const [name, def] of Object.entries(
        (file.$defs ?? {}) as Record<string, Json>,
      )) {
        if (def.$anchor !== name) missing.push(`${fileName}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("uses only the keywords the harness understands", () => {
    const unexpected = new Set<string>();
    for (const [, file] of FILES) {
      walkSchemas(file, (node) => {
        for (const key of Object.keys(node)) {
          if (!USED_KEYWORDS.has(key)) unexpected.add(key);
        }
      });
    }
    expect([...unexpected].sort()).toEqual([]);
  });

  it.each(FILES)(
    "%s uses no keyword outside the standard vocabulary",
    (_name, file) => {
      const offenders: string[] = [];
      walkSchemas(file, (node, path) => {
        for (const key of Object.keys(node)) {
          if (!STANDARD_KEYWORDS.has(key)) offenders.push(`${path}: ${key}`);
        }
      });
      expect(offenders).toEqual([]);
    },
  );

  it("uses no construct that would hide a property from the pins", () => {
    // effectiveProperties walks `properties` and `allOf` and nothing else. A
    // definition that also introduced fields through a conditional or a union
    // would be pinned incompletely while the suite stayed green, so the harness
    // refuses to be the thing that silently decides which constructs matter.
    const unmodelled = [
      "dependentSchemas",
      // dependentRequired makes a field mandatory conditionally, which
      // effectiveRequired would not see: `{"provider": ["model"]}` on TokenUsage
      // would leave the pin claiming every field optional while
      // `{"provider": "openai"}` became invalid.
      "dependentRequired",
      "if",
      "then",
      "else",
      "patternProperties",
      "anyOf",
      "oneOf",
    ];
    const offenders: string[] = [];
    for (const [fileName, file] of FILES) {
      for (const [name, def] of Object.entries(
        (file.$defs ?? {}) as Record<string, Json>,
      )) {
        if (def.properties === undefined) continue;
        for (const keyword of unmodelled) {
          if (def[keyword] !== undefined)
            offenders.push(`${fileName}: ${name} uses ${keyword}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves every reference, with nothing dangling", () => {
    const dangling: string[] = [];
    const defsOf = (file: Json) => (file.$defs ?? {}) as Json;
    const anchorsOf = (file: Json) => {
      const anchors = new Set<string>();
      walkSchemas(file, (node) => {
        if (typeof node.$anchor === "string") anchors.add(node.$anchor);
      });
      return anchors;
    };

    const byFile: Record<string, Json> = {
      "schema.json": schema,
      "json-patch.json": jsonPatchSchema,
    };

    for (const [fileName, file] of FILES) {
      walkSchemas(file, (node, path) => {
        const ref = node.$ref;
        if (typeof ref !== "string") return;
        const [target, fragment = ""] = ref.split("#");
        const resolvedFile = target === "" ? file : byFile[target];
        if (!resolvedFile) {
          dangling.push(`${fileName}${path}: unknown file "${target}"`);
          return;
        }
        if (fragment.startsWith("/$defs/")) {
          const name = fragment.replace("/$defs/", "");
          if (!(name in defsOf(resolvedFile))) {
            dangling.push(`${fileName}${path}: no definition "${name}"`);
          }
        } else if (fragment !== "" && !anchorsOf(resolvedFile).has(fragment)) {
          dangling.push(`${fileName}${path}: no anchor "${fragment}"`);
        }
      });
    }

    expect(dangling).toEqual([]);
  });

  it("names every property in camelCase, because it describes the wire and not a language", () => {
    const offenders: string[] = [];
    for (const [fileName, file] of FILES) {
      walkSchemas(file, (node, path) => {
        const properties = node.properties as Json | undefined;
        for (const name of Object.keys(properties ?? {})) {
          if (!/^[a-z][a-zA-Z0-9]*$/.test(name))
            offenders.push(`${fileName}${path}: ${name}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("gives every field a description, so no meaning has to live in a generator template", () => {
    const undocumented: string[] = [];

    for (const [fileName, file] of FILES) {
      const defs = (file.$defs ?? {}) as Record<string, Json>;

      /** The property names a definition inherits by composition. A property the
       *  definition then redeclares is narrowing an inherited field — the `type`
       *  const on each event, the `role` const on each message — and its meaning
       *  is documented once on the field it narrows, not 31 times over. */
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

      walkSchemas(file, (node, path) => {
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
            undocumented.push(`${fileName}${path}/${name} (via ${ref})`);
            continue;
          }
          if (inherited.has(name)) continue;
          undocumented.push(`${fileName}${path}/${name}`);
        }
      });
    }

    expect(undocumented).toEqual([]);
  });

  it("leaves objects open, so an unrecognised property is never fatal", () => {
    // Checking for a literal `false` is not enough: a schema-valued
    // `additionalProperties` constrains unknown properties just as effectively.
    // `{"type": "string"}` on TokenUsage would leave every fixture green while
    // rejecting `{"vendorCost": 0.01}` — an additive field of exactly the kind
    // openness exists to allow. So the value has to be absent or `true`.
    const constrained: string[] = [];
    for (const [fileName, file] of FILES) {
      walkSchemas(file, (node, path) => {
        for (const keyword of [
          "additionalProperties",
          "unevaluatedProperties",
        ]) {
          if (!(keyword in node)) continue;
          if (node[keyword] !== true)
            constrained.push(`${fileName}${path}: ${keyword}`);
        }
        // `not` closes an object just as effectively: `{"required":
        // ["vendorCost"]}` under it rejects a document for carrying an additive
        // field. It is used on purpose in exactly two places, to stop a success
        // outcome carrying the field that belongs to its suspended sibling.
        // Exempting those two by name rather than by shape matters: an earlier
        // version exempted any `not` beneath a property, which would have let one
        // on `metadata` reject an arbitrary key while this test stayed green.
        if ("not" in node && !INTENTIONAL_NOT.has(`${fileName}${path}`)) {
          constrained.push(`${fileName}${path}: not`);
        }
        // A property whose schema is `false` can never be satisfied, so declaring
        // one closes the object against a field it claims to have. `metadata:
        // false` on an event made metadata unusable while the property-set pin
        // still reported it present — the walker skips boolean schemas, so this
        // has to look at the values directly.
        for (const [name, child] of Object.entries(
          (node.properties ?? {}) as Record<string, unknown>,
        )) {
          if (child === false)
            constrained.push(`${fileName}${path}/properties/${name}: false`);
        }
      });
    }
    expect(constrained).toEqual([]);
  });
});

describe("the event union", () => {
  it("has exactly 31 members", () => {
    expect(unionMembers()).toHaveLength(31);
  });

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

describe("unions", () => {
  it("pins every union in schema.json, wherever it appears, besides the event union", () => {
    const { Event: _event, ...unions } = unionPositions();
    expect(Object.keys(unions).sort()).toEqual(
      Object.keys(UNION_MEMBERS).sort(),
    );
  });

  it("pins every union in json-patch.json", () => {
    expect(Object.keys(unionPositions(jsonPatchSchema)).sort()).toEqual(
      Object.keys(PATCH_UNION_MEMBERS).sort(),
    );
  });

  it.each(Object.entries(UNION_MEMBERS))(
    "%s has exactly its pinned members",
    (name, pinned) => {
      expect(unionPositions()[name]).toEqual(pinned);
    },
  );

  it.each(Object.entries(PATCH_UNION_MEMBERS))(
    "%s has exactly its pinned members",
    (name, pinned) => {
      expect(unionPositions(jsonPatchSchema)[name]).toEqual(pinned);
    },
  );
});

describe("constraints", () => {
  // A snapshot, because the operands are too numerous to spell out and too
  // load-bearing to leave unchecked: `type`, `pattern`, `minimum`, `maximum`,
  // `minItems`, `default`, `contentEncoding` and every `$ref` target. Changing one
  // is fine; changing one without noticing is not, and updating the snapshot is
  // the second, visible act that makes it deliberate.
  it("matches the recorded constraints in schema.json", () => {
    expect(constraintMap()).toMatchSnapshot();
  });

  it("matches the recorded constraints in json-patch.json", () => {
    expect(constraintMap(jsonPatchSchema)).toMatchSnapshot();
  });
});

describe("fixed values", () => {
  it("pins every const in schema.json, wherever it appears", () => {
    expect(constPositions()).toEqual(CONST_VALUES);
  });

  it("pins every const in json-patch.json", () => {
    expect(constPositions(jsonPatchSchema)).toEqual(PATCH_CONST_VALUES);
  });
});

describe("enums", () => {
  it("pins every enum besides EventType, wherever it appears", () => {
    const { EventType: _eventType, ...enums } = enumPositions();
    expect(Object.keys(enums).sort()).toEqual(Object.keys(ENUM_MEMBERS).sort());
  });

  it("json-patch.json declares no enum", () => {
    expect(Object.keys(enumPositions(jsonPatchSchema))).toEqual([]);
  });

  it.each(Object.entries(ENUM_MEMBERS))(
    "%s has exactly its pinned members",
    (name, pinned) => {
      expect(enumPositions()[name]).toEqual(pinned);
    },
  );
});

describe("property sets", () => {
  it("pins every shaped definition in schema.json, leaving none unchecked", () => {
    // Without this, the pin is only as good as what came to mind when it was
    // written: dropping `required: ["type"]` from RunFinishedSuccessOutcome once
    // left the whole suite green while making `"outcome": {}` a valid
    // RUN_FINISHED.
    const pinned = [
      ...Object.keys(EVENT_PROPERTIES),
      ...Object.keys(TYPE_PROPERTIES),
    ].sort();
    expect(pinned).toEqual(shapedDefinitions());
    expect(Object.keys(EVENT_REQUIRED).sort()).toEqual(
      Object.keys(EVENT_PROPERTIES).sort(),
    );
    expect(Object.keys(TYPE_REQUIRED).sort()).toEqual(
      Object.keys(TYPE_PROPERTIES).sort(),
    );
  });

  it("pins every shaped definition in json-patch.json", () => {
    expect(Object.keys(PATCH_PROPERTIES).sort()).toEqual(
      shapedDefinitions(jsonPatchSchema),
    );
    expect(Object.keys(PATCH_REQUIRED).sort()).toEqual(
      Object.keys(PATCH_PROPERTIES).sort(),
    );
  });

  it.each(Object.entries(PATCH_PROPERTIES))(
    "%s carries exactly its pinned fields",
    (name, pinned) => {
      expect(effectiveProperties(name, jsonPatchSchema)).toEqual(pinned);
    },
  );

  it.each(Object.entries(PATCH_REQUIRED))(
    "%s requires exactly its pinned fields",
    (name, pinned) => {
      expect(effectiveRequired(name, jsonPatchSchema)).toEqual(pinned);
    },
  );

  it("pins all 31 events", () => {
    expect(Object.keys(EVENT_PROPERTIES).sort()).toEqual(
      [...unionMembers()].sort(),
    );
  });

  it.each(Object.entries(EVENT_PROPERTIES))(
    "%s carries exactly its pinned fields",
    (name, pinned) => {
      expect(effectiveProperties(name)).toEqual(pinned);
    },
  );

  it.each(Object.entries(TYPE_PROPERTIES))(
    "%s carries exactly its pinned fields",
    (name, pinned) => {
      expect(effectiveProperties(name)).toEqual(pinned);
    },
  );
});

describe("required fields", () => {
  it("pins all 31 events", () => {
    expect(Object.keys(EVENT_REQUIRED).sort()).toEqual(
      [...unionMembers()].sort(),
    );
  });

  it.each(Object.entries(EVENT_REQUIRED))(
    "%s requires exactly its pinned fields",
    (name, pinned) => {
      expect(effectiveRequired(name)).toEqual(pinned);
    },
  );

  it.each(Object.entries(TYPE_REQUIRED))(
    "%s requires exactly its pinned fields",
    (name, pinned) => {
      expect(effectiveRequired(name)).toEqual(pinned);
    },
  );
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
 *  31-by-31 comparison does not depend on which fixtures happen to be present. */
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
