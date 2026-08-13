package com.agui.adk.session;

import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;

import java.time.Instant;
import java.util.Collection;
import java.util.Objects;
import java.util.function.Function;

/** Selects expired sessions; applications explicitly schedule its cleanup operation. */
public final class SessionCleanupService {
    private final SessionCleanupPolicy policy;
    private final Function<Session, Completable> delete;

    /**
     * Creates cleanup with an explicit deletion operation that owns archival and mapping invalidation.
     *
     * @param policy explicit expiry and interval policy
     * @param delete ordered deletion operation
     */
    public SessionCleanupService(SessionCleanupPolicy policy, Function<Session, Completable> delete) {
        this.policy = Objects.requireNonNull(policy, "policy");
        this.delete = Objects.requireNonNull(delete, "delete");
    }

    /**
     * Deletes only sessions expired at the supplied reference time.
     *
     * @param sessions sessions selected by an application-owned listing operation
     * @param now deterministic cleanup reference time
     * @return completion after all selected deletions
     */
    public Completable cleanup(Collection<Session> sessions, Instant now) {
        Objects.requireNonNull(sessions, "sessions");
        Objects.requireNonNull(now, "now");
        return Flowable.fromIterable(sessions)
                .filter(Objects::nonNull)
                .filter(session -> policy.isExpired(session.lastUpdateTime(), now))
                .concatMapCompletable(session -> Completable.defer(() -> delete.apply(session)));
    }
}
