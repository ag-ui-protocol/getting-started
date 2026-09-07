package com.agui.adk.serialization;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.Map;

/**
 * Pure port of the Python {@code serialization.py serialize_tool_args}: serialize tool-call
 * arguments to a JSON string.
 *
 * <p>Python delegates to Pydantic's {@code TypeAdapter.dump_json} (which knows how to serialize
 * Pydantic models / Enums) and returns {@code str(args)} for non-dict values. In Java the arguments
 * are supplied as maps by the Google ADK function-call API, so a map is serialized to compact
 * JSON. Any other value is stringified, matching Python's
 * {@code str(args)}.
 */
public final class ToolCallSerialization {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ToolCallSerialization() {
    }

    /**
     * Serializes tool-call arguments to a JSON string.
     *
     * @param args the arguments (a map, or any value)
     * @return compact JSON for map arguments; {@code String.valueOf} otherwise
     */
    public static String serializeToolArgs(Object args) {
        if (args instanceof Map<?, ?>) {
            try {
                return MAPPER.writeValueAsString(args);
            } catch (Exception exception) {
                throw new IllegalArgumentException(
                        "Failed to serialize tool-call arguments", exception);
            }
        }
        return String.valueOf(args);
    }
}
