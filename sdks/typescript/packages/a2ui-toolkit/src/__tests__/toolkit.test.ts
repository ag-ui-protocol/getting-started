import { describe, it, expect } from "vitest";
import {
  A2UI_OPERATIONS_KEY,
  A2UI_SCHEMA_CONTEXT_DESCRIPTION,
  BASIC_CATALOG_ID,
  DEFAULT_DESIGN_GUIDELINES,
  DEFAULT_GENERATION_GUIDELINES,
  DEFAULT_SURFACE_ID,
  GENERATE_A2UI_TOOL_DESCRIPTION,
  GENERATE_A2UI_TOOL_NAME,
  RENDER_A2UI_TOOL_DEF,
  resolveA2UIToolParams,
  assembleOps,
  buildA2UIEnvelope,
  buildContextPrompt,
  buildSubagentPrompt,
  createSurface,
  findPriorSurface,
  prepareA2UIRequest,
  resolveA2UICatalog,
  splitA2UISchemaContext,
  updateComponents,
  updateDataModel,
  wrapAsOperationsEnvelope,
  wrapErrorEnvelope,
} from "../index";

describe("constants", () => {
  it("A2UI_OPERATIONS_KEY is the wire key the middleware looks for", () => {
    expect(A2UI_OPERATIONS_KEY).toBe("a2ui_operations");
  });

  it("BASIC_CATALOG_ID points at the v0.9 basic catalog", () => {
    expect(BASIC_CATALOG_ID).toBe("https://a2ui.org/specification/v0_9/basic_catalog.json");
  });
});

describe("RENDER_A2UI_TOOL_DEF", () => {
  it("is shaped as an OpenAI function-call tool definition", () => {
    expect(RENDER_A2UI_TOOL_DEF.type).toBe("function");
    expect(RENDER_A2UI_TOOL_DEF.function.name).toBe("render_a2ui");
  });

  it("requires surfaceId and components", () => {
    expect(RENDER_A2UI_TOOL_DEF.function.parameters.required).toEqual(["surfaceId", "components"]);
  });

  it("declares the three expected parameter slots", () => {
    expect(Object.keys(RENDER_A2UI_TOOL_DEF.function.parameters.properties)).toEqual([
      "surfaceId",
      "components",
      "data",
    ]);
  });
});

describe("op builders", () => {
  it("createSurface emits a v0.9 createSurface op", () => {
    expect(createSurface("s1", "c1")).toEqual({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: "c1" },
    });
  });

  it("updateComponents wraps the component array verbatim", () => {
    const comps = [{ id: "root", component: "Row" }];
    expect(updateComponents("s1", comps)).toEqual({
      version: "v0.9",
      updateComponents: { surfaceId: "s1", components: comps },
    });
  });

  it("updateDataModel defaults path to /", () => {
    expect(updateDataModel("s1", { items: [] })).toEqual({
      version: "v0.9",
      updateDataModel: { surfaceId: "s1", path: "/", value: { items: [] } },
    });
  });

  it("updateDataModel honors a custom path", () => {
    expect(updateDataModel("s1", "hello", "/title")).toEqual({
      version: "v0.9",
      updateDataModel: { surfaceId: "s1", path: "/title", value: "hello" },
    });
  });
});

describe("buildContextPrompt", () => {
  it("returns empty when state has no ag-ui slot", () => {
    expect(buildContextPrompt({})).toBe("");
  });

  it("emits described context entries as markdown sections", () => {
    const prompt = buildContextPrompt({
      "ag-ui": {
        context: [{ description: "Style guide", value: "use cards" }],
      },
    });
    expect(prompt).toContain("## Style guide");
    expect(prompt).toContain("use cards");
  });

  it("includes value-only entries without a heading", () => {
    const prompt = buildContextPrompt({
      "ag-ui": { context: [{ value: "free-form note" }] },
    });
    expect(prompt).toContain("free-form note");
    expect(prompt).not.toContain("##");
  });

  it("appends the a2ui component catalog under Available Components", () => {
    const prompt = buildContextPrompt({
      "ag-ui": { a2ui_schema: "<catalog json>" },
    });
    expect(prompt).toContain("## Available Components");
    expect(prompt).toContain("<catalog json>");
  });

  it("ignores entries without description or value", () => {
    const prompt = buildContextPrompt({
      "ag-ui": { context: [{}] },
    });
    expect(prompt).toBe("");
  });
});

