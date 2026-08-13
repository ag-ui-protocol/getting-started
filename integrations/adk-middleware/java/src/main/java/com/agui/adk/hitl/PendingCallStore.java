package com.agui.adk.hitl;

import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;

import java.util.Map;

/** Durable boundary for pending frontend calls and atomic result-resumption claims. */
public interface PendingCallStore {
    Completable persist(PendingToolCall call);

    /**
     * Reports whether result submissions and claims are atomic across bridge processes.
     *
     * @return true when distributed atomic claim semantics are provided
     */
    default boolean isDistributedAtomic() {
        return false;
    }

    /**
     * Removes only calls durably owned by one failed provider event.
     *
     * <p>The group and IDs identify the exact records created by the event-scoped batch. The
     * operation is idempotent: absent keys are already compensated and must not affect calls from
     * another invocation.
     *
     * @param group pending-call invocation group that owns the records
     * @param toolCallIds exact frontend call IDs created by the failed event
     * @return completion after durable compensation
     */
    default Completable remove(PendingCallGroupKey group, java.util.Set<String> toolCallIds) {
        return Completable.error(new UnsupportedOperationException("pending-call removal is unsupported"));
    }

    Flowable<PendingToolCall> pending(PendingCallScope scope);

    /**
     * Returns durable consumed frontend-result identities scoped to one principal session.
     *
     * <p>The returned values retain the normalized fingerprintable payload needed to distinguish
     * historical replay from an unknown current frontend result after its pending group completes.
     *
     * @param scope principal-scoped ADK session identity
     * @return immutable consumed result identities keyed by provider tool-call ID
     */
    default Map<String, ConsumedToolResult> consumed(PendingCallScope scope) {
        return Map.of();
    }

    /**
     * Returns current buffered result IDs for completeness planning without mutating the store.
     *
     * @param scope principal-scoped ADK session identity
     * @return immutable buffered result IDs
     */
    default java.util.Set<String> acceptedResultIds(PendingCallScope scope) {
        return java.util.Set.of();
    }

    /**
     * Atomically buffers a result, returns a duplicate, or claims one complete current invocation.
     *
     * @param group current frontend-call invocation group
     * @param result normalized browser response
     * @return atomic submission outcome
     */
    default Single<PendingResultTransition> submitResult(PendingCallGroupKey group, NormalizedToolResult result) {
        return Single.error(new UnsupportedOperationException("tool-result submission is unsupported"));
    }

    /**
     * Atomically locates a current scoped call and accepts its result.
     *
     * @param scope principal-scoped ADK session identity
     * @param result normalized browser response
     * @return atomic submission outcome
     */
    default Single<PendingResultTransition> submitResult(PendingCallScope scope, NormalizedToolResult result) {
        return Single.error(new UnsupportedOperationException("scoped tool-result submission is unsupported"));
    }

    /**
     * Atomically accepts a browser result while preserving its original identity for history replay.
     *
     * @param scope principal-scoped ADK session identity
     * @param result identity and normalized browser response
     * @return buffered, duplicate, or exclusive ready claim
     */
    default Single<PendingResultTransition> submitResult(PendingCallScope scope, ConsumedToolResult result) {
        return submitResult(scope, result.result());
    }

    /**
     * Releases an unsuccessfully accepted ADK resume claim for safe retry.
     *
     * <p>If finalization is already pending, implementations must retain that recovery marker so a
     * retry cannot invoke ADK again. Only {@link #complete(ResumeClaim)} clears the marker.
     *
     * @param claim exclusively owned complete group
     * @return completion of the release
     */
    default Completable release(ResumeClaim claim) {
        return Completable.error(new UnsupportedOperationException("resume-claim release is unsupported"));
    }

    /**
     * Records that the ADK continuation has terminated and durable completion remains pending.
     *
     * <p>Once this marker is durable, retries must finish message/pending-call finalization rather
     * than invoke ADK with the same tool result again.
     *
     * @param claim exclusively owned complete group
     * @return completion of the recovery marker
     */
    default Completable markFinalizationPending(ResumeClaim claim) {
        return Completable.error(new UnsupportedOperationException("resume finalization recovery is unsupported"));
    }

    /**
     * Reports whether a claimed group has already completed its ADK continuation.
     *
     * @param claim exclusively owned complete group
     * @return true when retry must perform finalization only
     */
    default Single<Boolean> finalizationPending(ResumeClaim claim) {
        return Single.error(new UnsupportedOperationException("resume finalization recovery is unsupported"));
    }

    /**
     * Releases active finalization ownership while retaining its durable recovery marker.
     *
     * <p>This permits exactly one later duplicate submission to acquire recovery ownership without
     * rerunning ADK. Stores that support finalization recovery must override this operation.
     *
     * @param claim exclusively owned complete group
     * @return completion after finalization ownership is durably available for recovery
     */
    default Completable releaseFinalization(ResumeClaim claim) {
        return Completable.error(new UnsupportedOperationException("resume finalization recovery is unsupported"));
    }

    /**
     * Completes a claim only after ADK accepts the complete group durably.
     *
     * @param claim exclusively owned complete group
     * @return completion of durable acknowledgement
     */
    default Completable complete(ResumeClaim claim) {
        return Completable.error(new UnsupportedOperationException("resume-claim completion is unsupported"));
    }
}
