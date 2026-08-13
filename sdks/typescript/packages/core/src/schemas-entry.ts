// Entry point for the `@ag-ui/core/schemas` subpath (emitted as dist/schemas.*).
//
// Kept as a thin barrel so `schemas.ts` (the schema definitions) and
// `event-factories.ts` (which imports those definitions) do not form an import
// cycle. Everything reachable from here requires zod; the main `@ag-ui/core`
// entry stays dependency-free.

export * from "./schemas";
export * from "./event-factories";
