package com.agui.adk.input;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RunStateSupportTest {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void acceptsMapAndJsonObjectState() {
        assertThat(RunStateSupport.asMap(Map.of("client", "value")))
                .containsEntry("client", "value");
        assertThat(RunStateSupport.asMap(mapper.createObjectNode().put("client", "value")))
                .containsEntry("client", "value");
        assertThat(RunStateSupport.asMap(null)).isEmpty();
    }

    @Test
    void rejectsNonObjectStateAndNonStringKeys() {
        assertThatThrownBy(() -> RunStateSupport.asMap(List.of("value")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("JSON object");
        Map<Object, Object> keyed = new LinkedHashMap<>();
        keyed.put(1, "value");
        assertThatThrownBy(() -> RunStateSupport.asMap(keyed))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("string keys");
        assertThatThrownBy(() -> RunStateSupport.asMap(Map.of("_ag_ui_user_id", "spoofed")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("protected key");
    }
}
