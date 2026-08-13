package com.agui.adk.hitl;

import com.agui.community.core.interrupt.Resume;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import java.util.List;
import java.util.Set;

/** Durable scoped interruption boundary with atomic group claims and finalization recovery. */
public interface InterruptStore {
    /**
     * Persists one immutable atomic interrupt group.
     *
     * @param interrupts complete group in stable order
     * @return completion of persistence
     */
    Completable persistGroup(List<PendingInterrupt> interrupts);

    /**
     * Removes interrupts while compensating failed group persistence.
     *
     * @param group owning group
     * @param interruptIds interrupt identifiers to remove
     * @return completion of removal
     */
    default Completable removeGroup(PendingCallGroupKey group, Set<String> interruptIds) {
        return Completable.error(new UnsupportedOperationException());
    }

    /**
     * Returns unanswered interrupts visible to a trusted scope.
     *
     * @param scope trusted server scope
     * @return outstanding interrupts
     */
    Flowable<PendingInterrupt> outstanding(PendingCallScope scope);

    /**
     * Looks up exact outstanding interrupts without revealing another scope.
     *
     * @param scope trusted server scope
     * @param interruptIds opaque public identifiers
     * @return matching interrupts in requested order
     */
    Single<List<PendingInterrupt>> lookup(PendingCallScope scope, List<String> interruptIds);

    /**
     * Atomically admits official resume decisions for one group.
     *
     * @param scope trusted server scope
     * @param resumes submitted decisions
     * @return admission outcome
     */
    Single<InterruptSubmission> submit(PendingCallScope scope, List<Resume> resumes);

    /**
     * Releases a claim before its continuation completes.
     *
     * @param claim active claim
     * @return completion of release
     */
    Completable release(InterruptGroupClaim claim);

    /**
     * Marks that continuation ran and only finalization may be retried.
     *
     * @param claim active claim
     * @return completion of transition
     */
    Completable markFinalizationPending(InterruptGroupClaim claim);

    /**
     * Reports whether a claim is in finalization recovery.
     *
     * @param claim active claim
     * @return finalization marker state
     */
    Single<Boolean> finalizationPending(InterruptGroupClaim claim);

    /**
     * Releases ownership while retaining finalization recovery state.
     *
     * @param claim active finalization claim
     * @return completion of release
     */
    Completable releaseFinalization(InterruptGroupClaim claim);

    /**
     * Completes a group and retains bounded idempotency tombstones.
     *
     * @param claim active claim
     * @return completion of durable consumption
     */
    Completable complete(InterruptGroupClaim claim);

    /**
     * Reports whether claims are atomic between processes.
     *
     * @return distributed atomic capability
     */
    default boolean isDistributedAtomic() {
        return false;
    }
}
