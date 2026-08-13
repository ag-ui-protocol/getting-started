package com.agui.adk.a2ui;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Renders a host-supplied A2UI catalog into the LLM prompt schema block, port of the Python
 * {@code a2ui_google_sdk.py render_catalog_instructions} (OSS-158). It reproduces, byte-exactly,
 * the Google {@code a2ui-agent-sdk}'s render-only path used by the ADK adapter:
 *
 * <ol>
 *   <li>normalize the catalog ({@link A2uiCatalogNormalizer});</li>
 *   <li>load the bundled v0.9 server-to-client and common-types schema assets and strip strict
 *       validation ({@code remove_strict_validation});</li>
 *   <li>prune the server-to-client {@code $defs} to the allowed server-to-client messages by
 *       reachability ({@code with_pruning});</li>
 *   <li>prune common types to those still referenced across catalog + server-to-client;</li>
 *   <li>serialize the three compact JSON blocks into the
 *       {@code ---BEGIN A2UI JSON SCHEMA---}…{@code ---END A2UI JSON SCHEMA---} prompt block.</li>
 * </ol>
 *
 * <p>Render-only: it never resolves catalog-internal {@code $ref}s, tolerating the client's
 * zod-extracted catalog. Returns {@code null} (best-effort) when the catalog cannot be normalized,
 * matching the Python caller's fallback to the raw catalog text.
 */
public final class A2uiCatalogRenderer {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ObjectMapper SORTED_JSON = new ObjectMapper()
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
    private static final String VERSION_0_9 = "0.9";
    private static final String BLOCK_START = "---BEGIN A2UI JSON SCHEMA---";
    private static final String BLOCK_END = "---END A2UI JSON SCHEMA---";
    private static final List<String> ALLOWED_MESSAGES = List.of(
            "CreateSurfaceMessage", "UpdateComponentsMessage", "UpdateDataModelMessage");
    private static final String INTERNAL_REF_PREFIX = "#/$defs/";
    private static final String COMMON_TYPES_REF_MARKER = "common_types.json#/$defs/";

    /**
     * Memoized rendered instructions keyed by the sorted-key JSON of the normalized catalog
     * (Python {@code _RENDER_CACHE} keyed by {@code json.dumps(normalized, sort_keys=True)}): the
     * same client catalog recurs across every run, and rendering is non-trivial (asset load +
     * reachability pruning), so the cost is paid once per distinct catalog.
     */
    private static final Map<String, String> RENDER_CACHE = new ConcurrentHashMap<>();

    private A2uiCatalogRenderer() { }

    /**
     * Renders a host-supplied catalog into the LLM prompt schema block, or {@code null} when the
     * catalog cannot be normalized/built (the caller then falls back to the raw catalog text).
     * Results (including failures) are memoized per normalized catalog, matching Python.
     *
     * @param source catalog dict, JSON string, or legacy component list
     * @param defaultCatalogId fallback catalog id
     * @return rendered instruction block, or {@code null}
     */
    public static String renderCatalogInstructions(Object source, String defaultCatalogId) {
        Map<String, Object> normalized = A2uiCatalogNormalizer.normalizeCatalogDict(source, defaultCatalogId);
        if (normalized == null) {
            return null;
        }
        String cacheKey = cacheKey(normalized);
        String cached = cacheKey == null ? null : RENDER_CACHE.get(cacheKey);
        if (cached != null) {
            // Empty-string entries memoize a previous render failure (Python caches None).
            return cached.isEmpty() ? null : cached;
        }
        try {
            Map<String, Object> s2c = cast(removeStrictValidation(loadAsset("server_to_client.json")));
            Map<String, Object> common = cast(removeStrictValidation(loadAsset("common_types.json")));
            Map<String, Object> catalog = cast(removeStrictValidation(normalized));

            s2c = pruneMessages(s2c, ALLOWED_MESSAGES);
            common = pruneCommonTypes(common, catalog, s2c);

            List<String> parts = new ArrayList<>();
            parts.add(BLOCK_START);
            parts.add("### Server To Client Schema:\n" + PythonJson.stringify(s2c));
            if (hasDefs(common)) {
                parts.add("### Common Types Schema:\n" + PythonJson.stringify(common));
            }
            parts.add("### Catalog Schema:\n" + PythonJson.stringify(catalog));
            parts.add(BLOCK_END);
            String instructions = String.join("\n\n", parts);
            if (cacheKey != null) {
                RENDER_CACHE.put(cacheKey, instructions);
            }
            return instructions;
        } catch (Exception e) {
            // Render is best-effort; degrade to the raw catalog text (Python caller behavior).
            if (cacheKey != null) {
                RENDER_CACHE.put(cacheKey, "");
            }
            return null;
        }
    }

