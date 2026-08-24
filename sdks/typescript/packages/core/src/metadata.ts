import { MetadataSchema } from "./generated/schemas";
import type { Metadata } from "./generated/types";

/**
 * The key reserved for AG-UI's own use inside a metadata object. Every other
 * key is user space.
 *
 * Reservation is by convention: nothing rejects a write to this key at runtime,
 * because metadata is open by key and validating its shape would contradict
 * that.
 */
export const AGUI_METADATA_KEY = "ag-ui";

/**
 * Extra information attached to an event or a message.
 *
 * Open by key — any JSON value is allowed under a key, including `null`.
 *
 * Deliberately `z.any()` rather than a recursive JSON-value schema, which review
 * has suggested more than once. Two reasons. Every dynamic payload in the
 * protocol uses the permissive form — `state`, `rawEvent`, `CustomEvent.value`,
 * `ActivityMessage.content`, and the pre-existing `Tool.metadata` and
 * `Interrupt.metadata` — so tightening this one field would make it the sole
 * outlier while fixing nothing elsewhere. And a recursive validation would walk
 * every value on every event, on the streaming hot path, to catch a mistake
 * (a function, a bigint) that already fails loudly at encode time.
 *
 * The schema itself now lives in the generated source (MetadataSchema in
 * src/generated/schemas.ts); this comment survives as the recorded reasoning.
 */
/**
 * How metadata is declared on events and messages.
 *
 * The object itself is absent or an object, never `null` — and parsing enforces
 * that invariant rather than coercing a `null` to absent. The schema pinning it
 * now lives in the generated source (MetadataSchema in
 * src/generated/schemas.ts); this comment survives as the recorded reasoning.
 *
 * This is deliberately NOT the treatment `parentMessageId` and `outcome`
 * receive. Those tolerate `null` because released producers emitted it before
 * the producer-side omission fix, and rejecting it would break agents already
 * in the wild — which is why they, and only they, move into the compatibility
 * middleware with PNI-207. Metadata has no such history: it postdates that fix,
 * and no released Python or .NET package has ever emitted `"metadata": null`.
 * Adding a tolerance here would grandfather in a fourth exception with nobody
 * to protect; enforcing from day one means there is never anything to retire.
 *
 * A `null` *value under a key* is meaningful data and is preserved. Only a
 * `null` in place of the whole object is a contract violation.
 */
export const OptionalMetadataSchema = MetadataSchema.optional();

/**
 * Folds `incoming` metadata into `existing`, key by key, with the last write
 * winning.
 *
 * A message is assembled from a sequence of events, and the interesting values
 * — token usage and finish reason among them — are only known at the end. So
 * metadata accumulates as the sequence arrives rather than being fixed at the
 * start.
 *
 * A key's value is replaced outright. This never recurses, so an array or
 * object under any key — including {@link AGUI_METADATA_KEY} — is replaced
 * wholesale rather than blended with what was there before.
 *
 * Returns a new object rather than mutating either argument. An absent
 * `incoming` returns `existing` untouched; an empty `incoming` changes nothing.
 */
export function mergeMetadata(
  existing: Metadata | undefined,
  incoming: Metadata | undefined,
): Metadata | undefined {
  if (incoming === undefined) {
    return existing;
  }
  if (existing === undefined) {
    return { ...incoming };
  }
  return { ...existing, ...incoming };
}
