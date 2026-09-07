package com.agui.adk.hitl;

import java.util.Objects;

/**
 * Tenant-safe durable scope for pending frontend calls.
 *
 * @param appName ADK application identifier
 * @param userId authenticated principal identifier
 * @param sessionId ADK session identifier
 */
public record PendingCallScope(String appName, String userId, String sessionId) {
    /** Validates that the scope cannot be accidentally unscoped. */
    public PendingCallScope {
        appName = Objects.requireNonNull(appName, "appName");
        userId = Objects.requireNonNull(userId, "userId");
        sessionId = Objects.requireNonNull(sessionId, "sessionId");
    }
}