describe("splitA2UISchemaContext", () => {
  it("splits the schema entry from regular context", () => {
    const [schema, regular] = splitA2UISchemaContext([
      { description: "Style guide", value: "use cards" },
      { description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: "<catalog>" },
    ]);
    expect(schema).toBe("<catalog>");
    expect(regular).toHaveLength(1);
    expect(regular[0].description).toBe("Style guide");
  });

  it("returns undefined schema when no schema entry is present", () => {
    const [schema, regular] = splitA2UISchemaContext([
      { description: "Style guide", value: "use cards" },
    ]);
    expect(schema).toBeUndefined();
    expect(regular).toHaveLength(1);
  });

  it("handles null/undefined context", () => {
    expect(splitA2UISchemaContext(undefined)).toEqual([undefined, []]);
    expect(splitA2UISchemaContext(null)).toEqual([undefined, []]);
  });

  it("round-trips into buildContextPrompt", () => {
    const [schema, regular] = splitA2UISchemaContext([
      { description: "App context", value: "on dashboard" },
      { description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: "<catalog>" },
    ]);
    const prompt = buildContextPrompt({
      "ag-ui": { context: regular, a2ui_schema: schema },
    });
    expect(prompt).toContain("## Available Components");
    expect(prompt).toContain("<catalog>");
    expect(prompt).toContain("## App context");
    expect(prompt).not.toContain(A2UI_SCHEMA_CONTEXT_DESCRIPTION);
  });
});

describe("resolveA2UICatalog", () => {
  it("reads catalogId from the native ag-ui a2ui_schema (schema undefined)", () => {
    const resolved = resolveA2UICatalog({
      "ag-ui": {
        a2ui_schema: JSON.stringify({ catalogId: "my-catalog", components: [] }),
      },
    });
    expect(resolved).toEqual([undefined, "my-catalog"]);
  });

  it("accepts an already-parsed a2ui_schema object", () => {
    const resolved = resolveA2UICatalog({
      "ag-ui": { a2ui_schema: { catalogId: "parsed-cat" } },
    });
    expect(resolved?.[1]).toBe("parsed-cat");
  });

  it("degrades to no id on unparseable schema", () => {
    const resolved = resolveA2UICatalog({ "ag-ui": { a2ui_schema: "{not json" } });
    expect(resolved).toEqual([undefined, undefined]);
  });

  it("reads the catalog from an 'A2UI catalog' context entry (first listed)", () => {
    const resolved = resolveA2UICatalog({
      "ag-ui": {
        context: [
          { description: "unrelated", value: "x" },
          { description: "Registered A2UI catalog", value: "- custom-cat\n- basic" },
        ],
      },
    });
    expect(resolved?.[1]).toBe("custom-cat");
    expect(resolved?.[0]).toContain("custom-cat");
  });

  it("prefers the schema entry over the context entry", () => {
    const resolved = resolveA2UICatalog({
      "ag-ui": {
        a2ui_schema: JSON.stringify({ catalogId: "native-cat" }),
        context: [{ description: "A2UI catalog", value: "- ctx-cat" }],
      },
    });
    expect(resolved?.[1]).toBe("native-cat");
  });

  it("returns undefined when no catalog is present", () => {
    expect(resolveA2UICatalog({})).toBeUndefined();
    expect(resolveA2UICatalog({ "ag-ui": { context: [] } })).toBeUndefined();
  });
});

