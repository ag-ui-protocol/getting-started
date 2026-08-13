package com.agui.adk.hitl;

import java.util.Map;
import java.util.Objects;

/** Lossless frontend result normalized into the Google function-response map shape. */
public record NormalizedToolResult(String toolCallId, Map<String, Object> response) {
    /** Validates and immutably snapshots the normalized result. */
    public NormalizedToolResult {
        toolCallId = Objects.requireNonNull(toolCallId, "toolCallId");
        response = java.util.Collections.unmodifiableMap(
                new java.util.LinkedHashMap<>(Objects.requireNonNull(response, "response")));
    }
}
