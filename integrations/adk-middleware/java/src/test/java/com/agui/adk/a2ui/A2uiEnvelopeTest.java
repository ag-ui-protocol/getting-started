package com.agui.adk.a2ui;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * m-07 — the A2UI envelope text must be byte-exact vs the Python reference {@code json.dumps}
 * (default {@code ", "} / {@code ": "} separators, ASCII escaping). Every expected string below
 * was produced by the canonical toolkit's {@code build_a2ui_envelope} /
 * {@code wrap_error_envelope} for the same inputs.
 */
class A2uiEnvelopeTest {

    @Test
    void createEnvelopeMatchesPythonBuildA2uiEnvelopeByteForByte() {
        Map<String, Object> component = new LinkedHashMap<>();
        component.put("id", "c1");
        component.put("component", "Text");
        component.put("text", "Hi");
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("surfaceId", "s1");
        args.put("components", List.of(component));
        args.put("data", Map.of("k", 1));

        String envelope = A2uiEnvelope.build(args, false, null, null,
                "dynamic-surface", "catalog");

        assertThat(envelope).isEqualTo(
                "{\"a2ui_operations\": [{\"version\": \"v0.9\", \"createSurface\": "
                        + "{\"surfaceId\": \"s1\", \"catalogId\": \"catalog\"}}, "
                        + "{\"version\": \"v0.9\", \"updateComponents\": {\"surfaceId\": \"s1\", "
                        + "\"components\": [{\"id\": \"c1\", \"component\": \"Text\", \"text\": \"Hi\"}]}}, "
                        + "{\"version\": \"v0.9\", \"updateDataModel\": {\"surfaceId\": \"s1\", "
                        + "\"path\": \"/\", \"value\": {\"k\": 1}}}]}");
    }

    @Test
    void updateEnvelopeSkipsCreateSurfaceAndReusesPriorCatalogId() {
        Map<String, Object> component = new LinkedHashMap<>();
        component.put("id", "c1");
        component.put("component", "Text");
        component.put("text", "Bye");
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("components", List.of(component));
        args.put("data", Map.of());

        String envelope = A2uiEnvelope.build(args, true, "s1",
                Map.of("catalogId", "prior-cat"), "dynamic-surface", "catalog");

        assertThat(envelope).isEqualTo(
                "{\"a2ui_operations\": [{\"version\": \"v0.9\", \"updateComponents\": "
                        + "{\"surfaceId\": \"s1\", \"components\": "
                        + "[{\"id\": \"c1\", \"component\": \"Text\", \"text\": \"Bye\"}]}}]}");
    }

    @Test
    void errorEnvelopeMatchesPythonWrapErrorEnvelopeByteForByte() {
        String message = "intent='update' requested target_surface_id='s1' "
                + "but no prior render of that surface was found in conversation history";

        String envelope = A2uiEnvelope.error(message);

        assertThat(envelope).isEqualTo(
                "{\"error\": \"intent='update' requested target_surface_id='s1' "
                        + "but no prior render of that surface was found in conversation history\"}");
    }

    @Test
    void exhaustedEnvelopeMatchesPythonRecoveryEnvelope() {
        String envelope = A2uiEnvelope.exhausted(3, List.of());
        assertThat(envelope).isEqualTo(
                "{\"error\": \"Failed to generate valid A2UI after 3 attempt(s)\", "
                        + "\"code\": \"a2ui_recovery_exhausted\", \"attempts\": []}");
    }

    @Test
    void escapedAsciiMatchesPythonEnsureAscii() {
        // Unicode must be escaped like Python json.dumps(ensure_ascii=True) (backslash-u hex).
        Map<String, Object> component = new LinkedHashMap<>();
        component.put("id", "root");
        component.put("component", "Text");
        component.put("text", "héllo — ✓");
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("components", List.of(component));
        String envelope = A2uiEnvelope.build(args, false, null, null, "dynamic-surface", "catalog");
        assertThat(envelope).doesNotContain("é", "—", "✓");
        String backslash = "\\";
        assertThat(envelope).contains(backslash + "u00e9", backslash + "u2014", backslash + "u2713");
    }
}