describe("findPriorSurface", () => {
  function toolMsg(content: unknown) {
    return { role: "tool", content: JSON.stringify(content) };
  }

  it("returns undefined when the surface is not present", () => {
    const messages = [toolMsg({ [A2UI_OPERATIONS_KEY]: [] })];
    expect(findPriorSurface(messages, "missing")).toBeUndefined();
  });

  it("returns the most recent rendered state when found", () => {
    const messages = [
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [
          createSurface("s1", "cat://x"),
          updateComponents("s1", [{ id: "root", component: "Row" }]),
          updateDataModel("s1", { items: [1, 2] }),
        ],
      }),
    ];
    expect(findPriorSurface(messages, "s1")).toEqual({
      components: [{ id: "root", component: "Row" }],
      data: { items: [1, 2] },
      catalogId: "cat://x",
    });
  });

  it("prefers the latest matching tool result when multiple exist", () => {
    const messages = [
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [
          createSurface("s1", "old-cat"),
          updateComponents("s1", [{ id: "root", component: "Row" }]),
        ],
      }),
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [
          updateComponents("s1", [{ id: "root", component: "Column" }]),
          updateDataModel("s1", { changed: true }),
        ],
      }),
    ];
    const prior = findPriorSurface(messages, "s1");
    expect(prior?.components).toEqual([{ id: "root", component: "Column" }]);
    expect(prior?.data).toEqual({ changed: true });
  });

  it("within a single message, the last op for each field wins (renderer-apply order)", () => {
    // One envelope emits multiple ops for the same surface. The renderer
    // applies them in order, so the surface ends at layout-b / {v:2} / cat-B.
    const messages = [
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [
          createSurface("s1", "cat-A"),
          updateComponents("s1", [{ id: "root", component: "Row" }]),
          updateDataModel("s1", { v: 1 }),
          createSurface("s1", "cat-B"),
          updateComponents("s1", [{ id: "root", component: "Column" }]),
          updateDataModel("s1", { v: 2 }),
        ],
      }),
    ];
    const prior = findPriorSurface(messages, "s1");
    expect(prior).toEqual({
      components: [{ id: "root", component: "Column" }],
      data: { v: 2 },
      catalogId: "cat-B",
    });
  });

  it("accumulates fields across the walk when a later turn omits some", () => {
    // Turn 1: full create + components + initial data.
    // Turn 2: only updateDataModel (e.g. a quick data refresh without re-emitting the layout).
    // The walker must still surface the components + catalogId from turn 1.
    const messages = [
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [
          createSurface("s1", "cat://x"),
          updateComponents("s1", [{ id: "root", component: "Row" }]),
          updateDataModel("s1", { items: [1] }),
        ],
      }),
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [updateDataModel("s1", { items: [1, 2, 3] })],
      }),
    ];
    const prior = findPriorSurface(messages, "s1");
    expect(prior).toEqual({
      components: [{ id: "root", component: "Row" }],
      data: { items: [1, 2, 3] },
      catalogId: "cat://x",
    });
  });

  it("ignores non-tool messages and unparseable content", () => {
    const messages = [
      { role: "assistant", content: "not a tool" },
      { role: "tool", content: "not json" },
      toolMsg({ unrelated: "payload" }),
    ];
    expect(findPriorSurface(messages, "s1")).toBeUndefined();
  });

  it("accepts ToolMessage's `type` field as well as `role`", () => {
    const messages = [
      {
        type: "tool",
        content: JSON.stringify({
          [A2UI_OPERATIONS_KEY]: [
            createSurface("s1", "c"),
            updateComponents("s1", [{ id: "root", component: "Row" }]),
          ],
        }),
      },
    ];
    expect(findPriorSurface(messages, "s1")?.catalogId).toBe("c");
  });

  it("returns undefined when the newest mention of the surface is a deleteSurface", () => {
    // Older message created + populated the surface; newer message deletes it.
    // The renderer no longer shows the surface, so the toolkit must NOT
    // resurrect its stale state from the older create/update ops.
    const messages = [
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [
          createSurface("s1", "cat://x"),
          updateComponents("s1", [{ id: "root", component: "Row" }]),
          updateDataModel("s1", { items: [1, 2] }),
        ],
      }),
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [{ version: "v0.9", deleteSurface: { surfaceId: "s1" } }],
      }),
    ];
    expect(findPriorSurface(messages, "s1")).toBeUndefined();
  });

  it("ignores an older deleteSurface that a newer message resurrects", () => {
    // Newest message creates + populates the surface; older message had
    // deleted it. The newer state is authoritative — must not be wiped.
    const messages = [
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [{ version: "v0.9", deleteSurface: { surfaceId: "s1" } }],
      }),
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [
          createSurface("s1", "cat://new"),
          updateComponents("s1", [{ id: "root", component: "Column" }]),
          updateDataModel("s1", { items: [9] }),
        ],
      }),
    ];
    expect(findPriorSurface(messages, "s1")).toEqual({
      components: [{ id: "root", component: "Column" }],
      data: { items: [9] },
      catalogId: "cat://new",
    });
  });

  it("intra-message delete followed by create yields the recreated state", () => {
    // Within one message, ops apply in order. Delete then create → surface
    // exists with the recreated content at end of message.
    const messages = [
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [
          { version: "v0.9", deleteSurface: { surfaceId: "s1" } },
          createSurface("s1", "cat-recreated"),
          updateComponents("s1", [{ id: "root", component: "Row" }]),
        ],
      }),
    ];
    expect(findPriorSurface(messages, "s1")).toEqual({
      components: [{ id: "root", component: "Row" }],
      data: undefined,
      catalogId: "cat-recreated",
    });
  });

  it("intra-message create followed by delete yields undefined", () => {
    // Within one message, the surface is created then deleted — end state is
    // deleted regardless of the older accumulated state in prior messages.
    const messages = [
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [
          createSurface("s1", "older-cat"),
          updateComponents("s1", [{ id: "root", component: "Row" }]),
        ],
      }),
      toolMsg({
        [A2UI_OPERATIONS_KEY]: [
          createSurface("s1", "transient"),
          { version: "v0.9", deleteSurface: { surfaceId: "s1" } },
        ],
      }),
    ];
    expect(findPriorSurface(messages, "s1")).toBeUndefined();
  });
});

