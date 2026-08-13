package com.agui.adk.hitl;

import com.agui.adk.message.MessageFingerprint;
import com.agui.community.core.message.ToolMessage;

import java.util.Objects;

/** Immutable identity and normalized payload retained after a frontend result is consumed. */
public record ConsumedToolResult(
        String messageId,
        String fingerprint,
        NormalizedToolResult result,
        ToolMessage originalMessage) {

    /** Validates the immutable submitted-result identity. */
    public ConsumedToolResult {
        messageId = Objects.requireNonNull(messageId, "messageId");
        fingerprint = Objects.requireNonNull(fingerprint, "fingerprint");
        result = Objects.requireNonNull(result, "result");
        if (originalMessage != null && (!messageId.equals(originalMessage.id())
                || !fingerprint.equals(MessageFingerprint.of(originalMessage)))) {
            throw new IllegalArgumentException("original message identity differs");
        }
    }

    /** Creates an identity without an official message, for historical compatibility only. */
    public ConsumedToolResult(String messageId, String fingerprint, NormalizedToolResult result) {
        this(messageId, fingerprint, result, null);
    }

    /** Creates a retained identity from the official frontend result. */
    public static ConsumedToolResult from(ToolMessage message, ToolResultNormalizer normalizer) {
        Objects.requireNonNull(message, "message");
        Objects.requireNonNull(normalizer, "normalizer");
        return new ConsumedToolResult(message.id(), MessageFingerprint.of(message), normalizer.normalize(message), message);
    }

    /** Returns whether this exact official frontend result was previously consumed. */
    public boolean matches(ToolMessage message) {
        return messageId.equals(message.id()) && fingerprint.equals(MessageFingerprint.of(message));
    }
}
