export const AG_UI_MESSAGE_ID_METADATA_KEY = "_ag_ui_message_id";
export const AG_UI_EMITTED_MESSAGE_IDS_METADATA_KEY =
  "_ag_ui_emitted_message_ids";
export const AG_UI_RESUME_IDS_METADATA_KEY = "_ag_ui_resume_ids";
export const AG_UI_RESUME_FINGERPRINT_METADATA_KEY =
  "_ag_ui_resume_fingerprint";
export const AG_UI_RESUME_COMPLETED_METADATA_KEY = "_ag_ui_resume_completed";
export const AG_UI_RESUME_REPLAY_METADATA_KEY = "_ag_ui_resume_replay";

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

export const ADK_SPECIAL_STATE_PREFIXES = ["app:", "user:", "temp:"] as const;

export function isAdkSpecialStateKey(key: string): boolean {
  return ADK_SPECIAL_STATE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export const ADK_RAW_EVENT_SOURCE = "google-adk";
export const ADK_METADATA_KEY = "google-adk";
