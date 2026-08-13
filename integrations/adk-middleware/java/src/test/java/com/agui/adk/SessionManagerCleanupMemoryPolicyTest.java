package com.agui.adk;

import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import com.agui.adk.session.InMemoryThreadSessionMappingStore;
import com.agui.adk.session.SessionCleanupPolicy;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Audit findings M-09/M-21 — independent, configurable cleanup and memory-ingestion policies,
 * ported from Python {@code SessionManager}: {@code delete_session_on_cleanup} and
 * {@code save_session_to_memory_on_cleanup} are configured independently on
 * {@link AdkAgUiOptions}, a memory failure never blocks the deletion attempt, and archive-only
 * mode keeps the backend session but stops tracking it so a later cleanup cycle never re-archives
 * it.
 */
@ExtendWith(MockitoExtension.class)
class SessionManagerCleanupMemoryPolicyTest {

    @Mock
    private BaseSessionService sessionService;
    @Mock
    private BaseMemoryService memoryService;

    private static Session session(String id, Instant updated) {
        return Session.builder(id).appName("app").userId("user")
                .state(new ConcurrentHashMap<>()).lastUpdateTime(updated).build();
    }

    private SessionManager manager(AdkAgUiOptions options) {
        return new SessionManager(sessionService, memoryService,
                new InMemoryThreadSessionMappingStore(), options);
    }

    @Test
    void archiveOnlyModeIngestsMemoryKeepsBackendSessionAndStopsTracking() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("sess-archived", now.minus(Duration.ofHours(2)));
        when(sessionService.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()));
        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-archived"), any()))
                .thenReturn(Maybe.just(expired));
        when(memoryService.addSessionToMemory(expired)).thenReturn(Completable.complete());
        SessionManager manager = manager(AdkAgUiOptions.defaults().withDeleteSessionOnCleanup(false));
        manager.trackSession(expired);
        assertThat(manager.getSessionCount()).isEqualTo(1);

        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15));
        manager.cleanupExpiredSessions("app", "user", policy, now).blockingAwait();

        // Python archive-only: memory ingestion happened, session deletion did not.
        verify(memoryService).addSessionToMemory(expired);
        verify(sessionService, never()).deleteSession(eq("app"), eq("user"), eq("sess-archived"));
        // The session stays in the backend but is untracked (Python _untrack_session).
        assertThat(manager.getSessionCount()).isZero();
    }

    @Test
    void archiveOnlyModeDoesNotReArchiveOnLaterCleanupCycle() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("sess-archived", now.minus(Duration.ofHours(2)));
        when(sessionService.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()));
        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-archived"), any()))
                .thenReturn(Maybe.just(expired));
        when(memoryService.addSessionToMemory(expired)).thenReturn(Completable.complete());
        SessionManager manager = manager(AdkAgUiOptions.defaults().withDeleteSessionOnCleanup(false));
        manager.trackSession(expired);
        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15));

        manager.cleanupExpiredSessions("app", "user", policy, now).blockingAwait();
        manager.cleanupExpiredSessions("app", "user", policy, now.plus(Duration.ofHours(3))).blockingAwait();

        verify(memoryService).addSessionToMemory(expired);
        verify(sessionService, never()).deleteSession(eq("app"), eq("user"), eq("sess-archived"));
    }

    @Test
    void deleteWithoutMemorySkipsMemoryIngestion() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("sess-deleted", now.minus(Duration.ofHours(2)));
        when(sessionService.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()));
        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-deleted"), any()))
                .thenReturn(Maybe.just(expired));
        when(sessionService.deleteSession("app", "user", "sess-deleted")).thenReturn(Completable.complete());
        SessionManager manager = manager(AdkAgUiOptions.defaults().withSaveSessionToMemoryOnCleanup(false));

        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15));
        manager.cleanupExpiredSessions("app", "user", policy, now).blockingAwait();

        verify(sessionService).deleteSession("app", "user", "sess-deleted");
        verify(memoryService, never()).addSessionToMemory(any());
    }

    @Test
    void memoryFailureNeverPreventsTheDeletionAttempt() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("sess-deleted", now.minus(Duration.ofHours(2)));
        when(sessionService.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()));
        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-deleted"), any()))
                .thenReturn(Maybe.just(expired));
        when(memoryService.addSessionToMemory(expired))
                .thenReturn(Completable.error(new IllegalStateException("memory down")));
        when(sessionService.deleteSession("app", "user", "sess-deleted")).thenReturn(Completable.complete());
        SessionManager manager = manager(AdkAgUiOptions.defaults());

        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15));
        // Python _delete_session catches the memory error and still deletes; the cleanup must
        // complete successfully (previously andThen chaining aborted the deletion).
        manager.cleanupExpiredSessions("app", "user", policy, now).blockingAwait();

        verify(memoryService).addSessionToMemory(expired);
        verify(sessionService).deleteSession("app", "user", "sess-deleted");
    }

    @Test
    void perUserEvictionAppliesTheSameIndependentPolicies() {
        // Python _remove_oldest_user_session routes through _delete_session, so archive-only mode
        // must ingest the evicted session into memory without deleting it from the backend.
        Session old = session("sess-old", Instant.now().minus(Duration.ofHours(2)));
        Session created = Session.builder("sess-new").appName("app").userId("user")
                .state(new ConcurrentHashMap<>()).build();
        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-old"), any()))
                .thenReturn(Maybe.just(old));
        when(memoryService.addSessionToMemory(old)).thenReturn(Completable.complete());
        when(sessionService.createSession(any(), any(), any(), any())).thenReturn(Single.just(created));
        AdkAgUiOptions options = AdkAgUiOptions.defaults()
                .withDeleteSessionOnCleanup(false)
                .withMaxSessionsPerUser(1);
        SessionManager manager = manager(options);
        manager.trackSession(old);

        manager.getOrCreateSession("app", "user", "thread-new", null, true).blockingGet();

        verify(memoryService).addSessionToMemory(old);
        verify(sessionService, never()).deleteSession(eq("app"), eq("user"), eq("sess-old"));
        assertThat(manager.getSessionCount()).isEqualTo(1);
    }
}
