export { enforceEvents, enforceOutgoingInput, isRecognizedEvent } from "./enforce";
export type { UnrecognizedEvent } from "./enforce";

// `stripUnknown` and `StripResult` are deliberately NOT re-exported. Their
// signatures name zod types, and a zod-shaped value on the public API pins
// every consumer to the same zod copy this package resolved. They stay
// internal to ./enforce; import them from "./strip" inside the package.
