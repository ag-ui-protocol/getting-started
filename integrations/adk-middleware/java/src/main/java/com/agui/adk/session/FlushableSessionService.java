package com.agui.adk.session;

import io.reactivex.rxjava3.core.Completable;

/**
 * Optional flush capability of a write-behind {@link com.google.adk.sessions.BaseSessionService}.
 *
 * <p>google-adk 1.7.0's {@code BaseSessionService} declares no {@code flush} method, so a
 * custom write-behind session service opts in through this marker to have buffered state
 * flushed through {@link RequestStateSessionService#flush()} — the Java port of the Python
 * duck-typed {@code getattr(inner, "flush", None)} delegation (issue #2206, finding m-03).
 */
public interface FlushableSessionService {

    /**
     * Persists any buffered write-behind state.
     *
     * @return completion when buffered state is flushed
     */
    Completable flush();
}
