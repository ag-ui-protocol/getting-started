package com.agui.adk.history;

import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure port of the Python {@code ADKAgent._extract_lro_id_remap}: builds the LRO function-call
 * id remap from a non-partial event's function calls. When SSE streaming is enabled, ADK's
 * {@code populate_client_function_call_id} emits different UUIDs for the same call across partial
 * and final events; this maps the client-facing id (emitted from the partial event) to the
 * ADK-persisted id (from the final event) so tool-result submissions use the correct id. Parallel
 * calls to the same tool (e.g. 5 x create_item) are matched by position (FIFO) via a per-name
 * consumption index.
 */
public final class LroIdRemap {

    private LroIdRemap() {
    }

    /**
     * Builds the {@code clientId -> persistedId} mapping from the function-call parts of a
     * non-partial event.
     *
     * @param parts                the event's content parts, in order
     * @param emittedIdsByName     emitted (client-facing) ids grouped by tool name, in emitted order
     * @return the remap (client-facing id to ADK-persisted id); empty when none differ
     */
    public static Map<String, String> extract(List<Part> parts,
                                              Map<String, List<String>> emittedIdsByName) {
        Map<String, String> remap = new LinkedHashMap<>();
        Map<String, Integer> consumed = new HashMap<>();
        for (Part part : parts) {
            FunctionCall fc = part.functionCall().orElse(null);
            if (fc == null) {
                continue;
            }
            String finalId = fc.id().orElse(null);
            String fcName = fc.name().orElse(null);
            if (finalId == null || fcName == null) {
                continue;
            }
            List<String> emittedIds = emittedIdsByName.getOrDefault(fcName, List.of());
            int idx = consumed.getOrDefault(fcName, 0);
            if (idx < emittedIds.size()) {
                String emittedId = emittedIds.get(idx);
                consumed.put(fcName, idx + 1);
                if (!emittedId.equals(finalId)) {
                    remap.put(emittedId, finalId);
                }
            }
        }
        return remap;
    }
}
