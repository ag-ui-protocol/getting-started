package com.agui.adk;

import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.Session;
import com.agui.adk.session.InMemoryThreadSessionMappingStore;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.observers.TestObserver;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** P1 #13 — per-user max-session eviction (Python `max_sessions_per_user`). */
@ExtendWith(MockitoExtension.class)
class SessionManagerMaxPerUserEvictionTest {

    @Mock
    private BaseSessionService sessionService;
    @Mock
    private BaseMemoryService memoryService;
    @Mock
    private RunContext runContext;

    private SessionManager newManager(Integer maxPerUser) {
        return new SessionManager(sessionService, memoryService, new InMemoryThreadSessionMappingStore(),
                new AdkAgUiOptions(false, Duration.ofMinutes(5), 1000, maxPerUser));
    }

    private static Session session(String id, Instant updated) {
        return Session.builder(id).appName("app").userId("user").state(new ConcurrentHashMap<>())
                .lastUpdateTime(updated).build();
    }

    @Test
    void evictsOldestSessionWhenUserAtCapBeforeCreating() {
        SessionManager sm = newManager(1);

        Session old = session("sess-old", Instant.now().minus(Duration.ofHours(1)));
        Session fresh = session("sess-new", Instant.now());
        sm.trackSession(old); // user now at the cap of 1

        when(runContext.appName()).thenReturn("app");
        when(runContext.userId()).thenReturn("user");
        when(runContext.sessionId()).thenReturn("sess-new");

        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-new"), any())).thenReturn(Maybe.empty());
        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-old"), any())).thenReturn(Maybe.just(old));
        when(sessionService.createSession(eq("app"), eq("user"), any(), eq("sess-new"))).thenReturn(Single.just(fresh));
        when(memoryService.addSessionToMemory(any())).thenReturn(Completable.complete());
        when(sessionService.deleteSession(eq("app"), eq("user"), eq("sess-old"))).thenReturn(Completable.complete());

        TestObserver<SessionManager.SessionWithProcessedIds> observer = new TestObserver<>();
        sm.getSessionAndProcessedMessageIds(runContext).subscribe(observer);

        observer.assertComplete().assertNoErrors();
        verify(sessionService).deleteSession("app", "user", "sess-old");
        verify(sessionService).createSession("app", "user", null, "sess-new");
        assertThat(observer.values()).hasSize(1);
        assertThat(observer.values().get(0).session().id()).isEqualTo("sess-new");
    }

    @Test
    void noEvictionWhenUnlimited() {
        SessionManager sm = newManager(null); // unlimited

        Session old = session("sess-old", Instant.now().minus(Duration.ofHours(1)));
        Session fresh = session("sess-new", Instant.now());
        sm.trackSession(old);

        when(runContext.appName()).thenReturn("app");
        when(runContext.userId()).thenReturn("user");
        when(runContext.sessionId()).thenReturn("sess-new");

        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-new"), any())).thenReturn(Maybe.empty());
        when(sessionService.createSession(eq("app"), eq("user"), any(), eq("sess-new"))).thenReturn(Single.just(fresh));

        TestObserver<SessionManager.SessionWithProcessedIds> observer = new TestObserver<>();
        sm.getSessionAndProcessedMessageIds(runContext).subscribe(observer);

        observer.assertComplete().assertNoErrors();
        verify(sessionService, never()).deleteSession(any(), any(), any());
        assertThat(observer.values().get(0).session().id()).isEqualTo("sess-new");
    }

    @Test
    void doesNotEvictWhenUserBelowCap() {
        SessionManager sm = newManager(5);

        Session old = session("sess-old", Instant.now().minus(Duration.ofHours(1)));
        Session fresh = session("sess-new", Instant.now());
        sm.trackSession(old); // 1 of 5

        when(runContext.appName()).thenReturn("app");
        when(runContext.userId()).thenReturn("user");
        when(runContext.sessionId()).thenReturn("sess-new");

        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-new"), any())).thenReturn(Maybe.empty());
        when(sessionService.createSession(eq("app"), eq("user"), any(), eq("sess-new"))).thenReturn(Single.just(fresh));

        TestObserver<SessionManager.SessionWithProcessedIds> observer = new TestObserver<>();
        sm.getSessionAndProcessedMessageIds(runContext).subscribe(observer);

        observer.assertComplete().assertNoErrors();
        verify(sessionService, never()).deleteSession(any(), any(), any());
    }
}
