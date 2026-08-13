package com.agui.adk.a2ui;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Coerces a host-supplied A2UI catalog into the inline v0.9 catalog dict shape
 * {@code {"catalogId": String, "components": {name: json-schema}}}.
 *
 * <p>Port of the {@code normalize_catalog_dict} function from the Python bridge's
 * {@code a2ui_google_sdk.py} (OSS-158). Accepts a dict carrying {@code components}; a JSON string of
 * one; or the legacy middleware {@code A2UIComponentSchema[]} list {@code [{name, props/properties}]}.
 * {@code catalogId} is filled from {@code defaultCatalogId} when absent. Returns {@code null} for
 * anything unusable (empty components, wrong types, unparseable string).
 */
public final class A2uiCatalogNormalizer {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DEFAULT_JSON_SCHEMA = "https://json-schema.org/draft/2020-12/schema";

    private A2uiCatalogNormalizer() { }

    /**
     * Normalizes a source catalog into the inline v0.9 catalog shape, or {@code null} if unusable.
     *
     * @param source dict, JSON string, or component list
     * @param defaultCatalogId fallback catalog id when the source omits it
     * @return normalized catalog dict, or {@code null}
     */
    public static Map<String, Object> normalizeCatalogDict(Object source, String defaultCatalogId) {
        Object resolved = source;
        if (source instanceof String s) {
            try {
                resolved = JSON.readValue(s, Object.class);
            } catch (Exception e) {
                return null;
            }
        }

        if (resolved instanceof Map<?, ?> dict) {
            Object components = dict.get("components");
            if (!(components instanceof Map<?, ?> comps) || comps.isEmpty()) {
                return null;
            }
            Object rawId = dict.get("catalogId");
            String catalogId = asFalsy(rawId) ? defaultCatalogId : String.valueOf(rawId);
            if (catalogId == null || catalogId.isEmpty()) {
                return null;
            }
            Map<String, Object> out = new LinkedHashMap<>();
            dict.forEach((k, v) -> out.put(String.valueOf(k), v));
            out.put("catalogId", catalogId);
            out.putIfAbsent("$schema", DEFAULT_JSON_SCHEMA);
            return out;
        }

        if (resolved instanceof Iterable<?> list) {
            Map<String, Object> components = new LinkedHashMap<>();
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> itemMap)) {
                    continue;
                }
                Object name = itemMap.get("name");
                if (!(name instanceof String n) || n.isEmpty()) {
                    continue;
                }
                Object rawComp = itemMap.get("properties");
                if (rawComp == null) {
                    rawComp = itemMap.get("props");
                }
                Object comp = (rawComp == null) ? Map.of() : rawComp;
                components.put(n, (comp instanceof Map<?, ?>) ? comp : Map.of());
            }
            if (components.isEmpty() || defaultCatalogId == null || defaultCatalogId.isEmpty()) {
                return null;
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("$schema", DEFAULT_JSON_SCHEMA);
            out.put("catalogId", defaultCatalogId);
            out.put("components", components);
            return out;
        }

        return null;
    }

    /**
     * Python-style falsiness for the {@code or} fallback: {@code None}, empty string, or {@code false}.
     *
     * @param value candidate value
     * @return whether the value is Python-falsy
     */
    private static boolean asFalsy(Object value) {
        if (value == null) {
            return true;
        }
        if (value instanceof String s) {
            return s.isEmpty();
        }
        if (value instanceof Boolean b) {
            return !b;
        }
        return false;
    }
}
