import { describe, it, expect } from "vitest";
import {
  extractCompleteItems,
  extractCompleteItemsWithStatus,
  extractCompleteObject,
  extractCompleteA2UIOperations,
  extractDataArrayItems,
  extractStringField,
} from "../src/json-extract";

describe("extractCompleteItems", () => {
  it("returns complete items from partial JSON", () => {
    const partial = '{"flights": [{"id":"1","name":"A"}, {"id":"2"';
    expect(extractCompleteItems(partial, "flights")).toEqual([{ id: "1", name: "A" }]);
  });

  it("returns multiple complete items", () => {
    const partial = '{"flights": [{"id":"1"}, {"id":"2"}, {"id":"3"';
    expect(extractCompleteItems(partial, "flights")).toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("returns all items when array is fully closed", () => {
    const partial = '{"flights": [{"id":"1"}, {"id":"2"}]}';
    expect(extractCompleteItems(partial, "flights")).toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("returns null when key is missing", () => {
    expect(extractCompleteItems('{"other": [1,2]}', "flights")).toBeNull();
  });

  it("returns null when no complete items exist", () => {
    expect(extractCompleteItems('{"flights": [{"id":"1', "flights")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractCompleteItems("", "flights")).toBeNull();
  });

  it("returns null when array bracket not yet received", () => {
    expect(extractCompleteItems('{"flights":', "flights")).toBeNull();
  });

  it("handles items with nested objects", () => {
    const partial = '{"items": [{"id":"1","meta":{"x":1}}, {"id":"2"';
    expect(extractCompleteItems(partial, "items")).toEqual([
      { id: "1", meta: { x: 1 } },
    ]);
  });

  it("handles items with nested arrays", () => {
    const partial = '{"items": [{"id":"1","tags":["a","b"]}, {"id":"2"';
    expect(extractCompleteItems(partial, "items")).toEqual([
      { id: "1", tags: ["a", "b"] },
    ]);
  });

  it("handles strings containing braces and brackets", () => {
    const partial = '{"items": [{"val":"}{]["}, {"id":"2"';
    expect(extractCompleteItems(partial, "items")).toEqual([{ val: "}{][" }]);
  });

  it("handles escaped characters in string values", () => {
    const partial = '{"items": [{"val":"line1\\nline2"}, {"id":"2"';
    expect(extractCompleteItems(partial, "items")).toEqual([
      { val: "line1\nline2" },
    ]);
  });
});

describe("extractCompleteItemsWithStatus", () => {
  it("returns arrayClosed=false when array is still streaming", () => {
    const partial = '{"flights": [{"id":"1"}, {"id":"2"';
    const result = extractCompleteItemsWithStatus(partial, "flights");
    expect(result).toEqual({ items: [{ id: "1" }], arrayClosed: false });
  });

  it("returns arrayClosed=true when array has closing bracket", () => {
    const partial = '{"flights": [{"id":"1"}, {"id":"2"}]}';
    const result = extractCompleteItemsWithStatus(partial, "flights");
    expect(result).toEqual({
      items: [{ id: "1" }, { id: "2" }],
      arrayClosed: true,
    });
  });

  it("returns arrayClosed=true for empty array", () => {
    const partial = '{"flights": []}';
    const result = extractCompleteItemsWithStatus(partial, "flights");
    // Empty array has no complete items
    expect(result).toBeNull();
  });

  it("does not scan into sibling properties", () => {
    // "components" array closes, then "items" array starts
    const partial = '{"components": [{"type":"a"}], "items": [{"x":1';
    const result = extractCompleteItemsWithStatus(partial, "components");
    expect(result).toEqual({
      items: [{ type: "a" }],
      arrayClosed: true,
    });
  });

  it("matches only the top-level key, not a nested same-named key", () => {
    // Regression: a component may carry its own `components` field (e.g.
    // catalog metadata) — the raw-indexOf scan would mis-target it. The
    // top-level `components` array must always win.
    const partial =
      '{"surfaceId":"s","wrapper":{"components":[{"nested":true}]},"components":[{"id":"root","component":"Row"}]}';
    const result = extractCompleteItemsWithStatus(partial, "components");
    expect(result).toEqual({
      items: [{ id: "root", component: "Row" }],
      arrayClosed: true,
    });
  });
});

describe("extractCompleteObject", () => {
  it("extracts a complete object value", () => {
    const partial = '{"surfaceId": "s1", "data": {"form": {"name": "Alice"}}, "components": []}';
    expect(extractCompleteObject(partial, "data")).toEqual({ form: { name: "Alice" } });
  });

  it("returns null when object is not yet closed", () => {
    const partial = '{"surfaceId": "s1", "data": {"form": {"name": "Ali';
    expect(extractCompleteObject(partial, "data")).toBeNull();
  });

  it("returns null when key is missing", () => {
    expect(extractCompleteObject('{"other": {"x": 1}}', "data")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractCompleteObject("", "data")).toBeNull();
  });

  it("returns null when colon not yet received", () => {
    expect(extractCompleteObject('{"data"', "data")).toBeNull();
  });

  it("returns null when opening brace not yet received", () => {
    expect(extractCompleteObject('{"data": ', "data")).toBeNull();
  });

  it("returns null when value is not an object", () => {
    expect(extractCompleteObject('{"data": [1, 2, 3]}', "data")).toBeNull();
    expect(extractCompleteObject('{"data": "string"}', "data")).toBeNull();
    expect(extractCompleteObject('{"data": 42}', "data")).toBeNull();
  });

  it("handles nested objects", () => {
    const partial = '{"data": {"a": {"b": {"c": 1}}}, "other": true}';
    expect(extractCompleteObject(partial, "data")).toEqual({ a: { b: { c: 1 } } });
  });

  it("handles nested arrays within the object", () => {
    const partial = '{"data": {"items": [1, 2, 3], "tags": ["a"]}, "x": 1}';
    expect(extractCompleteObject(partial, "data")).toEqual({ items: [1, 2, 3], tags: ["a"] });
  });

  it("handles strings containing braces", () => {
    const partial = '{"data": {"val": "}{]["}, "other": 1}';
    expect(extractCompleteObject(partial, "data")).toEqual({ val: "}{][" });
  });

  it("handles empty object", () => {
    const partial = '{"data": {}, "other": 1}';
    expect(extractCompleteObject(partial, "data")).toEqual({});
  });

  it("handles whitespace around colon and value", () => {
    const partial = '{"data" :  {"name": "Alice"} }';
    expect(extractCompleteObject(partial, "data")).toEqual({ name: "Alice" });
  });

  it("extracts form pre-fill data from render_a2ui args", () => {
    // Simulates actual render_a2ui streaming args
    const partial = '{"surfaceId": "name-form", "components": [{"id": "root"}], "data": {"form": {"name": "Markus"}}}';
    expect(extractCompleteObject(partial, "data")).toEqual({ form: { name: "Markus" } });
  });

  it("returns null when object is partially streamed after components", () => {
    // Simulates streaming: components done, data still arriving
    const partial = '{"surfaceId": "s1", "components": [{"id": "root"}], "data": {"form": {"name": "Mar';
    expect(extractCompleteObject(partial, "data")).toBeNull();
  });

  it("ignores a nested `data` property on a component and matches only the top-level key", () => {
    // Regression: a component may legitimately carry its own `data` field
    // (e.g. a Chart with `{"id":"c","component":"Chart","data":{"series":[1]}}`).
    // The earlier raw-indexOf locator would match that nested `"data"` token
    // first and return the component's data — wrong. The top-level
    // updateDataModel must always reflect the args' OUTER `data` value.
    const partial =
      '{"surfaceId":"s","components":[{"id":"c","component":"Chart","data":{"series":[1,2]}}],"data":{"series":[9]}}';
    expect(extractCompleteObject(partial, "data")).toEqual({ series: [9] });
  });

  it("ignores `data` value strings that happen to match the key spelling", () => {
    // A value like `{"label":"data"}` must not be mistaken for the key. The
    // scanner only matches when the next non-whitespace after the string is
    // a colon — value strings are followed by `,` or `}`.
    const partial = '{"label":"data","data":{"ok":true}}';
    expect(extractCompleteObject(partial, "data")).toEqual({ ok: true });
  });
});

describe("extractStringField", () => {
  it("extracts a complete string field", () => {
    expect(extractStringField('{"name": "Alice", "age": 30}', "name")).toBe("Alice");
  });

  it("returns null for incomplete string", () => {
    expect(extractStringField('{"name": "Ali', "name")).toBeNull();
  });

  it("returns null for missing key", () => {
    expect(extractStringField('{"name": "Alice"}', "missing")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractStringField("", "name")).toBeNull();
  });

  it("returns null when value is not a string", () => {
    expect(extractStringField('{"name": 42}', "name")).toBeNull();
  });

  it("handles escaped characters in value", () => {
    expect(extractStringField('{"path": "a\\\\b\\nc"}', "path")).toBe("a\\b\nc");
  });

  it("extracts the first occurrence at root level", () => {
    expect(
      extractStringField('{"a": "first", "nested": {"a": "inner"}, "a2": "other"}', "a"),
    ).toBe("first");
  });

  it("handles whitespace around colon", () => {
    expect(extractStringField('{"name" : "Alice"}', "name")).toBe("Alice");
  });
});

describe("extractCompleteA2UIOperations", () => {
  it("extracts complete operations from double-encoded JSON", () => {
    const inner = JSON.stringify([
      { surfaceUpdate: { id: "s1" } },
      { beginRendering: {} },
    ]);
    const outer = `{"a2ui_json": ${JSON.stringify(inner)}}`;
    const result = extractCompleteA2UIOperations(outer);
    expect(result).toEqual([
      { surfaceUpdate: { id: "s1" } },
      { beginRendering: {} },
    ]);
  });

  it("extracts complete operations from partial double-encoded JSON", () => {
    const inner = JSON.stringify([
      { surfaceUpdate: { id: "s1" } },
      { beginRendering: {} },
    ]);
    const full = `{"a2ui_json": ${JSON.stringify(inner)}}`;
    // Truncate in the middle of the second operation
    const partial = full.substring(0, full.indexOf("beginRendering") + 5);
    const result = extractCompleteA2UIOperations(partial);
    expect(result).toEqual([{ surfaceUpdate: { id: "s1" } }]);
  });

  it("returns null when no operations are complete", () => {
    const partial = '{"a2ui_json": "[{\\"surface';
    expect(extractCompleteA2UIOperations(partial)).toBeNull();
  });

  it("returns null when key is missing", () => {
    expect(extractCompleteA2UIOperations('{"other": "value"}')).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractCompleteA2UIOperations("")).toBeNull();
  });

  it("returns null when array bracket not yet received", () => {
    expect(extractCompleteA2UIOperations('{"a2ui_json": "')).toBeNull();
  });

  it("handles unicode escapes in the outer string", () => {
    // Inner JSON with a unicode character, double-encoded
    const innerObj = { msg: "hello \u00e9" };
    const inner = JSON.stringify([innerObj]);
    const outer = `{"a2ui_json": ${JSON.stringify(inner)}}`;
    const result = extractCompleteA2UIOperations(outer);
    expect(result).toEqual([innerObj]);
  });

  it("handles nested objects in operations", () => {
    const ops = [
      {
        surfaceUpdate: {
          id: "s1",
          components: [{ type: "text", props: { value: "hello" } }],
        },
      },
    ];
    const inner = JSON.stringify(ops);
    const outer = `{"a2ui_json": ${JSON.stringify(inner)}}`;
    expect(extractCompleteA2UIOperations(outer)).toEqual(ops);
  });
});

describe("extractDataArrayItems", () => {
  it("locates the top-level data object and streams its items", () => {
    const partial =
      '{"surfaceId":"s","components":[{"id":"root"}],"data":{"items":[{"name":"A"},{"name":"B"';
    const result = extractDataArrayItems(partial, "items");
    expect(result?.items).toEqual([{ name: "A" }]);
    expect(result?.arrayClosed).toBe(false);
  });

  it("ignores a component's nested `data` field and uses the outer data object", () => {
    // Regression: the previous raw-indexOf scoping would lock onto the
    // component's `data` substring and stream `series` instead of the outer
    // `items` array.
    const partial =
      '{"surfaceId":"s","components":[{"id":"c","component":"Chart","data":{"series":[1,2,3]}}],"data":{"items":[{"name":"A"}]}}';
    const result = extractDataArrayItems(partial, "items");
    expect(result?.items).toEqual([{ name: "A" }]);
    expect(result?.arrayClosed).toBe(true);
  });

  it("returns null when the data value is not an object", () => {
    // `data` is a string here, not an object — nothing to scope into.
    const partial = '{"surfaceId":"s","data":"not-an-object"}';
    expect(extractDataArrayItems(partial, "items")).toBeNull();
  });
});
