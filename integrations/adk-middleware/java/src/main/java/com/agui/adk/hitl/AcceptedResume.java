package com.agui.adk.hitl;

import com.agui.community.core.interrupt.ResumeStatus;
import java.time.Instant;
import java.util.Objects;

/** Canonical accepted response retained for duplicate detection and tombstones. */
public record AcceptedResume(
        String interruptId,
        ResumeStatus status,
        Object payload,
        String fingerprint,
        Instant acceptedAt) {
    /** Validates retained response identity. */
    public AcceptedResume {
        interruptId = requireNonBlank(interruptId, "interruptId");
        status = Objects.requireNonNull(status, "status");
        fingerprint = requireNonBlank(fingerprint, "fingerprint");
        acceptedAt = Objects.requireNonNull(acceptedAt, "acceptedAt");
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
