package com.agui.adk.input;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.Objects;

/**
 * Preserves a raw root tool schema at its position in an official AG-UI request.
 *
 * @param position zero-based position in the request tool array
 * @param name tool name
 * @param schema raw JSON schema
 */
public record RawToolSchema(int position, String name, JsonNode schema) {

    /**
     * Creates an immutable raw tool schema value.
     */
    public RawToolSchema {
        if (position < 0) {
            throw new IllegalArgumentException("position must be non-negative");
        }
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("name must not be blank");
        }
        Objects.requireNonNull(schema, "schema");
        schema = schema.deepCopy();
    }

    @Override
    public JsonNode schema() {
        return schema.deepCopy();
    }
}
