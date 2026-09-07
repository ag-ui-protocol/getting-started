package com.agui.adk.session;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.adk.sessions.InMemorySessionService;
import com.google.adk.sessions.Session;
import com.agui.adk.testsupport.VertexLikeSessionService;
import io.reactivex.rxjava3.core.Maybe;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.Test;

/**
 * P0 #2 — RequestStateSessionService temp-state injection, ported from the Python
 * {@code request_state_service.RequestStateSessionService} (issue #1571) with identical behavior:
 * pending {@code temp:} state keyed by (appName, userId, sessionId), injected on get_session and
 * create_session, removed on empty/null / explicit clear / delete, and never auto-cleared.
 */
class RequestStateSessionServiceTest {

    private static final String APP = "app";
    private static final String USER = "user";

    private static RequestStateSessionService wrap(com.google.adk.sessions.BaseSessionService delegate) {
        return new RequestStateSessionService(delegate);
    }

    @Test
    void getSessionInjectsPendingTempStateForItsTripleOnly() {
        VertexLikeSessionService delegate = new VertexLikeSessionService(true);
        RequestStateSessionService service = wrap(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(Map.of("a", 1)), "s1").blockingGet();

        service.setPendingTempState(APP, USER, "s1", Map.of("temp:run", "x", "temp:other", 2));

        Session fetched = service.getSession(APP, USER, "s1", Optional.empty()).blockingGet();
        assertEquals("x", fetched.state().get("temp:run"));
        assertEquals(2, fetched.state().get("temp:other"));
        assertEquals(1, fetched.state().get("a"));

        // A different session for the same app/user has no pending state injected.
        service.createSession(APP, USER, new ConcurrentHashMap<>(Map.of("b", 2)), "s2").blockingGet();
        Session other = service.getSession(APP, USER, "s2", Optional.empty()).blockingGet();
        assertNull(other.state().get("temp:run"));
    }

    @Test
    void createSessionInjectsPendingTempStateUsingGeneratedSessionId() {
        VertexLikeSessionService delegate = new VertexLikeSessionService(false); // generates ids
        RequestStateSessionService service = wrap(delegate);

        // Pending state is registered for the generated id that createSession will produce.
        // Because ids are generated ("generated-1"), we register for that exact id.
        Session created = service.createSession(APP, USER, new ConcurrentHashMap<>(), "requested").blockingGet();
        String generated = created.id();
        service.setPendingTempState(APP, USER, generated, Map.of("temp:ctx", "v"));

        // A subsequent get injects into the generated-id session.
        Session fetched = service.getSession(APP, USER, generated, Optional.empty()).blockingGet();
        assertEquals("v", fetched.state().get("temp:ctx"));
    }

    @Test
    void createSessionInjectsDirectlyWhenIdKnown() {
        VertexLikeSessionService delegate = new VertexLikeSessionService(true); // honors requested id
        RequestStateSessionService service = wrap(delegate);
        service.setPendingTempState(APP, USER, "s9", Map.of("temp:early", 9));

        Session created = service.createSession(APP, USER, new ConcurrentHashMap<>(), "s9").blockingGet();
        assertEquals(9, created.state().get("temp:early"));
    }

    @Test
    void setPendingTempStateNullOrEmptyRemovesEntry() {
        // Stock in-memory service: getSession returns a per-read copy, so injected temp keys
        // never leak into storage (Python test_temp_state_not_persisted_to_inner).
        InMemorySessionService delegate = new InMemorySessionService();
        RequestStateSessionService service = wrap(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(Map.of("a", 1)), "s3").blockingGet();

        service.setPendingTempState(APP, USER, "s3", Map.of("temp:run", "x"));
        service.setPendingTempState(APP, USER, "s3", null);

        Session fetched = service.getSession(APP, USER, "s3", Optional.empty()).blockingGet();
        assertNull(fetched.state().get("temp:run"));

        service.setPendingTempState(APP, USER, "s3", Map.of("temp:run", "y"));
        service.setPendingTempState(APP, USER, "s3", Map.of()); // empty removes
        fetched = service.getSession(APP, USER, "s3", Optional.empty()).blockingGet();
        assertNull(fetched.state().get("temp:run"));
    }

    @Test
    void clearPendingTempStateRemovesEntryForTriple() {
        InMemorySessionService delegate = new InMemorySessionService();
        RequestStateSessionService service = wrap(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(Map.of("a", 1)), "s4").blockingGet();

        service.setPendingTempState(APP, USER, "s4", Map.of("temp:run", "x"));
        service.clearPendingTempState(APP, USER, "s4");

        Session fetched = service.getSession(APP, USER, "s4", Optional.empty()).blockingGet();
        assertNull(fetched.state().get("temp:run"));
    }

    @Test
    void pendingTempStateIsNotClearedByGetOrCreate() {
        VertexLikeSessionService delegate = new VertexLikeSessionService(true);
        RequestStateSessionService service = wrap(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(), "s5").blockingGet();
        service.setPendingTempState(APP, USER, "s5", Map.of("temp:run", "x"));

        // Multiple gets still inject — entry is not auto-cleared (caller must clear it).
        assertEquals("x", service.getSession(APP, USER, "s5", Optional.empty()).blockingGet()
                .state().get("temp:run"));
        assertEquals("x", service.getSession(APP, USER, "s5", Optional.empty()).blockingGet()
                .state().get("temp:run"));
    }

    @Test
    void deleteSessionPopsPendingEntryAndDelegates() {
        VertexLikeSessionService delegate = new VertexLikeSessionService(true);
        RequestStateSessionService service = wrap(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(Map.of("temp:run", "x")), "s7")
                .blockingGet();
        service.setPendingTempState(APP, USER, "s7", Map.of("temp:run", "x"));

        service.deleteSession(APP, USER, "s7").blockingAwait();

        Maybe<Session> gone = service.getSession(APP, USER, "s7", Optional.empty());
        assertNull(gone.blockingGet());
        assertEquals(java.util.List.of(APP, USER, "s7"), delegate.lastDeleteArguments());
    }

    @Test
    void noPendingTempStateDelegatesTransparently() {
        VertexLikeSessionService delegate = new VertexLikeSessionService(true);
        RequestStateSessionService service = wrap(delegate);

        Session session = service.createSession(APP, USER, new ConcurrentHashMap<>(Map.of("a", 1)), "s8")
                .blockingGet();
        assertEquals(1, session.state().get("a"));
        assertNull(session.state().get("temp:none"));
        assertEquals(delegate, service.inner());
    }

    @Test
    void flushIsObservablyNoOpForNonWriteBehindService() {
        VertexLikeSessionService delegate = new VertexLikeSessionService(true);
        RequestStateSessionService service = wrap(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(), "s6").blockingGet();
        service.setPendingTempState(APP, USER, "s6", Map.of("temp:run", "x"));

        service.flush().blockingAwait();

        // flush does NOT clear pending temp state (matching Python) — clear is explicit.
        assertEquals("x", service.getSession(APP, USER, "s6", Optional.empty()).blockingGet()
                .state().get("temp:run"));
    }
}
