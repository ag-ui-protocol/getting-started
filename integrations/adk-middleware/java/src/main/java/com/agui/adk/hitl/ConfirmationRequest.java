package com.agui.adk.hitl;

import java.util.Objects;

/** A native ADK confirmation request correlated to its original provider tool call. */
public record ConfirmationRequest(PendingCallScope scope, String invocationId, String toolCallId) {
    /**
     * Validates a confirmation correlation entry.
     *
     * @param scope principal-scoped ADK session identity
     * @param invocationId native ADK confirmation function-call identifier
     * @param toolCallId original provider function-call identifier
     */
    public ConfirmationRequest {
        scope = Objects.requireNonNull(scope, "scope");
        invocationId = requireId(invocationId, "invocationId");
        toolCallId = requireId(toolCallId, "toolCallId");
    }

    /**
     * Validates a nonblank identifier.
     *
     * @param value identifier value
     * @param name identifier field name
     * @return validated identifier
     */
    private static String requireId(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }
}
