package com.agui.adk.translator;

import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class PredictStateMappingBaselineTest {

    @Test
    void shouldReturnCorrectValues_whenConstructedAndAccessed() {
        // Arrange
        String toolName = "testTool";
        boolean emitConfirm = true;
        Map<String, Object> payload = Map.of("key", "value");

        // Act
        PredictStateMapping mapping = new PredictStateMapping(toolName, emitConfirm, payload);

        // Assert
        assertEquals(toolName, mapping.toolName());
        assertEquals(emitConfirm, mapping.emitConfirmTool());
        assertEquals(payload, mapping.toPayload());
    }

    @Test
    void shouldBeDefensivelyCopied_whenToPayloadIsCalled() {
        // Arrange
        Map<String, Object> originalPayload = new HashMap<>();
        originalPayload.put("initial", "data");

        PredictStateMapping mapping = new PredictStateMapping("toolA", false, originalPayload);

        // Act
        originalPayload.put("new", "data"); // Modify the original map
        Map<String, Object> retrievedPayload = mapping.toPayload();

        // Assert
        assertNotSame(originalPayload, retrievedPayload, "Retrieved payload should not be the same instance as original");
        assertFalse(retrievedPayload.containsKey("new"), "Retrieved payload should not contain newly added data");
        assertTrue(retrievedPayload.containsKey("initial"));
        assertEquals("data", retrievedPayload.get("initial"));
    }

    @Test
    void shouldReturnEmptyMap_whenConstructedWithNullPayload() {
        // Arrange
        PredictStateMapping mapping = new PredictStateMapping("toolB", false, null);

        // Act
        Map<String, Object> payload = mapping.toPayload();

        // Assert
        assertNotNull(payload);
        assertTrue(payload.isEmpty());
        // Verify it's an unmodifiable empty map, if Map.copyOf(null) handles it that way
        assertThrows(UnsupportedOperationException.class, () -> payload.put("key", "value"));
    }

    @Test
    void shouldReturnUnmodifiableMap_whenToPayloadIsCalled() {
        // Arrange
        PredictStateMapping mapping = new PredictStateMapping("toolC", true, Map.of("data", "value"));

        // Act
        Map<String, Object> payload = mapping.toPayload();

        // Assert
        assertThrows(UnsupportedOperationException.class, () -> payload.put("newKey", "newValue"), "Returned payload should be unmodifiable");
    }

    @Test
    void normalizeProducesEmptySingleOrList() {
        PredictStateMapping m1 = new PredictStateMapping("toolA", true, "keyA", "argA", Map.of());
        PredictStateMapping m2 = new PredictStateMapping("toolB", false, "keyB", "argB", Map.of());
        assertEquals(List.of(), PredictStateMapping.normalize((PredictStateMapping) null));
        assertEquals(List.of(), PredictStateMapping.normalize((Iterable<PredictStateMapping>) null));
        assertEquals(List.of(m1), PredictStateMapping.normalize(m1));
        assertEquals(List.of(m1, m2), PredictStateMapping.normalize(List.of(m1, m2)));
    }

    @Test
    void toPayloadFieldsMatchesPythonRawValuesIncludingNulls() {
        PredictStateMapping full = new PredictStateMapping("toolA", true, "keyA", "argA", Map.of());
        Map<String, Object> p = full.toPayloadFields();
        assertEquals("keyA", p.get("state_key"));
        assertEquals("toolA", p.get("tool"));
        assertEquals("argA", p.get("tool_argument"));
        // 3-arg constructor leaves stateKey/toolArgument null -> payload carries null (not "")
        PredictStateMapping legacy = new PredictStateMapping("toolB", true, Map.of("k", "v"));
        Map<String, Object> lp = legacy.toPayloadFields();
        assertEquals("toolB", lp.get("tool"));
        assertNull(lp.get("state_key"));
        assertNull(lp.get("tool_argument"));
    }
}