    /**
     * Canonical cache key for a normalized catalog (sorted-key JSON — Python
     * {@code json.dumps(normalized, sort_keys=True)}). {@code null} when the catalog cannot be
     * serialized (never happens for normalized shapes).
     *
     * @param normalized the normalized catalog
     * @return the cache key, or {@code null}
     */
    private static String cacheKey(Map<String, Object> normalized) {
        try {
            return SORTED_JSON.writeValueAsString(normalized);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Number of distinct catalogs currently memoized (test seam for cache behavior).
     *
     * @return the cache size
     */
    static int cachedCatalogCount() {
        return RENDER_CACHE.size();
    }

    /**
     * Clears the render cache (test seam).
     */
    static void clearCache() {
        RENDER_CACHE.clear();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Object value) {
        return (Map<String, Object>) value;
    }

    /**
     * Whether the schema carries a non-empty {@code $defs} block.
     *
     * @param schema the schema (may be null)
     * @return true when {@code $defs} is a non-empty map
     */
    private static boolean hasDefs(Map<String, Object> schema) {
        if (schema == null) {
            return false;
        }
        Object defs = schema.get("$defs");
        return defs instanceof Map<?, ?> nonEmpty && !nonEmpty.isEmpty();
    }

    /**
     * v0.9 server-to-client message pruning: filter {@code oneOf} to the allowed message roots and
     * prune {@code $defs} to those reached from the allowed roots (SDK {@code A2uiCatalog
     * ._with_pruned_messages}, 0.9+ branch).
     *
     * @param s2c the server-to-client message schema
     * @param allowed the allowed message root names
     * @return the pruned server-to-client schema
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> pruneMessages(Map<String, Object> s2c, List<String> allowed) {
        Object oneOf = s2c.get("oneOf");
        if (oneOf instanceof List<?> list) {
            List<Object> kept = new ArrayList<>();
            for (Object item : list) {
                if (item instanceof Map<?, ?> m && m.get("$ref") instanceof String ref
                        && ref.startsWith(INTERNAL_REF_PREFIX)
                        && allowed.contains(ref.substring(INTERNAL_REF_PREFIX.length()))) {
                    kept.add(item);
                }
            }
            s2c.put("oneOf", kept);
        }
        Object defs = s2c.get("$defs");
        if (defs instanceof Map<?, ?> map) {
            s2c.put("$defs", pruneDefsByReachability((Map<String, Object>) map, allowed));
        }
        return s2c;
    }

    /**
     * Prunes common-types definitions not reachable from a message root.
     *
     * @param common the common-types definitions map
     * @param catalog the full catalog (to collect reachable refs)
     * @param s2c the server-to-client message schema (to collect reachable refs)
     * @return the pruned common-types map
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> pruneCommonTypes(
            Map<String, Object> common, Map<String, Object> catalog, Map<String, Object> s2c) {
        if (common == null || !(common.get("$defs") instanceof Map<?, ?>)) {
            return common;
        }
        Set<String> refs = new LinkedHashSet<>();
        refs.addAll(collectRefs(catalog));
        refs.addAll(collectRefs(s2c));
        List<String> roots = new ArrayList<>();
        for (String ref : refs) {
            if (ref.contains(COMMON_TYPES_REF_MARKER)) {
                roots.add(ref.substring(ref.indexOf(COMMON_TYPES_REF_MARKER) + COMMON_TYPES_REF_MARKER.length()));
            }
        }
        Map<String, Object> pruned = new LinkedHashMap<>(common);
        pruned.put("$defs", pruneDefsByReachability((Map<String, Object>) common.get("$defs"), roots));
        return pruned;
    }

    /**
     * BFS over {@code $ref}s to keep only definitions reachable from the roots (SDK
     * {@code _prune_defs_by_reachability}), preserving original definition order.
     *
     * @param defs the definitions map
     * @param roots the root schema names to reach from
     * @return the pruned definitions map
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> pruneDefsByReachability(Map<String, Object> defs, List<String> roots) {
        Set<String> visited = new HashSet<>();
        List<String> queue = new ArrayList<>(roots);
        while (!queue.isEmpty()) {
            String name = queue.remove(0);
            if (defs.containsKey(name) && !visited.contains(name)) {
                visited.add(name);
                Object def = defs.get(name);
                for (String ref : collectRefs(def)) {
                    if (ref.startsWith(INTERNAL_REF_PREFIX)) {
                        queue.add(ref.substring(INTERNAL_REF_PREFIX.length()));
                    }
                }
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : defs.entrySet()) {
            if (visited.contains(e.getKey())) {
                out.put(e.getKey(), e.getValue());
            }
        }
        return out;
    }

    /**
     * Recursively collects all {@code $ref} string values (SDK {@code _collect_refs}).
     *
     * @param obj value to scan
     * @return set of referenced strings
     */
    @SuppressWarnings("unchecked")
    private static Set<String> collectRefs(Object obj) {
        return collectRefs(obj, new HashSet<>());
    }

    /**
     * Collects {@code $ref} target names reachable from an object, mutating {@code refs}.
     *
     * @param obj the object to walk
     * @param refs the accumulator set
     * @return the accumulated refs
     */
    private static Set<String> collectRefs(Object obj, Set<String> refs) {
        if (obj instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if ("$ref".equals(e.getKey()) && e.getValue() instanceof String s) {
                    refs.add(s);
                } else {
                    collectRefs(e.getValue(), refs);
                }
            }
        } else if (obj instanceof Iterable<?> it) {
            for (Object item : it) {
                collectRefs(item, refs);
            }
        }
        return refs;
    }

    /**
     * Deep-transform removing {@code additionalProperties:false} and
     * {@code unevaluatedProperties:false} (SDK {@code remove_strict_validation} modifier).
     *
     * @param value value to transform
     * @return transformed value
     */
    @SuppressWarnings("unchecked")
    private static Object removeStrictValidation(Object value) {
        if (value instanceof Map<?, ?> m) {
            LinkedHashMap<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : m.entrySet()) {
                out.put(String.valueOf(e.getKey()), removeStrictValidation(e.getValue()));
            }
            if (Boolean.FALSE.equals(out.get("additionalProperties"))) {
                out.remove("additionalProperties");
            }
            if (Boolean.FALSE.equals(out.get("unevaluatedProperties"))) {
                out.remove("unevaluatedProperties");
            }
            return out;
        }
        if (value instanceof Iterable<?> it) {
            List<Object> out = new ArrayList<>();
            for (Object item : it) {
                out.add(removeStrictValidation(item));
            }
            return out;
        }
        return value;
    }

    /**
     * Loads a bundled asset catalog component by name.
     *
     * @param name the asset component name
     * @return the loaded component map
     * @throws Exception when the asset cannot be loaded
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> loadAsset(String name) throws Exception {
        String resource = "a2ui/assets/v0_9/" + name;
        try (InputStream in = A2uiCatalogRenderer.class.getClassLoader().getResourceAsStream(resource)) {
            if (in == null) {
                throw new IllegalStateException("missing A2UI asset resource: " + resource);
            }
            Object parsed = JSON.readValue(in, Object.class);
            return (Map<String, Object>) parsed;
        }
    }
}
