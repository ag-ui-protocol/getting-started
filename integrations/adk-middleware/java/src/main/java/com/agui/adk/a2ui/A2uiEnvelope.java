package com.agui.adk.a2ui;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Port of the {@code ag-ui-a2ui-toolkit} envelope assemblers used by {@link A2UISubAgentTool}'s
 * run-loop: {@code build_a2ui_envelope} / {@code assemble_ops} (create/update component + data ops
 * wrapped as an {@code a2ui_operations} JSON envelope) and {@code wrap_error_envelope} / the
 * {@code a2ui_recovery_exhausted} envelope.
 *
 * <p>Serialization matches Python's {@code json.dumps} defaults ({@code ", "} / {@code ": "}
 * separators, ASCII-safe escaping) so the emitted envelope text is byte-exact vs the reference
 * toolkit ({@code wrap_as_operations_envelope} / {@code wrap_error_envelope} /
 * {@code _wrap_recovery_exhausted_envelope}).
 */
final class A2uiEnvelope {

    private static final String A2UI_OPERATIONS_KEY = "a2ui_operations";
    private static final String V0_9 = "v0.9";

    private A2uiEnvelope() {
    }

    /**
     * Converts the sub-agent's generated args into the canonical {@code a2ui_operations} envelope JSON
     * string (port of {@code build_a2ui_envelope}). Catalog ownership stays with the host: the
     * sub-agent never picks a catalog, so the id comes from the prior surface (update) or the
     * configured default (create) — never from the model's args.
     *
     * @param args              the generated {@code render_a2ui} args (surfaceId/components/data)
     * @param isUpdate          whether this is an update (skips {@code createSurface})
     * @param targetSurfaceId   the target surface id for an update (may be null)
     * @param prior             the reconstructed prior surface for an update (may be null)
     * @param defaultSurfaceId  fallback surface id when args omit it
     * @param defaultCatalogId  fallback catalog id
     * @return the {@code a2ui_operations} envelope JSON string
     */
    static String build(Map<String, Object> args, boolean isUpdate, String targetSurfaceId,
                        Map<String, Object> prior,
                        String defaultSurfaceId, String defaultCatalogId) {
        String safeSurface = (defaultSurfaceId == null || defaultSurfaceId.isEmpty())
                ? A2UISubAgentTool.DEFAULT_SURFACE_ID : defaultSurfaceId;
        String safeCatalog = (defaultCatalogId == null || defaultCatalogId.isEmpty())
                ? A2UISubAgentTool.DEFAULT_CATALOG_ID : defaultCatalogId;

        // Narrow args["surfaceId"] to a non-empty STRING — the model is untrusted (Python narrow).
        Object rawArgSurface = args.get("surfaceId");
        String argSurface = (rawArgSurface instanceof String s && !s.isEmpty())
                ? s : "";
        String surfaceId = isUpdate
                ? (targetSurfaceId != null && !targetSurfaceId.isEmpty() ? targetSurfaceId : safeSurface)
                : (argSurface.isEmpty() ? safeSurface : argSurface);

        Object rawComponents = args.get("components");
        List<?> components = rawComponents instanceof List<?> l ? l : List.of();
        Object rawData = args.get("data");
        Map<?, ?> data = rawData instanceof Map<?, ?> map ? map : Map.of();

        Object priorCatalogId = prior == null ? null : prior.get("catalogId");
        String catalogId = priorCatalogId instanceof String s && !s.isEmpty()
                ? s : safeCatalog;

        List<Map<String, Object>> ops = new ArrayList<>();
        if (!isUpdate) {
            ops.add(createSurface(surfaceId, catalogId));
        }
        ops.add(updateComponents(surfaceId, components));
        if (!data.isEmpty()) {
            ops.add(updateDataModel(surfaceId, data));
        }

        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put(A2UI_OPERATIONS_KEY, ops);
        return PythonJson.stringifySpaced(envelope);
    }

    /**
     * Builds the {@code a2ui_recovery_exhausted} envelope on attempt-cap exhaustion (port of
     * {@code _wrap_recovery_exhausted_envelope}).
     *
     * @param maxAttempts the attempt cap
     * @param attempts    the per-attempt records
     * @return the exhaustion envelope JSON string
     */
    static String exhausted(int maxAttempts, List<Map<String, Object>> attempts) {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", "Failed to generate valid A2UI after " + maxAttempts + " attempt(s)");
        envelope.put("code", "a2ui_recovery_exhausted");
        envelope.put("attempts", attempts);
        return PythonJson.stringifySpaced(envelope);
    }

    /**
     * Wraps an error message as the {@code {"error": message}} envelope (port of {@code wrap_error_envelope}).
     *
     * @param message the error message
     * @return the error envelope JSON string
     */
    static String error(String message) {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("error", message == null ? "" : message);
        return PythonJson.stringifySpaced(envelope);
    }

    /**
     * @param surfaceId the surface id
     * @param catalogId the catalog id
     * @return a v0.9 {@code createSurface} operation
     */
    private static Map<String, Object> createSurface(String surfaceId, String catalogId) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("surfaceId", surfaceId);
        payload.put("catalogId", catalogId);
        Map<String, Object> op = new LinkedHashMap<>();
        op.put("version", V0_9);
        op.put("createSurface", payload);
        return op;
    }

    /**
     * @param surfaceId  the surface id
     * @param components the component array
     * @return a v0.9 {@code updateComponents} operation
     */
    private static Map<String, Object> updateComponents(String surfaceId, List<?> components) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("surfaceId", surfaceId);
        payload.put("components", components);
        Map<String, Object> op = new LinkedHashMap<>();
        op.put("version", V0_9);
        op.put("updateComponents", payload);
        return op;
    }

    /**
     * @param surfaceId the surface id
     * @param data      the data model
     * @return a v0.9 {@code updateDataModel} operation at path {@code /}
     */
    private static Map<String, Object> updateDataModel(String surfaceId, Map<?, ?> data) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("surfaceId", surfaceId);
        payload.put("path", "/");
        payload.put("value", data);
        Map<String, Object> op = new LinkedHashMap<>();
        op.put("version", V0_9);
        op.put("updateDataModel", payload);
        return op;
    }
}
