package com.agui.adk.session;

import com.google.adk.events.Event;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.GetSessionConfig;
import com.google.adk.sessions.ListEventsResponse;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Transparently proxies an ADK {@link BaseSessionService}, injecting per-invocation
 * {@code temp:} state into the session returned for a specific
 * {@code (appName, userId, sessionId)} triple.
 *
 * <p>This is a faithful port of the Python bridge's
 * {@code request_state_service.RequestStateSessionService} (issue #1571). Because every stock
 * session service strips {@code temp:}-prefixed keys before persisting them, {@code temp:} state
 * produced outside an invocation cannot reach the agent's {@code tool_context.state} through the
 * normal {@code append_event} path. This wrapper merges pending {@code temp:} state into the
 * session returned by {@link #getSession} / {@link #createSession}; all other calls are forwarded
 * verbatim, so the wrapper is transparent when no pending state is registered.
 *
 * <p>Pending state is registered per {@code (appName, userId, sessionId)} triple and is <em>not</em>
 * cleared automatically: callers must call {@link #clearPendingTempState} once the invocation has
 * finished so later invocations do not inherit stale values.
 */
public final class RequestStateSessionService implements BaseSessionService {

    /** Immutable identity key of a pending-temp-state entry. */
    private record PendingKey(String appName, String userId, String sessionId) {
        /**
         * Defensive-nullability check for all identity components.
         *
         * @param appName Google ADK application name
         * @param userId Google ADK user identifier
         * @param sessionId Google ADK session identifier
         */
        private PendingKey {
            appName = Objects.requireNonNull(appName, "appName");
            userId = Objects.requireNonNull(userId, "userId");
            sessionId = Objects.requireNonNull(sessionId, "sessionId");
        }
    }

    private final BaseSessionService inner;
    private final ConcurrentMap<PendingKey, Map<String, Object>> pendingTempState =
            new ConcurrentHashMap<>();

    /**
     * Creates the wrapper around the given session service.
     *
     * @param inner wrapped session service
     */
    public RequestStateSessionService(BaseSessionService inner) {
        this.inner = Objects.requireNonNull(inner, "inner");
    }

    /** @return the wrapped session service */
    public BaseSessionService inner() {
        return inner;
    }

    /**
     * Registers {@code temp:} state to inject on the next {@link #getSession} call for the triple.
     * Passing an empty map or {@code null} removes any existing pending state for the triple.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     * @param tempState pending temp state (empty/null removes)
     */
    public void setPendingTempState(String appName, String userId, String sessionId,
                                    Map<String, Object> tempState) {
        PendingKey key = new PendingKey(appName, userId, sessionId);
        if (tempState != null && !tempState.isEmpty()) {
            // A LinkedHashMap copy accepts null values like Python's dict(temp_state);
            // Map.copyOf would reject them before the invocation even starts (m-01). The
            // null-valued keys themselves cannot be carried into a stock ADK session state
            // map (see inject / RequestStateSessionServiceNullValueProofTest); they are
            // accepted here so the invocation is never rejected, then omitted on injection.
            pendingTempState.put(key, new LinkedHashMap<>(tempState));
        } else {
            pendingTempState.remove(key);
        }
    }

    /**
     * Removes any pending {@code temp:} state for the given triple.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     */
    public void clearPendingTempState(String appName, String userId, String sessionId) {
        pendingTempState.remove(new PendingKey(appName, userId, sessionId));
    }

    /**
     * Injects pending {@code temp:} state into a session by mutating the session's own state
     * map in place and returning the same instance, mirroring Python {@code _inject}
     * (m-02): references held by the inner service or caller observe the injected state, so
     * identity-sensitive behavior matches the Python bridge. Persistence stays untouched
     * because stock ADK session services return per-read copies and strip {@code temp:}
     * keys when writing.
     *
     * <p><strong>m-01 null values — documented divergence, impossible with stock ADK.</strong>
     * Python's {@code _inject} performs {@code session.state[k] = v} unconditionally, so a
     * {@code temp:*} = {@code None} pending entry makes the key observable with a {@code None}
     * value. Stock google-adk 1.7.0 cannot represent that: {@link Session#state()} is
     * {@code com.google.adk.sessions.State}, a {@code ConcurrentMap} whose backing map and
     * delta map are {@code ConcurrentHashMap}s, so {@code put(k, null)} throws
     * {@link NullPointerException} (proved in {@code RequestStateSessionServiceNullValueProofTest});
     * {@code State}'s own copy constructor substitutes its internal {@code REMOVED} tombstone
     * for null values, and {@code InMemorySessionService} re-wraps state in a fresh
     * {@code ConcurrentHashMap} on every read. Carrying the key with a null value would
     * therefore require forking the ADK {@code Session}/{@code State} implementation. The
     * wrapper instead skips null-valued keys: the key is absent (never a crash), and
     * {@code Map.get} still returns {@code null} exactly like Python's {@code None} on the
     * primary read path, while {@code containsKey}/{@code keySet} observably differ. This is
     * the honest boundary: no claim of parity for null values.
     *
     * @param session fetched/created session
     * @param key pending entry key
     * @return the same session with merged temp state, or {@code null} when the session is {@code null}
     */
    private Session inject(Session session, PendingKey key) {
        if (session == null) {
            return null;
        }
        Map<String, Object> tempState = pendingTempState.get(key);
        if (tempState == null || tempState.isEmpty()) {
            return session;
        }
        tempState.forEach((name, value) -> {
            if (value != null) {
                session.state().put(name, value);
            }
        });
        return session;
    }

    @Override
    public Single<Session> createSession(
            String appName, String userId, ConcurrentMap<String, Object> state, String sessionId) {
        return inner.createSession(appName, userId, state, sessionId)
                .map(session -> inject(session, new PendingKey(appName, userId, session.id())));
    }

    @Override
    public Maybe<Session> getSession(
            String appName, String userId, String sessionId, Optional<GetSessionConfig> config) {
        return inner.getSession(appName, userId, sessionId, config)
                .map(session -> inject(session, new PendingKey(appName, userId, sessionId)));
    }

    @Override
    public Single<ListSessionsResponse> listSessions(String appName, String userId) {
        return inner.listSessions(appName, userId);
    }

    @Override
    public Completable deleteSession(String appName, String userId, String sessionId) {
        pendingTempState.remove(new PendingKey(appName, userId, sessionId));
        return inner.deleteSession(appName, userId, sessionId);
    }

    @Override
    public Single<ListEventsResponse> listEvents(String appName, String userId, String sessionId) {
        return inner.listEvents(appName, userId, sessionId);
    }

    @Override
    public Single<Event> appendEvent(Session session, Event event) {
        return inner.appendEvent(session, event);
    }

    /**
     * Delegates to the inner service's write-behind flush, matching Python #2206 (m-03):
     * when the inner session service exposes the {@link FlushableSessionService} capability
     * its flush is awaited; otherwise there is no buffered state and this is an observable
     * no-op. It does <em>not</em> clear pending temp state — that is
     * {@link #clearPendingTempState}'s job, mirroring the Python implementation.
     *
     * @return completion signal
     */
    public Completable flush() {
        if (inner instanceof FlushableSessionService flushable) {
            return flushable.flush();
        }
        return Completable.complete();
    }
}
