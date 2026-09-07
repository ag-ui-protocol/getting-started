package com.agui.adk.capability;

import java.io.IOException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.Map;

/** Validates and copies arbitrary JSON-safe application capability declarations. */
public final class AdkAgUiCapabilities {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() { };

    private AdkAgUiCapabilities() { }

    /**
     * Creates a detached JSON-native snapshot of a capability declaration.
     *
     * @param capabilities caller-declared capabilities, or {@code null} when unset
     * @return detached snapshot, or {@code null}
     * @throws IllegalArgumentException when the value cannot be represented as JSON
     */
    public static Map<String, Object> snapshot(Map<String, Object> capabilities) {
        if (capabilities == null) {
            return null;
        }
        try {
            return JSON.readValue(JSON.writeValueAsBytes(capabilities), MAP_TYPE);
        } catch (IOException exception) {
            throw new IllegalArgumentException(
                    "capabilities must be JSON-serializable: " + exception.getMessage(),
                    exception);
        }
    }

    /**
     * Validates a caller-declared capability map.
     *
     * @param capabilities caller-declared capabilities, or {@code null}
     * @throws IllegalArgumentException when the value cannot be represented as JSON
     */
    public static void validate(Map<String, Object> capabilities) {
        snapshot(capabilities);
    }
}
