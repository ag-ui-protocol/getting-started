package com.agui.adk.hitl;

import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Single;

/** Principal-scoped durable boundary for native ADK confirmation correlations. */
public interface ConfirmationRequestStore {
    /**
     * Persists one native confirmation request before it becomes visible to a client.
     *
     * @param request native confirmation correlation
     * @return completion of the persistence action
     */
    Completable persist(ConfirmationRequest request);

    /**
     * Atomically claims one exact native confirmation correlation for continuation.
     *
     * <p>A false result means the correlation is unknown, mismatched, already claimed, or consumed.
     * A caller that obtains a claim must {@link #complete(ConfirmationRequest)} after successful
     * terminal continuation, or {@link #release(ConfirmationRequest)} after failure or cancellation.
     * Custom deployments should provide a shared atomic implementation when agents span processes.
     *
     * @param request client-supplied confirmation identifiers and resolved principal scope
     * @return whether this caller exclusively owns the continuation
     */
    Single<Boolean> claim(ConfirmationRequest request);

    /**
     * Releases a failed or cancelled confirmation continuation for retry.
     *
     * @param request exact claimed confirmation correlation
     * @return release completion
     */
    Completable release(ConfirmationRequest request);

    /**
     * Atomically consumes a successfully completed confirmation continuation.
     *
     * @param request exact claimed confirmation correlation
     * @return completion update
     */
    Completable complete(ConfirmationRequest request);
}
