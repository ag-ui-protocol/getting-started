package com.agui.adk.execution;

import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;

/** Process-local global admission gate that rejects rather than queues at capacity. */
public final class InProcessGlobalExecutionLimiter {

    private final Semaphore permits;

    /**
     * Creates a bounded process-local admission gate.
     *
     * @param limit maximum executions admitted at one time
     */
    public InProcessGlobalExecutionLimiter(int limit) {
        permits = new Semaphore(limit);
    }

    /**
     * Acquires an admission slot immediately when capacity is available.
     *
     * @return one closeable admission slot, or {@code null} when capacity is exhausted
     */
    public ExecutionLease tryAcquire() {
        if (!permits.tryAcquire()) {
            return null;
        }
        AtomicBoolean released = new AtomicBoolean();
        return () -> {
            if (released.compareAndSet(false, true)) {
                permits.release();
            }
        };
    }
}
