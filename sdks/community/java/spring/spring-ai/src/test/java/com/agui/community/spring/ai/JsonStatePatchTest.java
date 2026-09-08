package com.agui.community.spring.ai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.event.JsonPatchOperation;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JsonStatePatchTest {

    @Test
    void noChangeProducesNoOperations() {
        assertTrue(JsonStatePatch.diff(Map.of("a", 1), Map.of("a", 1)).isEmpty());
    }

    @Test
    void replacesChangedScalar() {
        List<JsonPatchOperation> ops = JsonStatePatch.diff(Map.of("count", 1), Map.of("count", 2));

        assertEquals(1, ops.size());
        assertEquals("replace", ops.get(0).op());
        assertEquals("/count", ops.get(0).path());
        assertEquals(2, ops.get(0).value());
    }

    @Test
    void addsNewKey() {
        List<JsonPatchOperation> ops = JsonStatePatch.diff(Map.of(), Map.of("name", "Ada"));

        assertEquals(1, ops.size());
        assertEquals("add", ops.get(0).op());
        assertEquals("/name", ops.get(0).path());
        assertEquals("Ada", ops.get(0).value());
    }

    @Test
    void removesDroppedKey() {
        List<JsonPatchOperation> ops = JsonStatePatch.diff(Map.of("name", "Ada"), Map.of());

        assertEquals(1, ops.size());
        assertEquals("remove", ops.get(0).op());
        assertEquals("/name", ops.get(0).path());
    }

    @Test
    void recursesIntoNestedObjects() {
        List<JsonPatchOperation> ops = JsonStatePatch.diff(
                Map.of("user", Map.of("age", 30)),
                Map.of("user", Map.of("age", 31)));

        assertEquals(1, ops.size());
        assertEquals("replace", ops.get(0).op());
        assertEquals("/user/age", ops.get(0).path());
        assertEquals(31, ops.get(0).value());
    }
}
