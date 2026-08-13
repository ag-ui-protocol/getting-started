package com.agui.adk;

import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.InMemorySessionService;
import com.google.adk.sessions.Session;
import com.agui.adk.session.InMemoryThreadSessionMappingStore;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionStateKeys;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Audit finding M-29 — the direct public session contract of {@link SessionManager}, ported from
 * Python {@code SessionManager.get_or_create_session}: manage a session outside a full run with an
 * atomically seeded initial state, signal a negative scan is already known via {@code skipFind},
 * and read sessions directly by their backend identifier.
 */
class SessionManagerPublicSessionContractTest {

    private static final String APP = "app";
    private static final String USER = "user";
    private static final String THREAD = "thread-1";

    private SessionManager manager(AdkAgUiOptions options, BaseSessionService sessions) {
        return new SessionManager(sessions, new InMemoryMemoryService(),
                new InMemoryThreadSessionMappingStore(), options);
    }

    @Test
    void getOrCreateSessionSeedsInitialStateAndReturnsBackendId() {
        SessionManager manager = manager(AdkAgUiOptions.defaults(), new InMemorySessionService());

        ResolvedSession resolved = manager.getOrCreateSession(
                APP, USER, THREAD, Map.of("custom", "value"), false).blockingGet();

        assertThat(resolved.mapping().sessionId()).isNotBlank();
        assertThat(resolved.session().state().get("custom")).isEqualTo("value");
        assertThat(resolved.session().state().get(SessionStateKeys.THREAD_ID)).isEqualTo(THREAD);
        assertThat(resolved.session().state().get(SessionStateKeys.APP_NAME)).isEqualTo(APP);
        assertThat(resolved.session().state().get(SessionStateKeys.USER_ID)).isEqualTo(USER);
        // The resolved session is readable directly by its backend identifier afterwards.
        Session byBackendId = manager.getSession(APP, USER, resolved.mapping().sessionId()).blockingGet();
        assertThat(byBackendId.id()).isEqualTo(resolved.mapping().sessionId());
    }

    @Test
    void getOrCreateSessionIsIdempotentForExistingThreadAndKeepsPriorState() {
        SessionManager manager = manager(AdkAgUiOptions.defaults(), new InMemorySessionService());

        ResolvedSession first = manager.getOrCreateSession(
                APP, USER, THREAD, Map.of("custom", "value"), false).blockingGet();
        // A later get with different initial state must NOT overwrite the existing session.
        ResolvedSession second = manager.getOrCreateSession(
                APP, USER, THREAD, Map.of("custom", "other", "extra", 1), false).blockingGet();

        assertThat(second.mapping().sessionId()).isEqualTo(first.mapping().sessionId());
        assertThat(second.session().state().get("custom")).isEqualTo("value");
        assertThat(second.session().state().get("extra")).isNull();
    }

    @Test
    void skipFindBypassesTheThreadMarkerRecoveryScan() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        Session created = Session.builder("backend-1").appName(APP).userId(USER)
                .state(new ConcurrentHashMap<>()).build();
        when(sessions.listSessions(APP, USER))
                .thenThrow(new AssertionError("skipFind must bypass the list_sessions scan"));
        when(sessions.createSession(any(), any(), any(), any())).thenReturn(Single.just(created));
        when(sessions.getSession(eq(APP), eq(USER), eq("backend-1"), any())).thenReturn(Maybe.just(created));
        SessionManager manager = manager(AdkAgUiOptions.defaults(), sessions);

        ResolvedSession resolved = manager.getOrCreateSession(APP, USER, THREAD, null, true).blockingGet();

        assertThat(resolved.mapping().sessionId()).isEqualTo("backend-1");
        verify(sessions, never()).listSessions(APP, USER);
    }

    @Test
    void directIdModeUsesTheThreadIdAsTheBackendSessionId() {
        SessionManager manager = manager(new AdkAgUiOptions(true), new InMemorySessionService());

        ResolvedSession resolved = manager.getOrCreateSession(APP, USER, THREAD, Map.of(), false).blockingGet();

        assertThat(resolved.mapping().sessionId()).isEqualTo(THREAD);
        assertThat(manager.getSession(APP, USER, THREAD).blockingGet()).isNotNull();
    }
}
