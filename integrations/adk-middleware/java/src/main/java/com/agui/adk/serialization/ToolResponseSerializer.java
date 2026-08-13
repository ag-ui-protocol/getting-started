package com.agui.adk.serialization;

import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Serializes an arbitrary tool response into a UTF-8 JSON string, mirroring the Python
 * {@code _serialize_tool_response}: coerce to a JSON-serializable structure, then encode with
 * {@code ensure_ascii=False} (non-ASCII characters written verbatim). Falls back to stringifying
 * the raw response and ultimately a JSON-encoded empty string, never throwing.
 */
public final class ToolResponseSerializer {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ToolResponseSerializer() {
    }

    /**
     * Serializes a raw tool response into a JSON string.
     *
     * @param response the raw tool response payload
     * @return a valid JSON string; the ultimate fallback is the JSON string {@code "\"\""}
     */
    public static String serialize(Object response) {
        try {
            return MAPPER.writeValueAsString(ToolResponseCoercer.coerce(response));
        } catch (Exception coerceFailure) {
            try {
                return MAPPER.writeValueAsString(String.valueOf(response));
            } catch (Exception serializationFailure) {
                return "\"\"";
            }
        }
    }
}
