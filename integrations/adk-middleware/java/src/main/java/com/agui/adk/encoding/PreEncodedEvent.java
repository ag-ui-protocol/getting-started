package com.agui.adk.encoding;

import com.agui.community.core.event.ToolCallChunkEvent;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.util.Objects;

/** Exact wire JSON paired with the official tool-call event at the sealed Event boundary. */
public record PreEncodedEvent(ToolCallChunkEvent delegate, String json) {
    private static final int MAX_JSON_BYTES = 1_048_576;
    private static final ObjectMapper VALIDATOR = new ObjectMapper()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    /** Validates retained JSON before it can become visible to a stream. */
    public PreEncodedEvent {
        delegate = Objects.requireNonNull(delegate, "delegate");
        json = Objects.requireNonNull(json, "json");
        if (json.isBlank() || json.getBytes(StandardCharsets.UTF_8).length > MAX_JSON_BYTES) {
            throw new IllegalArgumentException("pre-encoded event JSON must be a bounded object");
        }
        try {
            if (!VALIDATOR.readTree(json).isObject()) {
                throw new IllegalArgumentException("pre-encoded event JSON must be an object");
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            throw new IllegalArgumentException("pre-encoded event JSON must be valid", exception);
        }
    }
}
