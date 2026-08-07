import { describe, expect, it } from "vitest";
import { SEARCH_RESULT_PREVIEW_CHARS, TOOL_DESCRIPTION_MAX_LENGTH, TOOL_NAME_MAX_LENGTH } from "../constants";
import { decodeEntities, describeToolResult, textOf } from "../text";
import { customToolFrom, normalizeToolName } from "../tools";

describe("normalizeToolName", () => {
  it("keeps names that are already valid", () => {
    expect(normalizeToolName("show_chart")).toBe("show_chart");
    expect(normalizeToolName("Get-Weather_2")).toBe("Get-Weather_2");
  });

  it("replaces invalid characters, truncates, and never returns empty", () => {
    expect(normalizeToolName("search web!")).toBe("search_web_");
    expect(normalizeToolName("x".repeat(200))).toBe("x".repeat(TOOL_NAME_MAX_LENGTH));
    expect(normalizeToolName("")).toBe("tool");
  });
});

describe("customToolFrom", () => {
  it("builds an input schema and a default description", () => {
    expect(customToolFrom({ name: "ping", description: "", parameters: { properties: { a: { type: "string" } } } })).toEqual({
      type: "custom",
      name: "ping",
      description: "Tool ping",
      input_schema: { type: "object", properties: { a: { type: "string" } } },
    });
  });

  it("handles missing parameters", () => {
    expect(customToolFrom({ name: "ping", description: "Ping", parameters: undefined as never }).input_schema).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("preserves a nested schema with reused definitions", () => {
    // Regression: only `properties` and `required` were copied, so `$defs`
    // vanished and every `$ref` pointing into it became dangling.
    const parameters = {
      type: "object",
      description: "A route",
      additionalProperties: false,
      properties: {
        from: { $ref: "#/$defs/point" },
        to: { $ref: "#/$defs/point" },
        via: { type: "array", items: { $ref: "#/$defs/point" } },
      },
      required: ["from", "to"],
      $defs: {
        point: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
        },
      },
    };

    expect(customToolFrom({ name: "route", description: "Plot", parameters }).input_schema).toEqual(parameters);
  });

  it("preserves composition keywords and a top-level $ref", () => {
    const anyOf = { type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }], properties: { a: {}, b: {} } };
    expect(customToolFrom({ name: "either", description: "d", parameters: anyOf }).input_schema).toEqual(anyOf);

    const topLevelRef = { $ref: "#/$defs/args", $defs: { args: { type: "object", properties: { q: { type: "string" } } } } };
    expect(customToolFrom({ name: "ref", description: "d", parameters: topLevelRef }).input_schema).toEqual({
      ...topLevelRef,
      // The API accepts object input schemas only, so `type` is asserted.
      type: "object",
    });
  });

  it("falls back to an empty object schema for a non-object parameters value", () => {
    for (const parameters of [undefined, null, "nope", 7, [1, 2]] as never[]) {
      expect(customToolFrom({ name: "ping", description: "d", parameters }).input_schema).toEqual({
        type: "object",
        properties: {},
      });
    }
  });

  it("normalizes the name and caps the description at the API's limit", () => {
    const tool = customToolFrom({ name: "search web!", description: "d".repeat(TOOL_DESCRIPTION_MAX_LENGTH + 50), parameters: {} });
    expect(tool.name).toBe("search_web_");
    expect(tool.description).toHaveLength(TOOL_DESCRIPTION_MAX_LENGTH);
    // The API accepts 1-4096; capping lower silently truncated valid descriptions.
    expect(TOOL_DESCRIPTION_MAX_LENGTH).toBe(4096);
    expect(customToolFrom({ name: "ok", description: "d".repeat(2000), parameters: {} }).description).toHaveLength(2000);
  });
});

