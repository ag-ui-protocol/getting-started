package com.agui.adk.history;

import static org.assertj.core.api.Assertions.assertThat;

import com.google.genai.types.FunctionResponse;
import com.google.genai.types.Part;
import com.agui.community.core.message.ToolMessage;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

class ToolResultResponseBuilderTest {

    private static ToolResultExtractor.ToolResult tr(String callId, String name, String content) {
        return new ToolResultExtractor.ToolResult(name, new ToolMessage("id-"+callId, content, callId, null));
    }

    @Test
    void parsesJsonContentAppliesRemapAndNames() {
        var parts = ToolResultResponseBuilder.buildFunctionResponseParts(
                List.of(tr("client-a", "create_item", "{\"ok\":true}")),
                Map.of("client-a", "persisted-a"));
        assertThat(parts).hasSize(1);
        FunctionResponse fr = parts.get(0).functionResponse().orElseThrow();
        assertThat(fr.id().orElse("")).isEqualTo("persisted-a"); // LRO remap applied
        assertThat(fr.name().orElse("")).isEqualTo("create_item");
        assertThat(fr.response().orElseThrow()).containsEntry("ok", true);
    }

    @Test
    void wrapsPlainStringAndEmptyContent() {
        var parts = ToolResultResponseBuilder.buildFunctionResponseParts(
                List.of(tr("c1", "t", "just text"), tr("c2", "t", "")),
                Map.of());
        assertThat(parts).hasSize(2);
        FunctionResponse plain = parts.get(0).functionResponse().orElseThrow();
        assertThat(plain.response().orElseThrow()).containsEntry("success", true)
                .containsEntry("result", "just text").containsEntry("status", "completed");
        FunctionResponse empty = parts.get(1).functionResponse().orElseThrow();
        assertThat(empty.response().orElseThrow()).containsEntry("result", null);
    }
}
