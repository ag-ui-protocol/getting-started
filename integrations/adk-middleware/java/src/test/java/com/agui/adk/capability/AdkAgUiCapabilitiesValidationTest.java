package com.agui.adk.capability;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * P1 #17 — get_capabilities JSON-serializability validation, ported from the Python bridge's
 * {@code ADKAgent.__init__} guard (L311-317): a non-null capabilities dict must be
 * JSON-serializable or a stable error is raised; null is allowed (no capabilities configured).
 */
class AdkAgUiCapabilitiesValidationTest {

    @Test
    void nullCapabilitiesAreAllowed() {
        // Python: `if capabilities is not None:` — null means "not configured".
        assertThatCode(() -> AdkAgUiCapabilities.validate(null)).doesNotThrowAnyException();
    }

    @Test
    void jsonSafeCapabilitiesPass() {
        Map<String, Object> caps = new HashMap<>();
        caps.put("custom", Map.of(
                "agUiAdkJava", Map.of(
                        "authRequest", false,
                        "completeMessageHistory", true,
                        "names", List.of("a", "b"))));
        assertThatCode(() -> AdkAgUiCapabilities.validate(caps)).doesNotThrowAnyException();
    }

    @Test
    void nonSerializableCapabilitiesRaiseStableError() {
        // A self-referencing value cannot be serialized to JSON — mirrors a TypeError/ValueError
        // surfacing from `json.dumps` on the Python side.
        List<Object> cycle = new ArrayList<>();
        cycle.add(cycle); // self-reference -> Jackson throws
        Map<String, Object> caps = new HashMap<>();
        caps.put("bad", cycle);

        assertThatThrownBy(() -> AdkAgUiCapabilities.validate(caps))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("capabilities must be JSON-serializable");
    }
}
