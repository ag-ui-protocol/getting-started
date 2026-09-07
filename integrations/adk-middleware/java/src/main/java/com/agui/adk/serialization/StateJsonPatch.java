package com.agui.adk.serialization;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure port of the exported Python {@code ag_ui_adk.utils.converters} JSON-Patch helpers:
 * {@code convert_state_to_json_patch} and {@code convert_json_patch_to_state} (RFC 6902).
 *
 * <p>This is the simple exported utility surface (a null value &rarr; {@code remove}, any other
 * value &rarr; {@code replace}, no key escaping); it intentionally differs from the richer
 * internal {@code StateTranslationStep} patch builder, which adds {@code JsonPointer} escaping,
 * {@code State.REMOVED}-sentinel handling, and defensive copies for the client-safe superset.
 */
public final class StateJsonPatch {

    private StateJsonPatch() {
    }

    /**
     * Converts a state delta to a JSON Patch (RFC 6902) operation list (Python
     * {@code convert_state_to_json_patch}).
     *
     * @param stateDelta state changes (may be null)
     * @return list of {@code {"op": "replace"/"remove", "path": "/<key>"[, "value": ...]}} ops
     */
    public static List<Map<String, Object>> convertStateToJsonPatch(Map<String, Object> stateDelta) {
        List<Map<String, Object>> patches = new ArrayList<>();
        if (stateDelta == null) {
            return patches;
        }
        for (Map.Entry<String, Object> entry : stateDelta.entrySet()) {
            Map<String, Object> patch = new LinkedHashMap<>();
            String path = "/" + entry.getKey();
            if (entry.getValue() == null) {
                patch.put("op", "remove");
                patch.put("path", path);
            } else {
                patch.put("op", "replace");
                patch.put("path", path);
                patch.put("value", entry.getValue());
            }
            patches.add(patch);
        }
        return patches;
    }

    /**
     * Converts JSON Patch operations back to a state delta (Python
     * {@code convert_json_patch_to_state}); {@code remove}&rarr;null, {@code add}/{@code replace}
     * &rarr;value, other ops ignored. Key = path with leading slashes stripped.
     *
     * @param patches JSON Patch operations (may be null)
     * @return state delta map
     */
    public static Map<String, Object> convertJsonPatchToState(List<Map<String, Object>> patches) {
        Map<String, Object> state = new LinkedHashMap<>();
        if (patches == null) {
            return state;
        }
        for (Map<String, Object> patch : patches) {
            if (patch == null) {
                continue;
            }
            String op = patch.get("op") == null ? null : String.valueOf(patch.get("op"));
            String path = patch.get("path") == null ? "" : String.valueOf(patch.get("path"));
            String key = path.replaceFirst("^/+", "");
            if ("remove".equals(op)) {
                state.put(key, null);
            } else if ("add".equals(op) || "replace".equals(op)) {
                state.put(key, patch.get("value"));
            }
        }
        return state;
    }
}