describe("buildSubagentPrompt", () => {
  // Suppress both built-in default blocks so structural tests can assert exact
  // output without the (large) DEFAULT_* text. Empty string is the documented
  // escape hatch (undefined → default; "" → block omitted).
  const SUPPRESS = { generationGuidelines: "", designGuidelines: "" };

  it("applies the built-in defaults when no guidelines are given (OSS-248)", () => {
    const prompt = buildSubagentPrompt({ contextPrompt: "ctx" });
    expect(prompt).toContain(DEFAULT_GENERATION_GUIDELINES);
    expect(prompt).toContain("## Design Guidelines");
    expect(prompt).toContain(DEFAULT_DESIGN_GUIDELINES);
    expect(prompt).toContain("ctx");
  });

  it("orders generation → design → context → composition", () => {
    const prompt = buildSubagentPrompt({
      contextPrompt: "CTXMARK",
      guidelines: {
        generationGuidelines: "GENMARK",
        designGuidelines: "DESMARK",
        compositionGuide: "COMPMARK",
      },
    });
    expect(prompt.indexOf("GENMARK")).toBeLessThan(prompt.indexOf("DESMARK"));
    expect(prompt.indexOf("DESMARK")).toBeLessThan(prompt.indexOf("CTXMARK"));
    expect(prompt.indexOf("CTXMARK")).toBeLessThan(prompt.indexOf("COMPMARK"));
  });

  it("overrides one block per-field, keeping the other default", () => {
    const prompt = buildSubagentPrompt({
      contextPrompt: "ctx",
      guidelines: { generationGuidelines: "CUSTOM_GEN" },
    });
    expect(prompt).toContain("CUSTOM_GEN");
    expect(prompt).not.toContain(DEFAULT_GENERATION_GUIDELINES);
    expect(prompt).toContain(DEFAULT_DESIGN_GUIDELINES);
  });

  it("suppresses a block when passed an empty string", () => {
    const prompt = buildSubagentPrompt({ contextPrompt: "ctx", guidelines: SUPPRESS });
    expect(prompt).not.toContain(DEFAULT_GENERATION_GUIDELINES);
    expect(prompt).not.toContain(DEFAULT_DESIGN_GUIDELINES);
    expect(prompt).not.toContain("## Design Guidelines");
  });

  it("returns the context prompt verbatim when no extras", () => {
    expect(buildSubagentPrompt({ contextPrompt: "ctx", guidelines: SUPPRESS })).toBe("ctx");
  });

  it("appends composition guide after the context prompt", () => {
    const prompt = buildSubagentPrompt({
      contextPrompt: "ctx",
      guidelines: { ...SUPPRESS, compositionGuide: "guide" },
    });
    expect(prompt).toBe("ctx\nguide");
  });

  it("emits an edit block carrying the prior surface state", () => {
    const prompt = buildSubagentPrompt({
      contextPrompt: "ctx",
      guidelines: SUPPRESS,
      editContext: {
        surfaceId: "s1",
        prior: { components: [{ id: "root", component: "Row" }], data: { x: 1 } },
        changes: "make the title bigger",
      },
    });
    expect(prompt).toContain("Editing an existing surface");
    expect(prompt).toContain("'s1'");
    expect(prompt).toContain('"id": "root"');
    expect(prompt).toContain('"x": 1');
    expect(prompt).toContain("Requested changes");
    expect(prompt).toContain("make the title bigger");
  });

  it("omits the requested-changes section when changes is missing", () => {
    const prompt = buildSubagentPrompt({
      contextPrompt: "ctx",
      guidelines: SUPPRESS,
      editContext: {
        surfaceId: "s1",
        prior: { components: [], data: null },
      },
    });
    expect(prompt).not.toContain("Requested changes");
  });

  it("drops empty parts from the join", () => {
    expect(buildSubagentPrompt({ contextPrompt: "", guidelines: SUPPRESS })).toBe("");
  });
});

