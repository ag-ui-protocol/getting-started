import { tool, jsonSchema, type ToolSet } from "ai";
import type { Tool as AGUITool } from "@ag-ui/core";

/**
 * Convert AG-UI tool definitions into an AI SDK ToolSet.
 *
 * AG-UI tools carry parameters as a raw JSON Schema. Vercel AI SDK v7 accepts
 * JSON Schema directly via the `jsonSchema()` helper, so we wrap each entry
 * without any manual schema transformation. This is intentionally minimal:
 * we do not attach an `execute` function — tools defined here will be surfaced
 * back to the AG-UI client as TOOL_CALL_* events for client-side execution.
 */
export function convertToolsToVercelAISDKTools(aguiTools: AGUITool[]): ToolSet {
  const result: ToolSet = {};
  for (const t of aguiTools) {
    result[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters ?? { type: "object", properties: {} }),
    });
  }
  return result;
}

// Backward-compatible alias (typo'd export from earlier versions).
export const convertToolToVerlAISDKTools = convertToolsToVercelAISDKTools;
