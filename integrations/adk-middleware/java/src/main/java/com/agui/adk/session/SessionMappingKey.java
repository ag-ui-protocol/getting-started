package com.agui.adk.session;

import java.util.Objects;

/**
 * Stable AG-UI thread identity used to locate a Google ADK session.
 *
 * @param appName Google ADK application name
 * @param userId Google ADK user identifier
 * @param threadId AG-UI thread identifier
 */
public record SessionMappingKey(String appName, String userId, String threadId) {

    /** Validates each dimension of the mapping key. */
    public SessionMappingKey {
        appName = requireNonBlank(appName, "appName");
        userId = requireNonBlank(userId, "userId");
        threadId = requireNonBlank(threadId, "threadId");
    }

    /**
     * Enforces one non-blank key component.
     *
     * @param value component value
     * @param name component name
     * @return validated value
     */
    private static String requireNonBlank(String value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }
}
