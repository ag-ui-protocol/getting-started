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
 * Historically tolerated whole optional nulls are translated to absence in
 * the client's compatibility boundary before validation. That includes the
 * legacy `parentMessageId` and `outcome` cases and optional JSON fields such as
 * `rawEvent`, `result`, and media content-part `metadata`; see the repo-root
 * DEPRECATIONS.md for the exact list. Event and message metadata already
 * rejected a whole `null`, so their restriction remains. Compatibility for
 * media content-part metadata does not broaden this shared metadata schema.
 *
 * A `null` *value under a key* is meaningful data and is preserved. Only a
 * `null` in place of the whole object is a contract violation.
 */
export const OptionalMetadataSchema = MetadataSchema.optional();
