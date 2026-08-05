package com.agui.community.core.tool;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ToolTest {

    @Test
    void toolParametersDefaultTypeIsObject() {
        ToolParameters params = new ToolParameters(Map.of("q", Map.of("type", "string")), List.of("q"));
        assertEquals(ToolParameters.TOOL_PARAMETERS_TYPE, params.type());
        assertEquals("object", params.type());
    }

    @Test
    void toolParametersTreatPropertiesRequiredAndTypeAsOptional() {
        // JSON Schema makes "properties" and "required" optional; a tool with no
        // required arguments omits them. Deserialization passes nulls here.
        ToolParameters params = new ToolParameters(null, null, null);

        assertEquals("object", params.type());
        assertTrue(params.properties().isEmpty());
        assertTrue(params.required().isEmpty());
    }

    @Test
    void toolParametersCopyPropertiesAndRequiredDefensively() {
        Map<String, Object> properties = new HashMap<>();
        properties.put("q", Map.of("type", "string"));

        ToolParameters params = new ToolParameters(properties, List.of("q"));
        properties.clear();

        assertEquals(1, params.properties().size());
        assertThrows(UnsupportedOperationException.class, () -> params.properties().put("x", "y"));
        assertThrows(UnsupportedOperationException.class, () -> params.required().add("x"));
    }

    @Test
    void toolRequiresAllFields() {
        ToolParameters params = new ToolParameters(Map.of(), List.of());
        assertThrows(NullPointerException.class, () -> new Tool(null, "desc", params));
        assertThrows(NullPointerException.class, () -> new Tool("name", null, params));
        assertThrows(NullPointerException.class, () -> new Tool("name", "desc", null));
    }
}
