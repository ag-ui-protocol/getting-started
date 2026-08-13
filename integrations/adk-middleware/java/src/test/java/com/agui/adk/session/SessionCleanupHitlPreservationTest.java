package com.agui.adk.session;

import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import com.agui.adk.SessionManager;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.junit.jupiter.api.extension.ExtendWith;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** P1 #13 — HITL preservation in session cleanup (Python `_cleanup_expired_sessions`). */
@ExtendWith(MockitoExtension.class)
class SessionCleanupHitlPreservationTest {

    @Mock
    private BaseSessionService sessionService;
    @Mock
    private BaseMemoryService memoryService;

    private static Session session(String id, Instant updated, boolean pending) {
        Session s = Session.builder(id).appName("app").userId("user")
                .state(new ConcurrentHashMap<>()).lastUpdateTime(updated).build();
        if (pending) {
            s.state().put("pendingToolCallIds", List.of("call-1"));
        }
        return s;
    }

    private SessionManager manager() {
        return new SessionManager(sessionService, memoryService,
                new InMemoryThreadSessionMappingStore(), new com.agui.adk.AdkAgUiOptions(false));
    }

    @Test
    void pendingHitlSessionIsPreservedWithinWaitWindow() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Instant expired = now.minus(Duration.ofHours(2));
        Session hitl = session("sess-hitl", expired, true);

        when(sessionService.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(hitl)).build()));
        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-hitl"), any())).thenReturn(Maybe.just(hitl));

        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15),
                Duration.ofMinutes(10)); // wait window not yet exceeded on first run

        manager().cleanupExpiredSessions("app", "user", policy, now).blockingAwait();

        verify(sessionService, never()).deleteSession(eq("app"), eq("user"), eq("sess-hitl"));
    }

    @Test
    void pendingHitlSessionDeletedAfterWaitWindow() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Instant expired = now.minus(Duration.ofHours(2));
        Session hitl = session("sess-hitl", expired, true);
        SessionManager manager = manager();

        when(sessionService.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(hitl)).build()));
        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-hitl"), any())).thenReturn(Maybe.just(hitl));
        when(memoryService.addSessionToMemory(any())).thenReturn(Completable.complete());
        when(sessionService.deleteSession("app", "user", "sess-hitl")).thenReturn(Completable.complete());

        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15),
                Duration.ofMinutes(10));
        // First run marks preserved-since and preserves (within wait).
        manager.cleanupExpiredSessions("app", "user", policy, now).blockingAwait();
        verify(sessionService, never()).deleteSession(eq("app"), eq("user"), eq("sess-hitl"));

        // Second run far enough later: preservation window exceeded -> forced delete.
        manager.cleanupExpiredSessions("app", "user", policy, now.plus(Duration.ofMinutes(20))).blockingAwait();
        verify(sessionService).deleteSession("app", "user", "sess-hitl");
    }

    @Test
    void sessionWithoutPendingCallsIsDeletedNormally() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session stale = session("sess-stale", now.minus(Duration.ofHours(2)), false);

        when(sessionService.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(stale)).build()));
        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-stale"), any())).thenReturn(Maybe.just(stale));
        when(memoryService.addSessionToMemory(any())).thenReturn(Completable.complete());
        when(sessionService.deleteSession("app", "user", "sess-stale")).thenReturn(Completable.complete());

        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15),
                Duration.ofMinutes(10));
        manager().cleanupExpiredSessions("app", "user", policy, now).blockingAwait();

        verify(sessionService).deleteSession("app", "user", "sess-stale");
    }
}
