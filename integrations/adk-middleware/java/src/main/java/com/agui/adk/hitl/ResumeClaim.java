package com.agui.adk.hitl;

import com.agui.community.core.message.ToolMessage;

import java.util.List;
import java.util.Objects;

/** Exclusive, releasable ownership of one complete invocation result group. */
public record ResumeClaim(
        PendingCallGroupKey group,
        List<BufferedToolResult> results,
        List<ToolMessage> originalMessages) implements PendingResultTransition {
    /** Validates an atomic claim and freezes its stable response ordering. */
    public ResumeClaim {
        group = Objects.requireNonNull(group, "group");
        results = List.copyOf(Objects.requireNonNull(results, "results"));
        originalMessages = List.copyOf(Objects.requireNonNull(originalMessages, "originalMessages"));
        if (results.isEmpty()) {
            throw new IllegalArgumentException("resume claim requires results");
        }
        if (!originalMessages.isEmpty() && originalMessages.size() != results.size()) {
            throw new IllegalArgumentException("resume claim originals must match results");
        }
    }

    /** Creates a claim when submissions did not carry official message identity. */
    public ResumeClaim(PendingCallGroupKey group, List<BufferedToolResult> results) {
        this(group, results, List.of());
    }
}
