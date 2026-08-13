package com.agui.adk;

/**
 * Framework-neutral options for the AG-UI to Google ADK bridge.
 *
 * <p>The direct-session option selects compatible AG-UI thread-ID session identity.
 * Accepted runs use the configured positive timeout, and the process-local global limit
 * rejects new accepted runs when capacity is exhausted. Cleanup policies are configured
 * independently, mirroring Python {@code SessionManager}: {@code deleteSessionOnCleanup}
 * and {@code saveSessionToMemoryOnCleanup} decide whether an expired/evicted session is
 * deleted from the backend and whether it is ingested into memory first (M-09/M-21).
 *
 * @param useThreadIdAsSessionId whether compatible session services use the AG-UI
 *                               thread ID directly as the ADK session ID
 * @param runTimeout positive timeout applied to accepted runs
 * @param globalConcurrencyLimit positive process-local maximum for accepted runs
 * @param maxSessionsPerUser positive maximum concurrent tracked sessions per user, or
 *                           {@code null} for unlimited (Python {@code max_sessions_per_user})
 * @param emitMessagesSnapshot whether each accepted run emits one {@code MESSAGES_SNAPSHOT}
 *                             event at the end of the run, built from the refreshed session
 *                             (Python {@code emit_messages_snapshot}, default {@code false})
 * @param deleteSessionOnCleanup whether expired/evicted sessions are deleted from the
 *                               backend session service (Python {@code delete_session_on_cleanup})
 * @param saveSessionToMemoryOnCleanup whether expired/evicted sessions are ingested into
 *                                     the memory service before any deletion
 *                                     (Python {@code save_session_to_memory_on_cleanup})
 */
