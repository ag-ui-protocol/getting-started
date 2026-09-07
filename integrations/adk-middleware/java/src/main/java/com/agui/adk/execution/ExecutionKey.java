package com.agui.adk.execution;

import java.util.Objects;

/**
 * Stable identity for serialized execution of one AG-UI thread.
 *
 * @param appName Google ADK application name
 * @param userId authenticated user identifier
 * @param threadId AG-UI thread identifier
 */
public record ExecutionKey(String appName, String userId, String threadId) {

    /** Validates the execution identity. */
    public ExecutionKey {
        appName = required(appName, "appName");
        userId = required(userId, "userId");
        threadId = required(threadId, "threadId");
    }

    /**
     * Validates a nonblank key component.
     *
     * @param value component value
     * @param name component name
     * @return validated component
     */
    private static String required(String value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }
}
