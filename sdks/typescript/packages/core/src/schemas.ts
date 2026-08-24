// The `@ag-ui/core/schemas` subpath: the generated zod validators, and nothing
// else. Type-only consumers import the main entry; runtime validation imports
// this. Regenerate with `pnpm --filter @ag-ui/spec generate`.
export * from "./generated/schemas";
export { PROTOCOL_VERSION } from "./generated/version";
