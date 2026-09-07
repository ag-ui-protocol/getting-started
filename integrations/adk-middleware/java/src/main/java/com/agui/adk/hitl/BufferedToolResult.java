package com.agui.adk.hitl;

import java.util.Objects;

/** Durable accepted result while sibling calls in its invocation group remain outstanding. */
public record BufferedToolResult(PendingToolCall call, NormalizedToolResult result)
        implements PendingResultTransition {
    /** Validates result correlation with the pending provider call. */
    public BufferedToolResult {
        call = Objects.requireNonNull(call, "call");
        result = Objects.requireNonNull(result, "result");
        if (!call.key().toolCallId().equals(result.toolCallId())) {
            throw new IllegalArgumentException("pending call and result IDs differ");
        }
    }
}
