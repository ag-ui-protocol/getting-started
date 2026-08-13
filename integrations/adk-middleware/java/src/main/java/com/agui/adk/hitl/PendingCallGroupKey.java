package com.agui.adk.hitl;

import java.util.Objects;

/** Groups calls produced by one bridge invocation within a session scope. */
public record PendingCallGroupKey(PendingCallScope scope, String invocationId) {
    public PendingCallGroupKey {
        scope = Objects.requireNonNull(scope, "scope");
        invocationId = Objects.requireNonNull(invocationId, "invocationId");
    }
}
