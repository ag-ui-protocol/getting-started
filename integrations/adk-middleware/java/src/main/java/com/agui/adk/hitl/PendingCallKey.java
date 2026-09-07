package com.agui.adk.hitl;

import java.util.Objects;

/** Identifies one pending call without crossing application, principal, or session boundaries. */
public record PendingCallKey(PendingCallGroupKey group, String toolCallId) {
    public PendingCallKey {
        group = Objects.requireNonNull(group, "group");
        toolCallId = Objects.requireNonNull(toolCallId, "toolCallId");
    }
}
