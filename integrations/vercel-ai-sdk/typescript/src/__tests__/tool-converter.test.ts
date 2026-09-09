import { describe, expect, it } from "vitest";
import { convertToolsToVercelAISDKTools, convertToolToVerlAISDKTools } from "../tool-converter";

describe("convertToolsToVercelAISDKTools", () => {
  it("returns an empty ToolSet for an empty input", () => {
    expect(convertToolsToVercelAISDKTools([])).toEqual({});
  });

  it("converts a simple tool with object parameters", () => {
    const result = convertToolsToVercelAISDKTools([
      {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);
    expect(result).toHaveProperty("get_weather");
    expect(result.get_weather.description).toBe("Get weather for a city");
    expect(result.get_weather.inputSchema).toBeDefined();
  });

  it("preserves a complex JSON Schema (nested + array + enum + oneOf) without transformation", () => {
    const schema = {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["all", "any"] },
            values: { type: "array", items: { type: "string" } },
          },
          required: ["mode"],
        },
        ref: {
          oneOf: [{ type: "string" }, { type: "number" }],
        },
      },
      required: ["filter"],
    };
    const result = convertToolsToVercelAISDKTools([
      { name: "complex_tool", description: "Has nested schema", parameters: schema },
    ]);
    // jsonSchema() wraps the raw schema; we just confirm it round-trips identifiable
    expect(result.complex_tool).toBeDefined();
    const inputSchema = result.complex_tool.inputSchema as { jsonSchema?: unknown };
    expect(inputSchema.jsonSchema).toEqual(schema);
  });

  it("handles tools with empty/missing parameters gracefully", () => {
    const result = convertToolsToVercelAISDKTools([
      {
        name: "ping",
        description: "No-arg tool",
        parameters: undefined as unknown as Record<string, unknown>,
      },
    ]);
    expect(result.ping).toBeDefined();
    expect(result.ping.description).toBe("No-arg tool");
  });

  it("converts multiple tools into the same ToolSet", () => {
    const result = convertToolsToVercelAISDKTools([
      { name: "a", description: "A", parameters: { type: "object", properties: {} } },
      { name: "b", description: "B", parameters: { type: "object", properties: {} } },
    ]);
    expect(Object.keys(result).sort()).toEqual(["a", "b"]);
  });

  it("exposes the typo'd legacy alias for backward compatibility", () => {
    expect(convertToolToVerlAISDKTools).toBe(convertToolsToVercelAISDKTools);
  });
});