describe("textOf", () => {
  it("joins only the text blocks", () => {
    expect(textOf([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("ab");
    expect(textOf(null)).toBe("");
  });
});

describe("decodeEntities", () => {
  it("decodes numeric and named entities", () => {
    expect(decodeEntities("5 &lt; 6 &amp;&amp; &#x1F600; &#65; &quot;q&quot; &gt;")).toBe('5 < 6 && \u{1F600} A "q" >');
  });

  it("decodes the same inputs as the Python and .NET ports", () => {
    // Every case here is one where the three ports could drift apart. They are
    // asserted identically in all three suites.
    // An uppercase hex marker is accepted (`&#[xX]`).
    expect(decodeEntities("&#X41;")).toBe("A");
    // Non-ASCII digits are NOT numeric references: Python's `\d` would have
    // matched the whole Unicode Nd category and decoded this to "A".
    expect(decodeEntities("&#\u0666\u0665;")).toBe("&#\u0666\u0665;");
    // An absurdly long decimal folds to U+FFFD rather than raising: CPython
    // refuses to convert more than 4300 decimal digits at all.
    expect(decodeEntities(`&#${"1".repeat(5000)};`)).toBe("\uFFFD");
  });

  it("resolves each entity exactly once", () => {
    // Regression: decoding numeric entities before named ones turned `&#38;lt;`
    // into `&lt;` and then into `<`, discarding the escaping the source wrote.
    expect(decodeEntities("&#38;lt;")).toBe("&lt;");
    expect(decodeEntities("&#x26;lt;")).toBe("&lt;");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&amp;amp;")).toBe("&amp;");
    expect(decodeEntities("&#38;#60;")).toBe("&#60;");
  });

  it("substitutes U+FFFD for entities that do not denote a usable character", () => {
    // A lone surrogate makes the string ill-formed UTF-16: it cannot be encoded
    // as UTF-8, so it would arrive as U+FFFD (or crash the encoder) anyway.
    // Every port rejects it here instead, identically.
    expect(decodeEntities("a&#xD800;b")).toBe("a�b");
    expect(decodeEntities("a&#55296;b")).toBe("a�b");
    expect(decodeEntities("a&#xDFFF;b")).toBe("a�b");
    // Out of range, and the boundaries around the surrogate block, still work.
    expect(decodeEntities("a&#x110000;b")).toBe("a�b");
    expect(decodeEntities("a&#xD7FF;&#xE000;b")).toBe("a\uD7FF\uE000b");
    // A well-formed surrogate pair written as one code point is unaffected.
    expect(decodeEntities("&#x1F600;")).toBe("\u{1F600}");
  });

  it("leaves unknown and malformed entities alone", () => {
    expect(decodeEntities("&nbsp; &copy; &#; &# 65; &lt")).toBe("&nbsp; &copy; &#; &# 65; &lt");
  });
});

describe("describeToolResult", () => {
  it("summarizes each block type and decodes only search results", () => {
    const described = describeToolResult([
      { type: "text", text: "5 &lt; 6 &amp;&amp; &#x1F600; &#65;" },
      { type: "search_result", title: "T &amp; U", source: "https://x", content: [{ type: "text", text: "a &lt; b" }] },
      { type: "document" },
    ]);
    expect(described).toBe(
      "5 &lt; 6 &amp;&amp; &#x1F600; &#65;\n[search result] T & U — https://x\na < b\n[document]",
    );
  });

  it("passes literal tool output through verbatim", () => {
    // A file read or shell transcript means `&lt;` literally; decoding it would
    // corrupt the very output the user asked to see.
    const html = '<a href="x">&lt;div&gt;</a> &amp; more';
    expect(describeToolResult([{ type: "text", text: html }])).toBe(html);
  });

  it("shows only a preview of a long search result body", () => {
    const described = describeToolResult([
      { type: "search_result", title: "T", source: "https://x", content: [{ type: "text", text: "b".repeat(SEARCH_RESULT_PREVIEW_CHARS + 200) }] },
    ]);
    expect(described).toBe(`[search result] T — https://x\n${"b".repeat(SEARCH_RESULT_PREVIEW_CHARS)}`);
  });

  it("uses a [type] placeholder for unknown blocks and handles nothing", () => {
    expect(describeToolResult([{ type: "image", source: {} }])).toBe("[image]");
    expect(describeToolResult(null)).toBe("");
  });
});
