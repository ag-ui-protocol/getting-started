package com.agui.adk.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertSame;

import com.google.adk.sessions.InMemorySessionService;
import com.google.adk.sessions.Session;
import com.agui.adk.testsupport.VertexLikeSessionService;
import io.reactivex.rxjava3.core.Completable;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

/**
 * Audit findings m-01/m-02/m-03 — the {@code RequestStateSessionService} parity gap with the
 * Python {@code request_state_service.RequestStateSessionService}:
 *
 * <ul>
 *   <li>m-01: a {@code temp:*} = null value is accepted instead of rejected by
 *       {@code Map.copyOf} before the invocation. Full null-value carriage (key observable
 *       with null) is impossible with stock ADK — see
 *       {@link RequestStateSessionServiceNullValueProofTest} for the ConcurrentMap
 *       prohibition proof; the wrapper skips null-valued keys so the invocation never
 *       crashes, and {@code Map.get} still returns null on the primary read path;</li>
 *   <li>m-02: temp injection mutates the inner session's state in place and returns the same
 *       instance, so references held by the inner observe the injected state;</li>
 *   <li>m-03: {@code flush()} delegates to a write-behind inner service instead of being a
 *       silent no-op.</li>
 * </ul>
 */
class RequestStateSessionServiceParityTest {

    private static final String APP = "app";
    private static final String USER = "user";

    @Test
    void nullTempValuesAreAcceptedAndNeverRejectTheInvocation() {
        VertexLikeSessionService delegate = new VertexLikeSessionService(true);
        RequestStateSessionService service = new RequestStateSessionService(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(Map.of("a", 1)), "s1").blockingGet();

        // Map.copyOf previously threw NullPointerException here (m-01); LinkedHashMap accepts
        // the null value, so registration no longer rejects the invocation.
        Map<String, Object> tempWithNull = new HashMap<>();
        tempWithNull.put("temp:token", "abc");
        tempWithNull.put("temp:optional", null);
        assertDoesNotThrow(() -> service.setPendingTempState(APP, USER, "s1", tempWithNull));

        // Injection must not crash on the null-valued key; the non-null value still reaches
        // the fetched session. The null-valued key is omitted (stock ADK State cannot hold
        // null values — see RequestStateSessionServiceNullValueProofTest); this test only
        // proves the no-crash half of m-01, never value-carriage parity.
        Session fetched = service.getSession(APP, USER, "s1", Optional.empty()).blockingGet();
        assertThat(fetched.state().get("temp:token")).isEqualTo("abc");
        assertThat(fetched.state().get("a")).isEqualTo(1);
    }

    @Test
    void nullTempValueSurvivesUntilClearedAndNeverBreaksLaterInvocation() {
        InMemorySessionService delegate = new InMemorySessionService();
        RequestStateSessionService service = new RequestStateSessionService(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(Map.of("a", 1)), "s1").blockingGet();

        Map<String, Object> tempWithNull = new HashMap<>();
        tempWithNull.put("temp:token", "abc");
        tempWithNull.put("temp:optional", null);
        service.setPendingTempState(APP, USER, "s1", tempWithNull);

        assertThat(service.getSession(APP, USER, "s1", Optional.empty()).blockingGet()
                .state().get("temp:token")).isEqualTo("abc");
        service.clearPendingTempState(APP, USER, "s1");
        assertThatCode(() -> service.getSession(APP, USER, "s1", Optional.empty()).blockingGet())
                .doesNotThrowAnyException();
    }

    @Test
    void injectionMutatesTheInnerSessionInPlacePreservingIdentity() {
        // Non-copying delegate: the stored session object is the session returned by get.
        VertexLikeSessionService delegate = new VertexLikeSessionService(true);
        RequestStateSessionService service = new RequestStateSessionService(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(Map.of("a", 1)), "s1").blockingGet();
        Session heldByInner = delegate.getSession(APP, USER, "s1", Optional.empty()).blockingGet();

        service.setPendingTempState(APP, USER, "s1", Map.of("temp:run", "x"));

        Session fetched = service.getSession(APP, USER, "s1", Optional.empty()).blockingGet();
        // Same identity: the wrapper mutated the inner session's state in place (m-02).
        assertSame(fetched, heldByInner);
        // The reference kept by the inner observes the injected state (m-02).
        assertThat(heldByInner.state().get("temp:run")).isEqualTo("x");
        // A second fetch sees the same injected state.
        assertThat(service.getSession(APP, USER, "s1", Optional.empty()).blockingGet()
                .state().get("temp:run")).isEqualTo("x");
    }

    @Test
    void flushDelegatesToAWriteBehindInnerService() {
        AtomicBoolean flushed = new AtomicBoolean();
        FlushableSessionService flushable = () -> Completable.fromAction(() -> flushed.set(true));
        RequestStateSessionService service = new RequestStateSessionService(new WriteBehindInner(flushable));
        service.createSession(APP, USER, new ConcurrentHashMap<>(), "s1").blockingGet();

        service.flush().blockingAwait();

        assertThat(flushed).isTrue();
    }

    @Test
    void flushNeverClearsPendingTempStateAndStaysNoOpWithoutAWriteBehindInner() {
        InMemorySessionService delegate = new InMemorySessionService();
        RequestStateSessionService service = new RequestStateSessionService(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(), "s1").blockingGet();
        service.setPendingTempState(APP, USER, "s1", Map.of("temp:run", "x"));

        service.flush().blockingAwait();

        // flush does NOT clear pending temp state (matching Python) — clear is explicit.
        assertThat(service.getSession(APP, USER, "s1", Optional.empty()).blockingGet()
                .state().get("temp:run")).isEqualTo("x");
    }

    /** A session service that forwards to an in-memory store and exposes a write-behind flush capability. */
    private static final class WriteBehindInner implements com.google.adk.sessions.BaseSessionService,
            FlushableSessionService {
        private final InMemorySessionService delegate = new InMemorySessionService();
        private final FlushableSessionService flushable;

        private WriteBehindInner(FlushableSessionService flushable) {
            this.flushable = flushable;
        }

        @Override
        public io.reactivex.rxjava3.core.Single<Session> createSession(String appName, String userId,
                java.util.concurrent.ConcurrentMap<String, Object> state, String sessionId) {
            return delegate.createSession(appName, userId, state, sessionId);
        }

        @Override
        public io.reactivex.rxjava3.core.Maybe<Session> getSession(String appName, String userId,
                String sessionId, Optional<com.google.adk.sessions.GetSessionConfig> config) {
            return delegate.getSession(appName, userId, sessionId, config);
        }

        @Override
        public io.reactivex.rxjava3.core.Single<com.google.adk.sessions.ListSessionsResponse> listSessions(
                String appName, String userId) {
            return delegate.listSessions(appName, userId);
        }

        @Override
        public io.reactivex.rxjava3.core.Completable deleteSession(String appName, String userId, String sessionId) {
            return delegate.deleteSession(appName, userId, sessionId);
        }

        @Override
        public io.reactivex.rxjava3.core.Single<com.google.adk.sessions.ListEventsResponse> listEvents(
                String appName, String userId, String sessionId) {
            return delegate.listEvents(appName, userId, sessionId);
        }

        @Override
        public io.reactivex.rxjava3.core.Single<com.google.adk.events.Event> appendEvent(Session session,
                com.google.adk.events.Event event) {
            return delegate.appendEvent(session, event);
        }

        @Override
        public Completable flush() {
            return flushable.flush();
        }
    }
}
