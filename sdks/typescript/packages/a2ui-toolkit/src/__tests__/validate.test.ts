import { describe, it, expect } from "vitest";
import { validateA2UIComponents } from "../validate";

// A minimal inline JSON-Schema catalog mirroring the middleware's
// A2UIInlineCatalogSchema: components keyed by name, each a JSON Schema whose
// `required` lists mandatory props.
const CATALOG = {
  components: {
    Row: {
      type: "object",
      properties: { gap: { type: "number" }, children: {} },
      required: ["children"],
    },
    HotelCard: {
      type: "object",
      properties: {
        name: {},
        location: {},
        rating: {},
        pricePerNight: {},
        action: {},
      },
      required: ["name", "location", "rating", "pricePerNight"],
    },
  },
};

// A well-formed dynamic surface: Row root repeating a HotelCard over /items.
function validComponents() {
  return [
    {
      id: "root",
      component: "Row",
      children: { componentId: "card", path: "/items" },
    },
    {
      id: "card",
      component: "HotelCard",
      name: { path: "name" },
      location: { path: "location" },
      rating: { path: "rating" },
      pricePerNight: { path: "pricePerNight" },
    },
  ];
}
const VALID_DATA = { items: [{ name: "Ritz", location: "NYC", rating: 4.8, pricePerNight: "$450" }] };

describe("validateA2UIComponents — happy path", () => {
  it("accepts a well-formed surface against its catalog", () => {
    const r = validateA2UIComponents({ components: validComponents(), data: VALID_DATA, catalog: CATALOG });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe("validateA2UIComponents — structural (no catalog needed)", () => {
  it("flags a missing root component", () => {
    const comps = validComponents().map((c) => (c.id === "root" ? { ...c, id: "container" } : c));
    const r = validateA2UIComponents({ components: comps, data: VALID_DATA, catalog: CATALOG });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === "no_root")).toBe(true);
  });

  it("flags a component missing a string id", () => {
    const comps: Array<Record<string, unknown>> = [{ component: "Row", children: [] }];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "missing_id" && e.path === "components[0].id")).toBe(true);
  });

  it("flags a component missing a string component type", () => {
    const comps: Array<Record<string, unknown>> = [{ id: "root" }];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "missing_component_type")).toBe(true);
  });

  it("flags duplicate ids", () => {
    const comps = [
      { id: "root", component: "Row", children: ["x"] },
      { id: "x", component: "Row", children: [] },
      { id: "x", component: "Row", children: [] },
    ];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "duplicate_id")).toBe(true);
  });

  it("fails loud on a non-array / empty components payload", () => {
    expect(validateA2UIComponents({ components: [] }).valid).toBe(false);
    // @ts-expect-error — exercising the untrusted-input guard
    expect(validateA2UIComponents({ components: null }).valid).toBe(false);
  });
});

describe("validateA2UIComponents — catalog semantics (only when a catalog is supplied)", () => {
  it("flags a component type not in the catalog", () => {
    const comps = validComponents().map((c) => (c.id === "card" ? { ...c, component: "MysteryCard" } : c));
    const r = validateA2UIComponents({ components: comps, data: VALID_DATA, catalog: CATALOG });
    expect(r.errors.some((e) => e.code === "unknown_component" && e.path === "components[1].component")).toBe(true);
  });

  it("flags a missing required prop per the catalog schema", () => {
    const comps = validComponents().map((c) => {
      if (c.id !== "card") return c;
      const { pricePerNight, ...rest } = c as Record<string, unknown>;
      return rest;
    });
    const r = validateA2UIComponents({ components: comps, data: VALID_DATA, catalog: CATALOG });
    expect(r.errors.some((e) => e.code === "missing_required_prop" && /pricePerNight/.test(e.message))).toBe(true);
  });

  it("skips catalog checks entirely when no catalog is supplied (structural-only)", () => {
    const comps = validComponents().map((c) => (c.id === "card" ? { ...c, component: "MysteryCard" } : c));
    const r = validateA2UIComponents({ components: comps, data: VALID_DATA });
    expect(r.errors.some((e) => e.code === "unknown_component")).toBe(false);
    expect(r.valid).toBe(true);
  });
});

