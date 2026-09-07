package com.agui.adk.a2ui;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** P0 #1 — A2UI {@code render_catalog_instructions} byte-parity with the reference SDK. */
class A2uiCatalogRendererTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static String resource(String path) throws Exception {
        try (InputStream in = A2uiCatalogRendererTest.class.getClassLoader().getResourceAsStream(path)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void renderMatchesReferenceSdkByteForByte() throws Exception {
        Map<String, Object> catalog = JSON.readValue(resource("a2ui/sample_catalog.json"), Map.class);
        String expected = resource("a2ui/render_expected.txt");

        String rendered = A2uiCatalogRenderer.renderCatalogInstructions(catalog, "esig-demo");

        assertThat(rendered).isNotNull();
        assertThat(rendered).isEqualTo(expected);
    }

    @Test
    void renderFromJsonStringMatchesReferenceSdk() throws Exception {
        String catalogJson = resource("a2ui/sample_catalog.json");
        String expected = resource("a2ui/render_expected.txt");

        String rendered = A2uiCatalogRenderer.renderCatalogInstructions(catalogJson, "esig-demo");

        assertThat(rendered).isEqualTo(expected);
    }

    @Test
    void unusableCatalogReturnsNull() {
        assertThat(A2uiCatalogRenderer.renderCatalogInstructions(Map.of(), "esig-demo")).isNull();
        assertThat(A2uiCatalogRenderer.renderCatalogInstructions("not json {", "esig-demo")).isNull();
        assertThat(A2uiCatalogRenderer.renderCatalogInstructions(
                Map.of("components", Map.of()), "esig-demo")).isNull();
    }

    @Test
    void renderCacheReusesComputedInstructionsForIdenticalCatalogs() throws Exception {
        Map<String, Object> catalog = JSON.readValue(resource("a2ui/sample_catalog.json"), Map.class);
        String expected = resource("a2ui/render_expected.txt");
        A2uiCatalogRenderer.clearCache();
        assertThat(A2uiCatalogRenderer.cachedCatalogCount()).isZero();

        String first = A2uiCatalogRenderer.renderCatalogInstructions(catalog, "esig-demo");
        String second = A2uiCatalogRenderer.renderCatalogInstructions(catalog, "esig-demo");

        assertThat(first).isEqualTo(expected);
        assertThat(second).isEqualTo(first);
        assertThat(A2uiCatalogRenderer.cachedCatalogCount()).isEqualTo(1);
        A2uiCatalogRenderer.clearCache();
    }

    @Test
    void renderCacheSeparatesDistinctCatalogsAndDefaultIds() {
        A2uiCatalogRenderer.clearCache();
        Map<String, Object> widget = Map.of("components",
                Map.of("Widget", Map.of("type", "object")));

        assertThat(A2uiCatalogRenderer.renderCatalogInstructions(widget, "demo")).isNotNull();
        assertThat(A2uiCatalogRenderer.cachedCatalogCount()).isEqualTo(1);
        // A different default catalog id normalizes into a different dict -> separate entry.
        assertThat(A2uiCatalogRenderer.renderCatalogInstructions(widget, "other-demo")).isNotNull();
        assertThat(A2uiCatalogRenderer.cachedCatalogCount()).isEqualTo(2);

        Map<String, Object> text = Map.of("components",
                Map.of("Text", Map.of("type", "object", "required", List.of("text"))));
        assertThat(A2uiCatalogRenderer.renderCatalogInstructions(text, "demo")).isNotNull();
        assertThat(A2uiCatalogRenderer.cachedCatalogCount()).isEqualTo(3);
        A2uiCatalogRenderer.clearCache();
    }

    @Test
    void rendersCommonTypesBlockWhenCatalogReferencesCommonTypes() {
        Map<String, Object> catalog = Map.of(
                "components", Map.of(
                        "Widget", Map.of(
                                "type", "object",
                                "properties", Map.of(
                                        "size", Map.of("$ref", "common_types.json#/$defs/DynamicString")))));

        String rendered = A2uiCatalogRenderer.renderCatalogInstructions(catalog, "demo");

        assertThat(rendered).isNotNull();
        assertThat(rendered).contains("### Common Types Schema:");
        assertThat(rendered).contains("\"DynamicString\"");
        assertThat(rendered).startsWith("---BEGIN A2UI JSON SCHEMA---\n\n### Server To Client Schema:");
        assertThat(rendered).endsWith("---END A2UI JSON SCHEMA---");
    }
}
