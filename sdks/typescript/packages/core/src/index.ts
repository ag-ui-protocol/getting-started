// The generated protocol source: types and constants, regenerated from
// spec/draft/schema.json (`pnpm --filter @ag-ui/spec generate`).
//
// The zod validators are deliberately NOT here. They live behind the
// `@ag-ui/core/schemas` subpath so that importing this entry pulls no zod at
// runtime — which is what lets zod be an OPTIONAL peer dependency of this
// package. Types (including every capability type) are erased at compile time
// and stay on this entry.
export * from "./generated/types";
export { PROTOCOL_VERSION } from "./generated/version";

// The names this package has always exported, pointed at the generated source.
// BaseEvent is named explicitly: the compat shape (with the historic open
// index signature) shadows the generated exact shape, which a named export
// wins over a star export.
export * from "./compat";
export type { BaseEvent } from "./compat";

// Export metadata helpers, merge primitive and the reserved key
export * from "./metadata";

// Token usage helpers (aggregation + LangChain-family metadata mapping)
export * from "./token-usage";