describe("validateA2UIComponents — child references", () => {
  it("flags a structural child referencing a non-existent component id", () => {
    const comps = [
      { id: "root", component: "Row", children: { componentId: "ghost", path: "/items" } },
    ];
    const r = validateA2UIComponents({ components: comps, data: VALID_DATA, catalog: CATALOG });
    expect(r.errors.some((e) => e.code === "unresolved_child" && /ghost/.test(e.message))).toBe(true);
  });

  it("flags an array child id that does not resolve", () => {
    const comps = [
      { id: "root", component: "Row", children: ["missing-1"] },
    ];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "unresolved_child" && /missing-1/.test(e.message))).toBe(true);
  });

  it("flags a singular `child` referencing a non-existent component id", () => {
    // One-child containers (Card/Button) use the singular `child`, which the
    // default generation prompt emits — a dangling ref there must be caught too.
    const comps = [{ id: "root", component: "Card", child: "ghost" }];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "unresolved_child" && e.path === "components[0].child" && /ghost/.test(e.message))).toBe(true);
  });

  it("accepts a singular `child` pointing at a real component id", () => {
    const comps = [
      { id: "root", component: "Card", child: "label" },
      { id: "label", component: "Text" },
    ];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "unresolved_child")).toBe(false);
  });
});

describe("validateA2UIComponents — child cycles", () => {
  it("flags a self-referential singular `child`", () => {
    const comps = [{ id: "avatar", component: "Card", child: "avatar" }];
    const r = validateA2UIComponents({ components: comps });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === "child_cycle" && /avatar -> avatar/.test(e.message))).toBe(true);
  });

  it("flags a multi-component cycle and reports it once", () => {
    const comps = [
      { id: "root", component: "Row", children: ["a"] },
      { id: "a", component: "Row", children: ["b"] },
      { id: "b", component: "Row", children: ["a"] },
    ];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.filter((e) => e.code === "child_cycle").length).toBe(1);
    expect(r.errors.some((e) => e.code === "child_cycle" && /a -> b -> a/.test(e.message))).toBe(true);
  });

  it("does not flag an acyclic child graph", () => {
    const comps = [
      { id: "root", component: "Row", children: ["a", "b"] },
      { id: "a", component: "Text" },
      { id: "b", component: "Text" },
    ];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "child_cycle")).toBe(false);
  });

  it(
    "handles a pathologically deep child chain without overflowing the stack",
    () => {
      // The cycle check runs on untrusted model output; a deep linear chain that
      // would blow a recursive DFS's call stack must validate iteratively. 20k deep
      // is >2x V8's recursion overflow depth (~8.8k for a trivial frame, lower for
      // a real DFS frame), so it still proves the walk is iterative — but allocates
      // far less than 50k, keeping GC pressure (and thus the chance of a CI-runner
      // stall) low. The explicit-stack walk itself is linear (~25ms for this N).
      const N = 20000;
      const comps: Array<Record<string, unknown>> = [{ id: "root", component: "Row", children: ["n0"] }];
      for (let i = 0; i < N; i++) comps.push({ id: `n${i}`, component: "Row", children: i + 1 < N ? [`n${i + 1}`] : [] });
      const r = validateA2UIComponents({ components: comps });
      expect(r.errors.some((e) => e.code === "child_cycle")).toBe(false);
    },
    // The work is ~25ms; the default 5s timeout flaked under parallel-fork GC
    // contention on shared CI runners. A generous explicit budget decouples the
    // (provably fast) assertion from runner scheduling jitter.
    30000,
  );

  it(
    "detects a cycle that closes at the end of a deep chain",
    () => {
      // Same deep chain, but the tail points back at root — one cycle, no overflow.
      const N = 20000;
      const comps: Array<Record<string, unknown>> = [{ id: "root", component: "Row", children: ["n0"] }];
      for (let i = 0; i < N; i++) comps.push({ id: `n${i}`, component: "Row", children: [i + 1 < N ? `n${i + 1}` : "root"] });
      const r = validateA2UIComponents({ components: comps });
      expect(r.errors.filter((e) => e.code === "child_cycle").length).toBe(1);
    },
    30000,
  );
});

// #1948 — ref-fields beyond child/children, derived from catalog `format` markers.
// A property is a child reference only when its schema marks it `componentRef`
// (single) or `componentRefList` (list); unmarked props stay data, so a data
// string is never mistaken for a dangling id. `tabItems[].child` is found by
// honouring markers on an array property's item sub-schema.
const REF_CATALOG = {
  components: {
    Modal: {
      type: "object",
      properties: {
        trigger: { type: "string", format: "componentRef" },
        content: { type: "string", format: "componentRef" },
        title: { type: "string" }, // unmarked data prop
      },
    },
    Tabs: {
      type: "object",
      properties: {
        tabItems: {
          type: "array",
          items: { type: "object", properties: { label: { type: "string" }, child: { type: "string", format: "componentRef" } } },
        },
      },
    },
    Stack: {
      type: "object",
      properties: { items: { type: "array", format: "componentRefList" } },
    },
    Text: { type: "object" },
  },
};

