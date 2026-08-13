package com.agui.adk.a2ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * P0 #1 (SDK-independent subset) — {@code normalize_catalog_dict} from
 * {@code a2ui_google_sdk.py} (oss-158): coerces a dict / JSON string / legacy component list into
 * the inline v0.9 catalog shape {@code {"catalogId", "components"}}, with the default catalog id
 * fallback and {@code $schema} default.
 */
class A2uiCatalogNormalizerTest {

    private static final String SCHEMA = "https://json-schema.org/draft/2020-12/schema";

    @Test
    void dictWithCatalogIdIsPassedThroughWithDefaultSchema() {
        Map<String, Object> source = Map.of("components", Map.of("Button", Map.of("type", "object")),
                "catalogId", "cat-1");
        Map<String, Object> out = A2uiCatalogNormalizer.normalizeCatalogDict(source, "fallback");

        assertEquals("cat-1", out.get("catalogId"));
        assertEquals(SCHEMA, out.get("$schema"));
        assertTrue(out.get("components") instanceof Map);
        assertEquals(1, ((Map<?, ?>) out.get("components")).size());
    }

    @Test
    void dictWithoutCatalogIdUsesDefault() {
        Map<String, Object> source = Map.of("components", Map.of("Button", Map.of("type", "object")));
        Map<String, Object> out = A2uiCatalogNormalizer.normalizeCatalogDict(source, "default-id");
        assertEquals("default-id", out.get("catalogId"));
    }

    @Test
    void dictWithEmptyCatalogIdUsesDefault() {
        // Python: source.get("catalogId") or default_catalog_id  (empty string is falsy)
        Map<String, Object> source = Map.of("components", Map.of("Button", Map.of()),
                "catalogId", "");
        Map<String, Object> out = A2uiCatalogNormalizer.normalizeCatalogDict(source, "default-id");
        assertEquals("default-id", out.get("catalogId"));
    }

    @Test
    void dictWithEmptyComponentsReturnsNull() {
        Map<String, Object> source = Map.of("components", Map.of());
        assertNull(A2uiCatalogNormalizer.normalizeCatalogDict(source, "x"));
    }

    @Test
    void dictMissingComponentsReturnsNull() {
        assertNull(A2uiCatalogNormalizer.normalizeCatalogDict(Map.of("catalogId", "c"), "x"));
    }

    @Test
    void dictWithNoCatalogIdAndNoDefaultReturnsNull() {
        Map<String, Object> source = Map.of("components", Map.of("Button", Map.of()));
        assertNull(A2uiCatalogNormalizer.normalizeCatalogDict(source, null));
    }

    @Test
    void jsonStringOfDictIsNormalized() {
        String json = "{\"components\":{\"Button\":{\"type\":\"object\"}}}";
        Map<String, Object> out = A2uiCatalogNormalizer.normalizeCatalogDict(json, "from-string");
        assertEquals("from-string", out.get("catalogId"));
        assertTrue(out.get("components") instanceof Map);
    }

    @Test
    void legacyComponentListUsesPropertiesAndDefaultId() {
        List<Map<String, Object>> source = List.of(
                Map.of("name", "Button", "properties", Map.of("type", "object")),
                Map.of("name", "Card", "props", Map.of("type", "object")));
        Map<String, Object> out = A2uiCatalogNormalizer.normalizeCatalogDict(source, "list-id");

        assertEquals("list-id", out.get("catalogId"));
        assertEquals(SCHEMA, out.get("$schema"));
        Map<?, ?> components = (Map<?, ?>) out.get("components");
        assertEquals(2, components.size());
        assertTrue(components.containsKey("Button"));
        assertTrue(components.containsKey("Card"));
        assertEquals(Map.of("type", "object"), components.get("Button"));
    }

    @Test
    void legacyComponentListSkipsInvalidItems() {
        List<Object> source = List.of(Map.of("name", "Ok"), // no properties -> empty comp
                Map.of("no-name", "x"),                      // no name -> skipped
                "not-a-map");
        Map<String, Object> out = A2uiCatalogNormalizer.normalizeCatalogDict(source, "list-id");

        Map<?, ?> components = (Map<?, ?>) out.get("components");
        // "Ok" kept with empty component dict; the other two skipped.
        assertEquals(1, components.size());
        assertEquals(Map.of(), components.get("Ok"));
    }

    @Test
    void legacyComponentListEmptyWithoutDefaultReturnsNull() {
        assertNull(A2uiCatalogNormalizer.normalizeCatalogDict(List.of(), null));
    }

    @Test
    void unparseableStringReturnsNull() {
        assertNull(A2uiCatalogNormalizer.normalizeCatalogDict("not json at all", "x"));
    }

    @Test
    void unusablePrimitiveReturnsNull() {
        assertNull(A2uiCatalogNormalizer.normalizeCatalogDict(42, "x"));
        assertNull(A2uiCatalogNormalizer.normalizeCatalogDict(null, "x"));
    }
}
