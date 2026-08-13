package com.agui.adk.session;

import java.util.Objects;

/**
 * Durable association between an AG-UI thread identity and an ADK session identifier.
 *
 * @param key AG-UI thread identity
 * @param sessionId ADK session identifier
 */
public record SessionMapping(SessionMappingKey key, String sessionId) {

    /** Validates the durable mapping payload. */
    public SessionMapping {
        key = Objects.requireNonNull(key, "key");
        sessionId = Objects.requireNonNull(sessionId, "sessionId");
        if (sessionId.isBlank()) {
            throw new IllegalArgumentException("sessionId must not be blank");
        }
    }
}