describe("validateA2UIComponents — catalog-derived ref-fields (#1948)", () => {
  it("flags a dangling Modal `trigger`/`content` ref via the catalog marker", () => {
    const comps = [{ id: "root", component: "Modal", trigger: "ghost-btn", content: "ghost-body", title: "Hi" }];
    const r = validateA2UIComponents({ components: comps, catalog: REF_CATALOG });
    expect(r.errors.some((e) => e.code === "unresolved_child" && e.path === "components[0].trigger" && /ghost-btn/.test(e.message))).toBe(true);
    expect(r.errors.some((e) => e.code === "unresolved_child" && e.path === "components[0].content" && /ghost-body/.test(e.message))).toBe(true);
  });

  it("does not treat an unmarked data string as a child reference", () => {
    // `title` is a plain string prop; its value must never be flagged as a dangling id.
    const comps = [
      { id: "root", component: "Modal", trigger: "btn", content: "body", title: "not-an-id" },
      { id: "btn", component: "Text" },
      { id: "body", component: "Text" },
    ];
    const r = validateA2UIComponents({ components: comps, catalog: REF_CATALOG });
    expect(r.errors.some((e) => e.code === "unresolved_child")).toBe(false);
  });

  it("flags a dangling nested `tabItems[k].child` with a per-index path", () => {
    const comps = [
      {
        id: "root",
        component: "Tabs",
        tabItems: [
          { label: "A", child: "panel-a" },
          { label: "B", child: "ghost-panel" },
        ],
      },
      { id: "panel-a", component: "Text" },
    ];
    const r = validateA2UIComponents({ components: comps, catalog: REF_CATALOG });
    expect(r.errors.some((e) => e.code === "unresolved_child" && e.path === "components[0].tabItems[1].child" && /ghost-panel/.test(e.message))).toBe(true);
    expect(r.errors.some((e) => e.path === "components[0].tabItems[0].child")).toBe(false);
  });

  it("detects a cycle routed through a catalog-marked field", () => {
    // root(Modal).content -> b(Card).child -> root : undetectable without the marker.
    const comps = [
      { id: "root", component: "Modal", content: "b" },
      { id: "b", component: "Card", child: "root" },
    ];
    const r = validateA2UIComponents({ components: comps, catalog: REF_CATALOG });
    expect(r.errors.filter((e) => e.code === "child_cycle").length).toBe(1);
    expect(r.errors.some((e) => e.code === "child_cycle" && /b -> root -> b|root -> b -> root/.test(e.message))).toBe(true);
  });

  it("emits per-index paths for list-ref array refs", () => {
    const comps = [{ id: "root", component: "Stack", items: ["x", "ghost-1"] }, { id: "x", component: "Text" }];
    const r = validateA2UIComponents({ components: comps, catalog: REF_CATALOG });
    expect(r.errors.some((e) => e.code === "unresolved_child" && e.path === "components[0].items[1]" && /ghost-1/.test(e.message))).toBe(true);
  });

  it("ignores marked ref-fields when no catalog is supplied (structural child/children only)", () => {
    const comps = [{ id: "root", component: "Modal", trigger: "ghost-btn", content: "ghost-body" }];
    const r = validateA2UIComponents({ components: comps });
    expect(r.errors.some((e) => e.code === "unresolved_child")).toBe(false);
  });
});

describe("validateA2UIComponents — data bindings", () => {
  it("flags an absolute binding path absent from the data model", () => {
    const r = validateA2UIComponents({ components: validComponents(), data: {}, catalog: CATALOG });
    expect(r.errors.some((e) => e.code === "unresolved_binding" && /\/items/.test(e.message))).toBe(true);
  });

  it("does not flag relative template bindings (resolved per-item, lenient)", () => {
    // `name`/`location`/... are relative paths inside the repeated card template.
    const r = validateA2UIComponents({ components: validComponents(), data: VALID_DATA, catalog: CATALOG });
    expect(r.errors.some((e) => e.code === "unresolved_binding")).toBe(false);
  });

  it("defers binding checks when validateBindings is false (streaming component-close boundary)", () => {
    // At the streaming boundary the components array has closed but the data
    // model has not streamed yet — binding resolution would false-positive.
    const r = validateA2UIComponents({
      components: validComponents(),
      data: {},
      catalog: CATALOG,
      validateBindings: false,
    });
    expect(r.errors.some((e) => e.code === "unresolved_binding")).toBe(false);
    expect(r.valid).toBe(true);
  });
});
