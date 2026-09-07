package com.agui.adk.hitl;

import java.util.Objects;

/** Request-local identity ledger for provider tool-call IDs. */
public final class ToolCallLedger {
    /**
     * Preserves a provider ID, or derives a stable fallback within an invocation.
     *
     * @param invocationId bridge invocation identifier
     * @param position zero-based provider-call position
     * @param providerId optional provider identifier
     * @return a stable tool-call identifier
     */
    public String idFor(String invocationId, int position, String providerId) {
        if (providerId != null && !providerId.isBlank()) {
            return providerId;
        }
        if (position < 0) {
            throw new IllegalArgumentException("position must not be negative");
        }
        return "generated:" + Objects.requireNonNull(invocationId, "invocationId") + ':' + position;
    }
}