public record AdkAgUiOptions(
        boolean useThreadIdAsSessionId,
        java.time.Duration runTimeout,
        int globalConcurrencyLimit,
        Integer maxSessionsPerUser,
        boolean emitMessagesSnapshot,
        boolean deleteSessionOnCleanup,
        boolean saveSessionToMemoryOnCleanup) {

    /** Python {@code execution_timeout_seconds} default: 10 minutes. */
    private static final java.time.Duration DEFAULT_RUN_TIMEOUT = java.time.Duration.ofMinutes(10);

    /** Python {@code max_concurrent_executions} default. */
    private static final int DEFAULT_GLOBAL_CONCURRENCY_LIMIT = 10;

    /**
     * Retains the source-compatible options constructor used by existing callers (unlimited users).
     *
     * @param useThreadIdAsSessionId whether compatible session services may use the thread ID
     * @param runTimeout positive timeout applied to accepted runs
     * @param globalConcurrencyLimit positive process-local maximum for accepted runs
     */
    public AdkAgUiOptions(boolean useThreadIdAsSessionId, java.time.Duration runTimeout, int globalConcurrencyLimit) {
        this(useThreadIdAsSessionId, runTimeout, globalConcurrencyLimit, null, false, true, true);
    }

    /**
     * Retains the source-compatible options constructor used by existing callers (unlimited users).
     *
     * @param useThreadIdAsSessionId whether compatible session services may use the thread ID
     * @param runTimeout positive timeout applied to accepted runs
     * @param globalConcurrencyLimit positive process-local maximum for accepted runs
     * @param maxSessionsPerUser positive maximum concurrent tracked sessions per user, or
     *                           {@code null} for unlimited (Python {@code max_sessions_per_user})
     */
    public AdkAgUiOptions(
            boolean useThreadIdAsSessionId,
            java.time.Duration runTimeout,
            int globalConcurrencyLimit,
            Integer maxSessionsPerUser) {
        this(useThreadIdAsSessionId, runTimeout, globalConcurrencyLimit, maxSessionsPerUser, false, true, true);
    }

    /**
     * Retains the source-compatible options constructor used by existing callers (unlimited users),
     * including the end-of-run messages-snapshot toggle.
     *
     * @param useThreadIdAsSessionId whether compatible session services may use the thread ID
     * @param runTimeout positive timeout applied to accepted runs
     * @param globalConcurrencyLimit positive process-local maximum for accepted runs
     * @param maxSessionsPerUser positive maximum concurrent tracked sessions per user, or
     *                           {@code null} for unlimited (Python {@code max_sessions_per_user})
     * @param emitMessagesSnapshot whether each accepted run emits one {@code MESSAGES_SNAPSHOT}
     *                             event at the end of the run (Python {@code emit_messages_snapshot})
     */
    public AdkAgUiOptions(
            boolean useThreadIdAsSessionId,
            java.time.Duration runTimeout,
            int globalConcurrencyLimit,
            Integer maxSessionsPerUser,
            boolean emitMessagesSnapshot) {
        this(useThreadIdAsSessionId, runTimeout, globalConcurrencyLimit, maxSessionsPerUser,
                emitMessagesSnapshot, true, true);
    }

    /**
     * Retains the legacy single-option constructor used by existing callers (unlimited users).
     *
     * @param useThreadIdAsSessionId whether compatible session services may use the thread ID
     */
    public AdkAgUiOptions(boolean useThreadIdAsSessionId) {
        this(useThreadIdAsSessionId, DEFAULT_RUN_TIMEOUT, DEFAULT_GLOBAL_CONCURRENCY_LIMIT, null,
                false, true, true);
    }

    /**
     * Validates bounded execution options.
     */
    public AdkAgUiOptions {
        if (runTimeout == null || runTimeout.isZero() || runTimeout.isNegative()) {
            throw new IllegalArgumentException("runTimeout must be positive");
        }
        if (globalConcurrencyLimit < 1) {
            throw new IllegalArgumentException("globalConcurrencyLimit must be positive");
        }
        if (maxSessionsPerUser != null && maxSessionsPerUser < 1) {
            throw new IllegalArgumentException("maxSessionsPerUser must be positive or null");
        }
    }

    /**
     * Returns a copy with the end-of-run messages-snapshot emission toggled.
     *
     * @param enabled whether accepted runs emit one {@code MESSAGES_SNAPSHOT} at the end
     * @return updated options
     */
    public AdkAgUiOptions withEmitMessagesSnapshot(boolean enabled) {
        return new AdkAgUiOptions(
                useThreadIdAsSessionId, runTimeout, globalConcurrencyLimit, maxSessionsPerUser,
                enabled, deleteSessionOnCleanup, saveSessionToMemoryOnCleanup);
    }

    /**
     * Returns a copy with the independent backend-deletion cleanup policy replaced
     * (Python {@code delete_session_on_cleanup}).
     *
     * @param deleteOnCleanup whether expired/evicted sessions are deleted from the backend
     * @return adjusted options
     */
    public AdkAgUiOptions withDeleteSessionOnCleanup(boolean deleteOnCleanup) {
        return new AdkAgUiOptions(useThreadIdAsSessionId, runTimeout, globalConcurrencyLimit,
                maxSessionsPerUser, emitMessagesSnapshot, deleteOnCleanup, saveSessionToMemoryOnCleanup);
    }

    /**
     * Returns a copy with the independent memory-ingestion cleanup policy replaced
     * (Python {@code save_session_to_memory_on_cleanup}).
     *
     * @param saveToMemoryOnCleanup whether expired/evicted sessions are ingested into memory
     * @return adjusted options
     */
    public AdkAgUiOptions withSaveSessionToMemoryOnCleanup(boolean saveToMemoryOnCleanup) {
        return new AdkAgUiOptions(useThreadIdAsSessionId, runTimeout, globalConcurrencyLimit,
                maxSessionsPerUser, emitMessagesSnapshot, deleteSessionOnCleanup, saveToMemoryOnCleanup);
    }

    /**
     * Returns a copy with the per-user concurrent-session cap replaced.
     *
     * @param cap positive maximum concurrent tracked sessions per user, or {@code null}
     *            for unlimited
     * @return adjusted options
     */
    public AdkAgUiOptions withMaxSessionsPerUser(Integer cap) {
        return new AdkAgUiOptions(useThreadIdAsSessionId, runTimeout, globalConcurrencyLimit,
                cap, emitMessagesSnapshot, deleteSessionOnCleanup, saveSessionToMemoryOnCleanup);
    }

    /**
     * Returns safe defaults aligned with Python for run timeout and global concurrency.
     *
     * @return default bridge options
     */
    public static AdkAgUiOptions defaults() {
        return new AdkAgUiOptions(false);
    }
}
