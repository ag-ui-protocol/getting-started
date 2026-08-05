/** Shared limits. */

/** Tool results can be large; the UI only needs a readable prefix. */
export const TOOL_RESULT_MAX_CHARS = 4000;
/** Search result bodies can be long; show only a readable prefix. */
export const SEARCH_RESULT_PREVIEW_CHARS = 300;
/** Managed Agents tool names allow only [A-Za-z0-9_-], up to this many chars. */
export const TOOL_NAME_MAX_LENGTH = 128;
/** Tool descriptions are capped by the API at 1-4096 characters. */
export const TOOL_DESCRIPTION_MAX_LENGTH = 4096;
/**
 * How many thread↔session mappings the default in-memory store keeps. Thread
 * ids are client-supplied, so the map has to be bounded; past this the
 * least-recently-used mapping is evicted and that thread starts a fresh
 * session on its next run.
 */
export const IN_MEMORY_SESSION_STORE_MAX_ENTRIES = 10_000;
/**
 * Backoff for re-posting follow-up messages while a session finishes
 * un-parking; that transition happens asynchronously after a tool result.
 * Six retries after the first attempt (seven attempts total).
 */
export const PARKED_RETRY_DELAYS_MS = [150, 300, 600, 1000, 1500, 2000];
/** Abort a turn that runs longer than this unless configured otherwise. */
export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Bound on best-effort sends that must survive the run's own abort (tool
 * results, confirmations): long enough for a healthy API call, short enough
 * that a stalled connection cannot hold the thread's run gate open.
 */
export const BEST_EFFORT_SEND_TIMEOUT_MS = 15_000;
