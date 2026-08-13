package com.agui.adk.a2ui;

import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * C-02 — A2UI updates must look up the prior surface in conversation history (port of the
 * toolkit's {@code find_prior_surface}): backwards walk over tool messages, forward op application
 * per message, latest-known-state accumulation, and {@code deleteSurface} wipe. Unknown-surface
 * updates surface a dedicated error (proven in {@link A2UISubAgentToolTest}).
 */
class A2uiHistoryTest {

    private static Map<String, Object> op(String kind, Map<String, Object> payload) {
        Map<String, Object> op = new LinkedHashMap<>();
        op.put("version", "v0.9");
        op.put(kind, payload);
        return op;
    }

    private static String envelope(Map<String, Object>... ops) {
        Map<String, Object> env = new LinkedHashMap<>();
        env.put("a2ui_operations", List.of((Object[]) ops));
        return PythonJson.stringifySpaced(env);
    }

    private static ToolMessage toolMessage(String id, String content) {
        return new ToolMessage(id, content, "tool-call-" + id, null);
    }

    private static final String S1 = "surface-1";

    @Test
    void returnsNullWhenNoMessageMentionsTheSurface() {
        List<Message> messages = List.of(toolMessage("m1", envelope(
                op("createSurface", Map.of("surfaceId", "other", "catalogId", "c1")),
                op("updateComponents", Map.of("surfaceId", "other", "components",
                        List.of(Map.of("id", "root")))))));
        assertThat(A2uiHistory.findPriorSurface(messages, S1)).isNull();
    }

    @Test
    void reconstructsLatestSurfaceFromCreateThenUpdateAcrossMessages() {
        ToolMessage create = toolMessage("m1", envelope(
                op("createSurface", Map.of("surfaceId", S1, "catalogId", "cat-a")),
                op("updateComponents", Map.of("surfaceId", S1, "components",
                        List.of(Map.of("id", "root", "component", "Text", "text", "v1"))))));
        ToolMessage update = toolMessage("m2", envelope(
                op("updateComponents", Map.of("surfaceId", S1, "components",
                        List.of(Map.of("id", "root", "component", "Text", "text", "v2"))))));

        Map<String, Object> prior = A2uiHistory.findPriorSurface(List.of(create, update), S1);

        assertThat(prior).isNotNull();
        assertThat(prior.get("catalogId")).isEqualTo("cat-a");
        assertThat(prior.get("components")).isEqualTo(List.of(
                Map.of("id", "root", "component", "Text", "text", "v2")));
        assertThat(prior.get("data")).isNull();
    }

    @Test
    void dataOnlyMessageNoLongerBlanksComponentsOrCatalogId() {
        ToolMessage create = toolMessage("m1", envelope(
                op("createSurface", Map.of("surfaceId", S1, "catalogId", "cat-a")),
                op("updateComponents", Map.of("surfaceId", S1, "components",
                        List.of(Map.of("id", "root"))))));
        ToolMessage dataOnly = toolMessage("m2", envelope(
                op("updateDataModel", Map.of("surfaceId", S1, "path", "/", "value",
                        Map.of("count", 3)))));

        Map<String, Object> prior = A2uiHistory.findPriorSurface(List.of(create, dataOnly), S1);

        assertThat(prior).isNotNull();
        assertThat(prior.get("catalogId")).isEqualTo("cat-a");
        assertThat(prior.get("components")).isEqualTo(List.of(Map.of("id", "root")));
        assertThat(prior.get("data")).isEqualTo(Map.of("count", 3));
    }

    @Test
    void deleteSurfaceWipesTheSurface() {
        ToolMessage create = toolMessage("m1", envelope(
                op("createSurface", Map.of("surfaceId", S1, "catalogId", "cat-a")),
                op("updateComponents", Map.of("surfaceId", S1, "components",
                        List.of(Map.of("id", "root"))))));
        ToolMessage delete = toolMessage("m2", envelope(
                op("deleteSurface", Map.of("surfaceId", S1))));

        assertThat(A2uiHistory.findPriorSurface(List.of(create, delete), S1)).isNull();
    }

    @Test
    void ignoresNonToolMessagesAndUnparseableContent() {
        ToolMessage create = toolMessage("m1", envelope(
                op("createSurface", Map.of("surfaceId", S1, "catalogId", "cat-a")),
                op("updateComponents", Map.of("surfaceId", S1, "components",
                        List.of(Map.of("id", "root"))))));
        ToolMessage garbage = toolMessage("m2", "not json at all");

        Map<String, Object> prior = A2uiHistory.findPriorSurface(List.of(garbage, create), S1);

        assertThat(prior).isNotNull();
        assertThat(prior.get("catalogId")).isEqualTo("cat-a");
    }

    @Test
    void olderDeleteIsOverriddenByNewerStateAndOlderCreateBackfillsCatalogId() {
        ToolMessage create = toolMessage("m1", envelope(
                op("createSurface", Map.of("surfaceId", S1, "catalogId", "cat-a")),
                op("updateComponents", Map.of("surfaceId", S1, "components",
                        List.of(Map.of("id", "root"))))));
        ToolMessage delete = toolMessage("m2", envelope(
                op("deleteSurface", Map.of("surfaceId", S1))));
        ToolMessage recreate = toolMessage("m3", envelope(
                op("updateComponents", Map.of("surfaceId", S1, "components",
                        List.of(Map.of("id", "root", "component", "Text", "text", "v3"))))));

        Map<String, Object> prior = A2uiHistory.findPriorSurface(List.of(create, delete, recreate), S1);

        assertThat(prior).isNotNull();
        assertThat(prior.get("catalogId")).isEqualTo("cat-a");
        assertThat(prior.get("components")).isEqualTo(List.of(
                Map.of("id", "root", "component", "Text", "text", "v3")));
    }
}
