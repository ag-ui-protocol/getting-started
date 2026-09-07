package com.agui.adk.serialization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;

class ToolCallSerializationTest {

    @Test
    void serializesMapArgsToCompactJsonPreservingKeyOrder() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("city", "Paris");
        args.put("n", 3);
        args.put("tags", java.util.List.of("a", "b"));
        assertThat(ToolCallSerialization.serializeToolArgs(args))
                .isEqualTo("{\"city\":\"Paris\",\"n\":3,\"tags\":[\"a\",\"b\"]}");
    }

    @Test
    void propagatesMapSerializationFailuresInsteadOfSilentlyUsingEmptyArgs() {
        Map<String, Object> cyclic = new LinkedHashMap<>();
        cyclic.put("self", cyclic);

        assertThatThrownBy(() -> ToolCallSerialization.serializeToolArgs(cyclic))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Failed to serialize tool-call arguments");
    }

    @Test
    void stringifiesNonMapValuesLikePythonStr() {
        assertThat(ToolCallSerialization.serializeToolArgs("plain")).isEqualTo("plain");
        assertThat(ToolCallSerialization.serializeToolArgs(Integer.valueOf(42))).isEqualTo("42");
        assertThat(ToolCallSerialization.serializeToolArgs(null)).isEqualTo("null");
    }
}
