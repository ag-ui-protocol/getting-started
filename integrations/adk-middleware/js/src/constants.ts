export const AG_UI_MESSAGE_ID_METADATA_KEY = "_ag_ui_message_id";
export const AG_UI_RESUME_IDS_METADATA_KEY = "_ag_ui_resume_ids";
/** One bookkeeping record per AG-UI run, on an `ag-ui-run-<runId>` session event. */
export const AG_UI_RUN_KEY = "_ag_ui_run";

export const AG_UI_STATE_KEY = "_ag_ui_state";
export const AG_UI_STATE_KEYS_KEY = "_ag_ui_state_keys";
export const AG_UI_CONTEXT_KEY = "_ag_ui_context";
export const AG_UI_FORWARDED_PROPS_KEY = "_ag_ui_forwarded_props";

export const AG_UI_INTERNAL_STATE_KEYS = new Set([
  AG_UI_STATE_KEY,
  AG_UI_STATE_KEYS_KEY,
  AG_UI_CONTEXT_KEY,
  AG_UI_FORWARDED_PROPS_KEY,
]);

const ADK_SPECIAL_STATE_PREFIXES = ["app:", "user:", "temp:"] as const;

export function isAdkSpecialStateKey(key: string): boolean {
  return ADK_SPECIAL_STATE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export const ADK_RAW_EVENT_SOURCE = "google-adk";
export const ADK_METADATA_KEY = "google-adk";

/**
 * AG-UI message ids derived from an ADK event. The translator mints them and
 * the session bridge recognizes them in history, so they must agree.
 */
export function reasoningMessageId(eventId: string): string {
  return `${eventId}:reasoning`;
}

export function toolResultIds(
  eventId: string,
  responseId: string | undefined,
  partIndex: number,
): { toolCallId: string; messageId: string } {
  const toolCallId = responseId || `${eventId}:result:${partIndex}`;
  return { toolCallId, messageId: `${eventId}:${toolCallId}` };
}