describe("assembleOps", () => {
  it("create intent emits createSurface + updateComponents + updateDataModel", () => {
    const ops = assembleOps({
      intent: "create",
      surfaceId: "s1",
      catalogId: "cat://x",
      components: [{ id: "root", component: "Row" }],
      data: { items: ["a"] },
    });
    expect(ops).toHaveLength(3);
    expect(ops[0]).toHaveProperty("createSurface");
    expect(ops[1]).toHaveProperty("updateComponents");
    expect(ops[2]).toHaveProperty("updateDataModel");
  });

  it("update intent skips createSurface so the frontend reconciles in place", () => {
    const ops = assembleOps({
      intent: "update",
      surfaceId: "s1",
      catalogId: "cat://x",
      components: [{ id: "root", component: "Row" }],
      data: { items: ["a"] },
    });
    expect(ops).toHaveLength(2);
    expect(ops[0]).toHaveProperty("updateComponents");
    expect(ops[1]).toHaveProperty("updateDataModel");
  });

  it("omits updateDataModel when no data is provided", () => {
    const ops = assembleOps({
      intent: "create",
      surfaceId: "s1",
      catalogId: "cat://x",
      components: [{ id: "root", component: "Row" }],
    });
    expect(ops).toHaveLength(2);
    expect(ops[0]).toHaveProperty("createSurface");
    expect(ops[1]).toHaveProperty("updateComponents");
  });

  it("omits updateDataModel when data is an empty object", () => {
    const ops = assembleOps({
      intent: "create",
      surfaceId: "s1",
      catalogId: "cat://x",
      components: [{ id: "root", component: "Row" }],
      data: {},
    });
    expect(ops).toHaveLength(2);
  });
});

describe("wrapAsOperationsEnvelope", () => {
  it("serializes ops under the A2UI_OPERATIONS_KEY", () => {
    const ops = [createSurface("s1", "c")];
    const envelope = JSON.parse(wrapAsOperationsEnvelope(ops));
    expect(envelope).toEqual({ [A2UI_OPERATIONS_KEY]: ops });
  });

  it("handles an empty ops list", () => {
    expect(JSON.parse(wrapAsOperationsEnvelope([]))).toEqual({
      [A2UI_OPERATIONS_KEY]: [],
    });
  });
});

