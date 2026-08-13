package com.agui.adk.hitl;

import com.agui.community.core.interrupt.Interrupt;
import java.util.Objects;

/** Durable bridge-owned interrupt with trusted scope and continuation correlation. */
public record PendingInterrupt(
        String interruptId,
        InterruptKind kind,
        PendingCallGroupKey group,
        String originRunId,
        String toolCallId,
        String toolName,
        String adkInvocationId,
        Interrupt interrupt) {
    /** Validates internal and wire correlations. */
    public PendingInterrupt {
        interruptId = requireNonBlank(interruptId, "interruptId");
        kind = Objects.requireNonNull(kind, "kind");
        group = Objects.requireNonNull(group, "group");
        originRunId = requireNonBlank(originRunId, "originRunId");
        toolCallId = requireNonBlank(toolCallId, "toolCallId");
        interrupt = Objects.requireNonNull(interrupt, "interrupt");
        if (!interruptId.equals(interrupt.id()) || !toolCallId.equals(interrupt.toolCallId())) {
            throw new IllegalArgumentException("interrupt snapshot correlation differs");
        }
        if (kind == InterruptKind.FRONTEND_TOOL) {
            toolName = requireNonBlank(toolName, "toolName");
        }
        if (kind == InterruptKind.ADK_CONFIRMATION) {
            adkInvocationId = requireNonBlank(adkInvocationId, "adkInvocationId");
        }
    }

    /** Validates one required internal identifier. */
    /** Validates a required identifier. */
    private static String requireNonBlank(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }
}
