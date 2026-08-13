package com.agui.adk.session;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

/** Explicit expiry, scheduling interval and HITL-preservation limit for application-managed session cleanup. */
public record SessionCleanupPolicy(Duration expiry, Duration interval, Duration hitlMaxWait) {
    /**
     * Compact constructor that validates the policy values.
     */
    public SessionCleanupPolicy {
        expiry = requirePositive(expiry, "expiry");
        interval = requirePositive(interval, "interval");
        if (hitlMaxWait != null) {
            hitlMaxWait = requirePositive(hitlMaxWait, "hitlMaxWait");
        }
    }

    /**
     * Convenience constructor without HITL-preservation time limit (pending-tool-call sessions
     * are preserved indefinitely while they have pending calls).
     *
     * @param expiry expiry boundary
     * @param interval scheduling interval
     */
    public SessionCleanupPolicy(Duration expiry, Duration interval) {
        this(expiry, interval, null);
    }

    /**
     * Reports whether a session timestamp is older than the configured expiry boundary.
     *
     * @param lastUpdate session's last durable update
     * @param now cleanup reference time
     * @return whether the session is expired
     */
    public boolean isExpired(Instant lastUpdate, Instant now) {
        return lastUpdate != null && !lastUpdate.isAfter(Objects.requireNonNull(now, "now").minus(expiry));
    }

    /**
     * Validates a non-zero positive duration.
     *
     * @param value configured duration
     * @param name public property name
     * @return validated duration
     */
    private static Duration requirePositive(Duration value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return value;
    }
}
