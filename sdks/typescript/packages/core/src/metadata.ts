import { z } from "zod";

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
 * One consequence worth knowing: `z.record` drops an own `__proto__` key, which
 * is its prototype-pollution guard. Preserving it would need null-prototype
 * objects throughout parsing and protobuf conversion, handing every consumer
 * objects where `hasOwnProperty` throws — a real cost for a key that is
 * essentially only ever an attack probe. Python keeps it; TypeScript does not.
 */
export const MetadataSchema = z.record(z.any());

export type Metadata = z.infer<typeof MetadataSchema>;

/**
 * How metadata is declared on events and messages.
 *
 * The object itself is absent or an object, never `null` — that is the
 * invariant a producer must uphold, and it always holds after parsing.
 *
 * Parsing is deliberately more forgiving than that invariant: an explicit
 * `null` is accepted and coerced to absent. Pydantic models serialized with a
 * plain `model_dump()` — no `exclude_none=True` — emit `"metadata": null` for
 * an unset object, and rejecting that would make the Python SDK fail to parse
 * its own output. This is the same treatment `parentMessageId` and `outcome`
 * already receive in `events.ts`, for exactly the same reason.
 *
 * Note the asymmetry, which is intentional: a `null` *value under a key* is
 * meaningful data and is preserved. Only a `null` in place of the whole object
 * is treated as absent.
 */
export const OptionalMetadataSchema = MetadataSchema.nullable()
  .optional()
  .transform((v) => v ?? undefined);

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
