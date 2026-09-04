/**
 * Proves that rawName survives real @ag-ui/core schema parsing.
 *
 * This file intentionally does NOT mock @ag-ui/core -- it imports the real
 * ToolCallSchema, ToolCallStartEventSchema, and EventType so the assertions
 * exercise the actual Zod schemas from the upstream package.
 *
 * - On events: rawName lives inside event `metadata` (a z.record(z.any()) field
 *   declared on BaseEventSchema, inherited by ToolCallStartEventSchema).
 * - On messages: rawName lives inside tool-call `metadata` (same z.record type
 *   declared on ToolCallSchema).
 */
import { describe, it, expect } from "vitest";
import {
  ToolCallSchema,
  ToolCallStartEventSchema,
  EventType,
} from "@ag-ui/core";

describe("schema survival: rawName via metadata (real @ag-ui/core schemas)", () => {
  describe("ToolCallStartEventSchema (event metadata)", () => {
    it("preserves metadata.rawName for an MCP tool", () => {
      const parsed = ToolCallStartEventSchema.parse({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "Bash",
        metadata: { rawName: "mcp__sandbox__Bash" },
      });
      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata!.rawName).toBe("mcp__sandbox__Bash");
    });

    it("preserves metadata.rawName equal to display name for a built-in tool", () => {
      const parsed = ToolCallStartEventSchema.parse({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-2",
        toolCallName: "Read",
        metadata: { rawName: "Read" },
      });
      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata!.rawName).toBe("Read");
    });

    it("accepts an event with no metadata", () => {
      const parsed = ToolCallStartEventSchema.parse({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-3",
        toolCallName: "Write",
      });
      expect(parsed.metadata).toBeUndefined();
    });
  });

  describe("ToolCallSchema (message tool-call metadata)", () => {
    it("preserves metadata.rawName for an MCP tool call", () => {
      const parsed = ToolCallSchema.parse({
        id: "tc-1",
        type: "function",
        function: { name: "Read", arguments: "{}" },
        metadata: { rawName: "mcp__sandbox__Read" },
      });
      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata!.rawName).toBe("mcp__sandbox__Read");
    });

    it("preserves metadata.rawName equal to display name for a built-in tool", () => {
      const parsed = ToolCallSchema.parse({
        id: "tc-2",
        type: "function",
        function: { name: "Write", arguments: "{}" },
        metadata: { rawName: "Write" },
      });
      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata!.rawName).toBe("Write");
    });

    it("accepts a tool call with no metadata", () => {
      const parsed = ToolCallSchema.parse({
        id: "tc-3",
        type: "function",
        function: { name: "Bash", arguments: "{}" },
      });
      expect(parsed.metadata).toBeUndefined();
    });
  });
});
