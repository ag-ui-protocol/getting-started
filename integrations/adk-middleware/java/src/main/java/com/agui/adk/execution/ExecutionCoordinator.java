package com.agui.adk.execution;

import io.reactivex.rxjava3.core.Single;

/** Coordinates admission to one AG-UI execution identity. */
public interface ExecutionCoordinator {

    /**
     * Acquires an execution lease after any earlier execution for the same key ends.
     *
     * @param key execution identity
     * @param cancellation request cancellation state
     * @return a lease that must be closed exactly once
     */
    Single<ExecutionLease> acquire(ExecutionKey key, CancellationToken cancellation);

    /**
     * Reports whether this coordinator provides distributed coordination.
     *
     * @return {@code true} when coordination spans processes
     */
    boolean isDistributed();
}
