// The generated protocol source: types, constants and validators, regenerated
// from spec/draft/schema.json (`pnpm --filter @ag-ui/spec generate`).
export * from "./generated/types";
export * from "./generated/schemas";
export { PROTOCOL_VERSION } from "./generated/version";

// The names this package has always exported, pointed at the generated source.
// BaseEvent is named explicitly: the compat shape (with the historic open
// index signature) shadows the generated exact shape, which a named export
// wins over a star export.
export * from "./compat";
export type { BaseEvent } from "./compat";

// Export metadata helpers, merge primitive and the reserved key
export * from "./metadata";

// Export all capability-related types and schemas
export {
  SubAgentInfoSchema,
  IdentityCapabilitiesSchema,
  TransportCapabilitiesSchema,
  ToolsCapabilitiesSchema,
  OutputCapabilitiesSchema,
  StateCapabilitiesSchema,
  MultiAgentCapabilitiesSchema,
  ReasoningCapabilitiesSchema,
  MultimodalInputCapabilitiesSchema,
  MultimodalOutputCapabilitiesSchema,
  MultimodalCapabilitiesSchema,
  ExecutionCapabilitiesSchema,
  HumanInTheLoopCapabilitiesSchema,
  AgentCapabilitiesSchema,
} from "./capabilities";
export type {
  SubAgentInfo,
  IdentityCapabilities,
  TransportCapabilities,
  ToolsCapabilities,
  OutputCapabilities,
  StateCapabilities,
  MultiAgentCapabilities,
  ReasoningCapabilities,
  MultimodalInputCapabilities,
  MultimodalOutputCapabilities,
  MultimodalCapabilities,
  ExecutionCapabilities,
  HumanInTheLoopCapabilities,
  AgentCapabilities,
} from "./capabilities";

// Token usage helpers (aggregation + LangChain-family metadata mapping)
export * from "./token-usage";
