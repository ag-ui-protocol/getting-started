// The `@ag-ui/core/schemas` subpath: the zod validators, and nothing else.
// Type-only consumers import the main entry; runtime validation imports this.
// Regenerate the generated source with `pnpm --filter @ag-ui/spec generate`.
//
// This is the ONLY entry of this package that touches zod, which is what lets
// zod be an optional peer dependency: an application that never validates
// never has to install it.
import { MetadataSchema } from "./generated/schemas";

export * from "./generated/schemas";
export { PROTOCOL_VERSION } from "./generated/version";

/** The discriminated union of every event validator, under its historic name. */
export { EventSchema as EventSchemas } from "./generated/schemas";

/**
 * Historic aliases for the media input part validators: the schema names them
 * ...InputContent, and this package has always also exported them as
 * ...InputPart.
 */
export {
  ImageInputContentSchema as ImageInputPartSchema,
  AudioInputContentSchema as AudioInputPartSchema,
  VideoInputContentSchema as VideoInputPartSchema,
  DocumentInputContentSchema as DocumentInputPartSchema,
} from "./generated/schemas";

/**
 * How metadata is declared on events and messages.
 *
 * The object itself is absent or an object, never `null` — and parsing enforces
 * that invariant rather than coercing a `null` to absent. The schema pinning it
 * now lives in the generated source (MetadataSchema in
 * src/generated/schemas.ts); this comment survives as the recorded reasoning.
 *
 * This is deliberately NOT the treatment `parentMessageId` and `outcome`
 * receive. Those USED to tolerate `null`, because released producers emitted it
 * before the producer-side omission fix and rejecting it would have broken
 * agents already in the wild. The generated schema no longer does
 * (`parentMessageId: z.string().optional()`, `outcome:
 * RunFinishedOutcomeSchema.optional()` in src/generated/schemas.ts) — which is
 * exactly WHY they, and only they, moved into the compatibility boundary with
 * PNI-207: the tolerance had to go somewhere, and a validator that mirrors the
 * schema is not it. Metadata has no such history: it postdates that fix,
 * and no released Python or .NET package has ever emitted `"metadata": null`.
 * Adding a tolerance here would grandfather in a fourth exception with nobody
 * to protect; enforcing from day one means there is never anything to retire.
 *
 * A `null` *value under a key* is meaningful data and is preserved. Only a
 * `null` in place of the whole object is a contract violation.
 */
export const OptionalMetadataSchema = MetadataSchema.optional();
