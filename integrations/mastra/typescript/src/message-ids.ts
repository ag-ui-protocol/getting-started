/**
 * The AG-UI message-id scheme for a Mastra turn, shared by the live bridge
 * ({@link MastraAgent}) and the stored-history converter
 * ({@link convertMastraMessagesToAGUI}).
 *
 * Mastra stores a whole turn — text, tool calls, tool results, further text —
 * as ordered parts of ONE stored message, while AG-UI models the same turn as
 * assistant -> tool -> assistant. Both directions therefore have to split the
 * turn into several AG-UI messages, and both must derive the same ids for the
 * pieces: `selectNewMessages` recognises a stored turn's whole continuation
 * family from its stored base id and filters it out of the next run, so
 * re-sent history (live) and restored history (after a reload) are both
 * dropped instead of being persisted a second time.
 */

/**
 * Suffix appended to a turn's base (Mastra-stored) messageId to key the
 * SEPARATE AG-UI message that carries assistant text streamed AFTER a tool
 * call in the same turn.
 */
export const ASSISTANT_TEXT_CONTINUATION_SUFFIX = "-agui-text";

/**
 * Matches any id produced by {@link continuationMessageId}, capturing the base
 * id it was derived from. Lets a caller recognise the whole continuation family
 * of a stored turn without knowing how many segments the turn had.
 */
const CONTINUATION_ID_PATTERN = new RegExp(
  `^(.+)${ASSISTANT_TEXT_CONTINUATION_SUFFIX}(?:-\\d+)?$`,
);

/**
 * Deterministic id for the `index`-th "trailing text" continuation message
 * split off a turn whose tool call already rendered under `baseId`. A turn can
 * alternate text -> tool -> text more than once, so each contiguous run of
 * text after a tool call gets its own index and therefore its own AG-UI
 * message (reusing one id makes the client append later segments onto the
 * message at its original index — run-on text above the cards it followed).
 *
 * Index 1 is the bare suffix, so single-boundary turns keep the exact id they
 * had before.
 */
export function continuationMessageId(baseId: string, index = 1): string {
  return index <= 1
    ? `${baseId}${ASSISTANT_TEXT_CONTINUATION_SUFFIX}`
    : `${baseId}${ASSISTANT_TEXT_CONTINUATION_SUFFIX}-${index}`;
}

/**
 * The base id a continuation id was derived from, or null if `id` is not a
 * continuation id at all. Callers must still check the result against the ids
 * Mastra actually stored — the suffix shape alone does not make an id ours.
 */
export function continuationBaseId(id: string): string | null {
  return CONTINUATION_ID_PATTERN.exec(id)?.[1] ?? null;
}

/**
 * Deterministic id for the AG-UI `tool` message that carries a stored tool
 * result. Mastra keeps the result inside the assistant turn's parts, so there
 * is no stored id to reuse: deriving it from the (unique) toolCallId keeps the
 * id stable across reloads, so restoring a thread twice does not produce two
 * different tool messages for the same call.
 *
 * NOTE: the live stream still mints a random id for TOOL_CALL_RESULT, so a
 * live turn and the same turn after a reload do not share tool-message ids.
 * That is invisible in the UI (only one of the two exists at a time) but it
 * does mean a restored tool result is persisted once as its own Mastra row.
 */
export function toolResultMessageId(toolCallId: string): string {
  return `${toolCallId}-result`;
}
