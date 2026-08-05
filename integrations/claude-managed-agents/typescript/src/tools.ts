import type { BetaManagedAgentsCustomToolParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { Tool } from "@ag-ui/client";
import { TOOL_DESCRIPTION_MAX_LENGTH, TOOL_NAME_MAX_LENGTH } from "./constants";

export type CustomToolParams = BetaManagedAgentsCustomToolParams;

const TOOL_NAME_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${TOOL_NAME_MAX_LENGTH}}$`);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
};

/** Managed Agents tool names allow only [A-Za-z0-9_-], up to 128 chars. */
export const normalizeToolName = (name: string): string => {
  if (TOOL_NAME_PATTERN.test(name)) return name;
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, TOOL_NAME_MAX_LENGTH) || "tool";
};

/**
 * The AG-UI tool's JSON Schema, as a managed-agent input schema.
 *
 * The caller's schema is passed through whole: `$defs`, `$ref`, `oneOf`,
 * `additionalProperties`, per-property descriptions and any other keyword
 * survive. Copying only `properties` and `required` used to drop the rest —
 * which silently invalidated every `$ref` whose `$defs` went with it — so
 * anything the API accepts must reach it intact.
 *
 * `type` is the one field forced: the API accepts object input schemas only.
 */
const toInputSchema = (parameters: unknown): CustomToolParams["input_schema"] => {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { type: "object", properties: {} };
  }
  return { ...(parameters as Record<string, unknown>), type: "object" };
};

/** An AG-UI (frontend) or backend tool definition → managed-agent custom tool. */
export const customToolFrom = (tool: Pick<Tool, "name" | "description" | "parameters">): CustomToolParams => ({
  type: "custom",
  name: normalizeToolName(tool.name),
  description: (tool.description || `Tool ${tool.name}`).slice(0, TOOL_DESCRIPTION_MAX_LENGTH),
  input_schema: toInputSchema(tool.parameters),
});

/**
 * Stable representation used to detect any change to a session's tool list.
 *
 * Fingerprints whatever list is actually registered on the session — base tools
 * included, not just the custom ones — because an override session's list is a
 * full replacement frozen at the last update: a Console edit to the agent's own
 * tools changes what the session should hold without changing any custom tool.
 */
export const toolsFingerprint = (tools: readonly unknown[]): string => JSON.stringify(canonicalize(tools)) ?? "[]";