describe("wrapErrorEnvelope", () => {
  it("wraps a message under the error key", () => {
    expect(JSON.parse(wrapErrorEnvelope("boom"))).toEqual({ error: "boom" });
  });
});

// A prior surface encoded the way it appears in conversation history.
function priorSurfaceMessage(surfaceId: string) {
  return {
    type: "tool",
    content: wrapAsOperationsEnvelope([
      createSurface(surfaceId, "cat://x"),
      updateComponents(surfaceId, [{ id: "root", component: "Row" }]),
      updateDataModel(surfaceId, { items: [1, 2] }),
    ]),
  };
}

describe("prepareA2UIRequest", () => {
  it("create: builds a prompt, no prior, not an update", () => {
    const prep = prepareA2UIRequest({
      intent: "create",
      messages: [],
      state: { "ag-ui": { context: [{ value: "ctx" }] } },
      guidelines: { compositionGuide: "guide" },
    });
    expect(prep.error).toBeUndefined();
    expect(prep.isUpdate).toBe(false);
    expect(prep.prior).toBeUndefined();
    expect(prep.prompt).toContain("ctx");
    expect(prep.prompt).toContain("guide");
  });

  it("defaults a missing intent to create", () => {
    const prep = prepareA2UIRequest({ messages: [], state: {} });
    expect(prep.isUpdate).toBe(false);
    expect(prep.error).toBeUndefined();
  });

  it("update with a matching prior surface: edit prompt + prior populated", () => {
    const prep = prepareA2UIRequest({
      intent: "update",
      targetSurfaceId: "s1",
      changes: "make it red",
      messages: [priorSurfaceMessage("s1")],
      state: {},
    });
    expect(prep.error).toBeUndefined();
    expect(prep.isUpdate).toBe(true);
    expect(prep.prior?.catalogId).toBe("cat://x");
    expect(prep.prompt).toContain("Editing an existing surface");
    expect(prep.prompt).toContain("make it red");
  });

  it("update with no matching prior: returns an error, no prompt", () => {
    const prep = prepareA2UIRequest({
      intent: "update",
      targetSurfaceId: "missing",
      messages: [priorSurfaceMessage("s1")],
      state: {},
    });
    expect(prep.prompt).toBe("");
    expect(prep.error).toContain("missing");
    expect(prep.error).toContain("no prior render");
  });
});

