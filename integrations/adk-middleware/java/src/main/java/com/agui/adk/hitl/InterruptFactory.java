package com.agui.adk.hitl;

import com.agui.community.core.interrupt.Interrupt;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.Objects;

/** Creates stable official interrupt snapshots with bridge-owned opaque correlation identifiers. */
public final class InterruptFactory {
    private static final SecureRandom RANDOM = new SecureRandom();

    /**
     * Creates one frontend tool interruption.
     *
     * @param group trusted durable group
     * @param originRunId run that exposed the interruption
     * @param toolCallId visible tool-call correlation
     * @param toolName trusted tool name
     * @param responseSchema validated result schema snapshot
     * @return durable internal record and official wire snapshot
     */
    public PendingInterrupt frontendTool(
            PendingCallGroupKey group,
            String originRunId,
            String toolCallId,
            String toolName,
            Object responseSchema) {
        Objects.requireNonNull(responseSchema, "responseSchema");
        String id = opaqueId();
        Interrupt interrupt = new Interrupt(
                id,
                "tool_call",
                "Complete tool " + toolName,
                toolCallId,
                responseSchema,
                null,
                Map.of("kind", "frontend_tool", "toolName", toolName, "schemaVersion", 1));
        return new PendingInterrupt(
                id, InterruptKind.FRONTEND_TOOL, group, originRunId, toolCallId,
                toolName, null, interrupt);
    }

    /**
     * Creates one native ADK confirmation interruption.
     *
     * @param group trusted durable group
     * @param originRunId run that exposed the interruption
     * @param toolCallId original provider tool call
     * @param adkInvocationId internal confirmation function-call identifier
     * @param message sanitized prompt
     * @param responseSchema validated confirmation schema
     * @return durable internal record and official wire snapshot
     */
    public PendingInterrupt confirmation(
            PendingCallGroupKey group,
            String originRunId,
            String toolCallId,
            String adkInvocationId,
            String message,
            Object responseSchema) {
        Objects.requireNonNull(responseSchema, "responseSchema");
        String id = opaqueId();
        Interrupt interrupt = new Interrupt(
                id,
                "confirmation",
                message == null || message.isBlank() ? "Confirm tool execution" : message,
                toolCallId,
                responseSchema,
                null,
                Map.of("kind", "adk_confirmation", "schemaVersion", 1));
        return new PendingInterrupt(
                id, InterruptKind.ADK_CONFIRMATION, group, originRunId, toolCallId,
                null, adkInvocationId, interrupt);
    }

    /**
     * Returns a CSPRNG-backed 128-bit base64url identifier.
     * @return opaque public interrupt identifier
     */
    private static String opaqueId() {
        byte[] value = new byte[16];
        RANDOM.nextBytes(value);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }
}
