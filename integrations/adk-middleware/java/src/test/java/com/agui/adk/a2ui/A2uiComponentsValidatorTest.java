package com.agui.adk.a2ui;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * C-01 — the Java A2UI run-loop must reject invalid component payloads instead of committing them.
 * Byte-for-byte port of the toolkit's {@code validate_a2ui_components} (the SEMANTIC_VALIDATOR
 * behind {@code A2UISubAgentTool}'s recovery loop): structural checks always run, catalog
 * membership + required props run when a catalog is supplied, absolute binding paths resolve
 * against the data model, and the child-reference tree must be a DAG with a {@code root}.
 */
class A2uiComponentsValidatorTest {

    private static final Map<String, Object> CATALOG = Map.of("components", Map.of(
            "Text", Map.of("type", "object", "required", List.of("text")),
            "Column", Map.of("type", "object", "required", List.of("children")),
            "List", Map.of("type", "object", "properties", Map.of("children", Map.of(
                    "type", "array", "items", Map.of("$ref", "#/components/List"))))));

    private static Map<String, Object> comp(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    private static List<Map<String, Object>> single(Object... kv) {
        return List.of(comp(kv));
    }

    private static A2uiComponentsValidator.Verdict validate(Object components) {
        return A2uiComponentsValidator.validate(components, null, null);
    }

    @Test
    void rejectsEmptyAndNonListComponents() {
        A2uiComponentsValidator.Verdict empty = validate(List.of());
        assertThat(empty.valid()).isFalse();
        assertThat(empty.errors()).extracting(A2uiComponentsValidator.Error::code)
                .containsExactly("empty_components");

        A2uiComponentsValidator.Verdict nonList = validate(Map.of("not", "a list"));
        assertThat(nonList.valid()).isFalse();
        assertThat(nonList.errors()).extracting(A2uiComponentsValidator.Error::code)
                .containsExactly("empty_components");
    }

    @Test
    void rejectsMissingIdAndMissingComponentType() {
        A2uiComponentsValidator.Verdict missingId = validate(
                single("component", "Text", "text", "hi"));
        assertThat(missingId.valid()).isFalse();
        assertThat(missingId.errors()).extracting(A2uiComponentsValidator.Error::code)
                .contains("missing_id");

        A2uiComponentsValidator.Verdict missingType = validate(
                single("id", "root", "text", "hi"));
        assertThat(missingType.valid()).isFalse();
        assertThat(missingType.errors()).extracting(A2uiComponentsValidator.Error::code)
                .contains("missing_component_type");
    }

    @Test
    void rejectsDuplicateIds() {
        A2uiComponentsValidator.Verdict dup = validate(List.of(
                comp("id", "root", "component", "Text", "text", "a"),
                comp("id", "root", "component", "Text", "text", "b")));
        assertThat(dup.valid()).isFalse();
        assertThat(dup.errors()).extracting(A2uiComponentsValidator.Error::code)
                .contains("duplicate_id");
    }

    @Test
    void rejectsComponentTypesAbsentFromTheCatalog() {
        A2uiComponentsValidator.Verdict unknown = A2uiComponentsValidator.validate(
                single("id", "root", "component", "Widget", "text", "hi"), null, CATALOG);
        assertThat(unknown.valid()).isFalse();
        assertThat(unknown.errors()).extracting(A2uiComponentsValidator.Error::code)
                .contains("unknown_component");
        assertThat(unknown.errors()).extracting(A2uiComponentsValidator.Error::message)
                .anyMatch(m -> m.contains("'Widget' is not in the catalog"));
    }

    @Test
    void catalogMemberMissingRequiredPropIsRejected() {
        A2uiComponentsValidator.Verdict missingProp = A2uiComponentsValidator.validate(
                single("id", "root", "component", "Text"), null, CATALOG);
        assertThat(missingProp.valid()).isFalse();
        assertThat(missingProp.errors()).extracting(A2uiComponentsValidator.Error::code)
                .contains("missing_required_prop");
        assertThat(missingProp.errors()).extracting(A2uiComponentsValidator.Error::path)
                .anyMatch(p -> p.endsWith(".text"));
    }

    @Test
    void rejectsUnresolvedChildReference() {
        List<Map<String, Object>> components = List.of(
                comp("id", "root", "component", "Column", "children", List.of(
                        comp("componentId", "ghost"))));
        A2uiComponentsValidator.Verdict verdict = A2uiComponentsValidator.validate(
                components, null, CATALOG);
        assertThat(verdict.valid()).isFalse();
        assertThat(verdict.errors()).extracting(A2uiComponentsValidator.Error::code)
                .contains("unresolved_child");
    }

    @Test
    void rejectsChildReferenceCycle() {
        List<Map<String, Object>> components = List.of(
                comp("id", "root", "component", "List", "children", List.of(
                        comp("componentId", "a"))),
                comp("id", "a", "component", "List", "children", List.of(
                        comp("componentId", "root"))));
        A2uiComponentsValidator.Verdict verdict = A2uiComponentsValidator.validate(
                components, null, CATALOG);
        assertThat(verdict.valid()).isFalse();
        assertThat(verdict.errors()).extracting(A2uiComponentsValidator.Error::code)
                .contains("child_cycle");
    }

    @Test
    void rejectsAbsoluteBindingPathMissingFromData() {
        List<Map<String, Object>> components = List.of(
                comp("id", "root", "component", "Text", "text", "bound", "path", "/missing/path"));
        A2uiComponentsValidator.Verdict verdict = A2uiComponentsValidator.validate(
                components, Map.of("present", true), null);
        assertThat(verdict.valid()).isFalse();
        assertThat(verdict.errors()).extracting(A2uiComponentsValidator.Error::code)
                .contains("unresolved_binding");
    }

    @Test
    void bindingCheckCanBeDisabled() {
        List<Map<String, Object>> components = List.of(
                comp("id", "root", "component", "Text", "text", "bound", "path", "/missing/path"));
        A2uiComponentsValidator.Verdict verdict = A2uiComponentsValidator.validate(
                components, Map.of(), null, false);
        assertThat(verdict.errors()).extracting(A2uiComponentsValidator.Error::code)
                .doesNotContain("unresolved_binding");
    }

    @Test
    void requiresARootComponent() {
        A2uiComponentsValidator.Verdict noRoot = validate(
                single("id", "not-root", "component", "Text", "text", "hi"));
        assertThat(noRoot.valid()).isFalse();
        assertThat(noRoot.errors()).extracting(A2uiComponentsValidator.Error::code)
                .contains("no_root");
    }

    @Test
    void acceptsValidSurfaceStructurally() {
        A2uiComponentsValidator.Verdict verdict = validate(
                single("id", "root", "component", "Text", "text", "Hi"));
        assertThat(verdict.valid()).isTrue();
        assertThat(verdict.errors()).isEmpty();
    }

    @Test
    void acceptsValidSurfaceAgainstCatalog() {
        A2uiComponentsValidator.Verdict verdict = A2uiComponentsValidator.validate(
                single("id", "root", "component", "Text", "text", "Hi"), null, CATALOG);
        assertThat(verdict.valid()).isTrue();
    }

    @Test
    void structuralOnlyValidationIgnoresCatalogMembership() {
        // Without a catalog, "Widget" is structurally fine (Text-like).
        A2uiComponentsValidator.Verdict verdict = validate(
                single("id", "root", "component", "Widget", "text", "hi"));
        assertThat(verdict.valid()).isTrue();
    }

    @Test
    void errorMapsExposeCodePathMessageTriples() {
        A2uiComponentsValidator.Verdict verdict = validate(List.of());
        List<Map<String, String>> maps = verdict.errorMaps();
        assertThat(maps).hasSize(1);
        assertThat(maps.get(0)).containsEntry("code", "empty_components")
                .containsEntry("path", "components");
        assertThat(maps.get(0).get("message")).contains("non-empty array");
    }
}