describe("buildA2UIEnvelope", () => {
  it("create: createSurface uses the configured default catalog, not the args", () => {
    const env = JSON.parse(
      buildA2UIEnvelope({
        args: {
          surfaceId: "from-args",
          components: [{ id: "root", component: "Row" }],
          data: { items: [1] },
        },
        isUpdate: false,
        defaultCatalogId: "cat://configured",
      }),
    );
    const ops = env[A2UI_OPERATIONS_KEY];
    expect(ops[0].createSurface).toEqual({ surfaceId: "from-args", catalogId: "cat://configured" });
    expect(ops[1].updateComponents.components).toEqual([{ id: "root", component: "Row" }]);
    expect(ops[2].updateDataModel.value).toEqual({ items: [1] });
  });

  it("create: falls back to DEFAULT_SURFACE_ID when args omit surfaceId", () => {
    const env = JSON.parse(buildA2UIEnvelope({ args: { components: [] }, isUpdate: false }));
    expect(env[A2UI_OPERATIONS_KEY][0].createSurface.surfaceId).toBe(DEFAULT_SURFACE_ID);
  });

  it("create: empty-string defaultSurfaceId / defaultCatalogId fall back to canonical", () => {
    // Misconfigured host: both defaults are the empty string. Must NOT
    // propagate "" into the emitted ops — the renderer would surface as
    // "Catalog not found: " / blank surface id. Mirror of the Python
    // test_empty_string_defaults_fall_back_to_canonical for cross-language
    // parity.
    const env = JSON.parse(
      buildA2UIEnvelope({
        args: { components: [{ id: "root", component: "Row" }] },
        isUpdate: false,
        defaultSurfaceId: "",
        defaultCatalogId: "",
      }),
    );
    const ops = env[A2UI_OPERATIONS_KEY];
    const cs = ops.find((o: Record<string, unknown>) => o.createSurface).createSurface;
    expect(cs.surfaceId).not.toBe("");
    expect(cs.catalogId).not.toBe("");
    expect(cs.surfaceId).toBe(DEFAULT_SURFACE_ID);
    expect(cs.catalogId).toBe(BASIC_CATALOG_ID);
  });

  it("create: non-string args.surfaceId falls back to DEFAULT_SURFACE_ID", () => {
    // The model is untrusted — `args.surfaceId` may come back as a number,
    // array, null, object, or boolean. Without the typeof-string narrow,
    // a non-string value propagates into createSurface.surfaceId and the
    // renderer crashes (it expects a string id). Mirror of the Python
    // test_non_string_arg_surface_id_falls_back_to_default.
    for (const bad of [42, ["x"], null, { a: 1 }, true]) {
      const env = JSON.parse(
        buildA2UIEnvelope({
          args: { surfaceId: bad as unknown as string, components: [] },
          isUpdate: false,
        }),
      );
      const cs = env[A2UI_OPERATIONS_KEY].find((o: Record<string, unknown>) => o.createSurface).createSurface;
      expect(cs.surfaceId).toBe(DEFAULT_SURFACE_ID);
      expect(typeof cs.surfaceId).toBe("string");
    }
  });

  it("update: empty-string targetSurfaceId falls back to DEFAULT_SURFACE_ID", () => {
    // Direct callers of buildA2UIEnvelope (bypassing prepareA2UIRequest) may
    // pass `targetSurfaceId: ""` on the update path. Empty strings must NOT
    // propagate into updateComponents.surfaceId.
    const env = JSON.parse(
      buildA2UIEnvelope({
        args: { components: [{ id: "root", component: "Row" }] },
        isUpdate: true,
        targetSurfaceId: "",
        prior: { components: [], data: null, catalogId: "cat://prior" },
      }),
    );
    const ops = env[A2UI_OPERATIONS_KEY];
    const uc = ops.find((o: Record<string, unknown>) => o.updateComponents).updateComponents;
    expect(uc.surfaceId).toBe(DEFAULT_SURFACE_ID);
    expect(uc.surfaceId).not.toBe("");
  });

  it("update: skips createSurface, keeps target id + prior catalog", () => {
    const env = JSON.parse(
      buildA2UIEnvelope({
        args: { surfaceId: "ignored", components: [{ id: "root", component: "Column" }] },
        isUpdate: true,
        targetSurfaceId: "s1",
        prior: { components: [], data: null, catalogId: "cat://prior" },
      }),
    );
    const ops = env[A2UI_OPERATIONS_KEY];
    expect(ops.some((o: Record<string, unknown>) => o.createSurface)).toBe(false);
    expect(ops[0].updateComponents.surfaceId).toBe("s1");
  });
});

describe("resolveA2UIToolParams", () => {
  it("fills the canonical defaults", () => {
    const r = resolveA2UIToolParams({ model: "M" });
    expect(r.model).toBe("M");
    expect(r.defaultSurfaceId).toBe(DEFAULT_SURFACE_ID);
    expect(r.defaultCatalogId).toBe(BASIC_CATALOG_ID);
    expect(r.toolName).toBe(GENERATE_A2UI_TOOL_NAME);
    expect(r.toolDescription).toBe(GENERATE_A2UI_TOOL_DESCRIPTION);
    expect(r.guidelines).toBeUndefined();
  });

  it("falls back to defaults on empty-string overrides", () => {
    const r = resolveA2UIToolParams({ model: "M", toolName: "", defaultCatalogId: "" });
    expect(r.toolName).toBe(GENERATE_A2UI_TOOL_NAME);
    expect(r.defaultCatalogId).toBe(BASIC_CATALOG_ID);
  });

  it("passes overrides through", () => {
    const r = resolveA2UIToolParams({
      model: "M",
      toolName: "custom_tool",
      guidelines: { compositionGuide: "g" },
    });
    expect(r.toolName).toBe("custom_tool");
    expect(r.guidelines).toEqual({ compositionGuide: "g" });
  });
});
