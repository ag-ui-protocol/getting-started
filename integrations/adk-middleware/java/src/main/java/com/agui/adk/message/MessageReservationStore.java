package com.agui.adk.message;

import com.google.adk.sessions.Session;
import com.agui.adk.session.ResolvedSession;
import com.agui.community.core.message.Message;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Single;

import java.util.List;

/** Transactionally tracks AG-UI messages until their ADK execution is accepted. */
public interface MessageReservationStore {

    /**
     * Reserves unseen messages for one invocation.
     *
     * @param session resolved ADK session
     * @param messages candidate request messages
     * @param invocationId bridge invocation identifier
     * @return reservation containing only newly admitted messages
     */
    Single<MessageReservation> reserve(
            ResolvedSession session,
            List<Message> messages,
            String invocationId);

    /**
     * Commits an accepted reservation.
     *
     * @param reservation accepted reservation
     * @return completion after the in-flight IDs are committed
     */
    Completable commit(MessageReservation reservation);

    /**
     * Releases a failed or cancelled reservation for retry.
     *
     * @param reservation failed reservation
     * @return completion after the in-flight IDs are released
     */
    Completable rollback(MessageReservation reservation);

    /**
     * Evicts process-local reservation state for a session confirmed deleted by ADK.
     * Custom stores retain source compatibility through this no-op default.
     *
     * @param session session confirmed deleted
     * @return completion after local state is discarded
     */
    default Completable evict(Session session) {
        return Completable.complete();
    }
}
