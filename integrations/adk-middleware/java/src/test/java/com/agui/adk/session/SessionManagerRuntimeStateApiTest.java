package com.agui.adk.session;

import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.Session;
import com.agui.adk.AdkAgUiOptions;
import com.agui.adk.SessionManager;
import com.agui.adk.SessionManager.ReadCacheToken;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.context.RequestResourceRegistry;
import com.agui.adk.execution.CancellationToken;
import com.agui.adk.hitl.ToolCallLedger;
import com.agui.community.core.agent.RunAgentInput;
import io.reactivex.rxjava3.core.Maybe;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SessionManagerRuntimeStateApiTest {

    @Mock private BaseSessionService sessionService;
    @Mock private BaseMemoryService memoryService;

    private SessionManager manager;

    private SessionManager directIdManager() {
        return new SessionManager(sessionService, memoryService,
                new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
    }

    @AfterEach
    void tearDown() {
        SessionManager.resetDefault();
    }

    private static Session session(String id) {
        return Session.builder(id).appName("app").userId("alice")
                .state(new ConcurrentHashMap<String, Object>()).build();
    }

    private static AdkAgUiRunContext context(String userId, String threadId) {
        return new AdkAgUiRunContext("app", userId, threadId, "run", null, threadId,
                new RunAgentInput(threadId, "run", Map.of(), List.of(), List.of(), List.of(), Map.of()),
                List.of(), new ToolCallLedger(), new CancellationToken(), RequestResourceRegistry.create(), "invocation");
    }

    @Test
    void startedReadCacheServesRepeatedSessionReadsWithoutHittingTheService() {
        manager = directIdManager();
        when(sessionService.getSession("app", "alice", "thread", java.util.Optional.empty()))
                .thenReturn(Maybe.just(session("thread")));

        ReadCacheToken token = manager.startSessionReadCache();
        try {
            manager.resolveSession(context("alice", "thread")).blockingGet();
            manager.resolveSession(context("alice", "thread")).blockingGet();
        } finally {
            manager.stopSessionReadCache(token);
        }

        // The second resolution is served from the per-execution cache: one service read total.
        verify(sessionService, times(1)).getSession("app", "alice", "thread", java.util.Optional.empty());
        assertThat(manager.resolveSession(context("alice", "thread")).blockingGet().session().id())
                .isEqualTo("thread");
    }

    @Test
    void authoritativeSessionReadBypassesActiveCacheAndReturnsFreshSession() {
        manager = directIdManager();
        Session stale = session("thread");
        Session fresh = Session.builder("thread").appName("app").userId("alice")
                .state(new ConcurrentHashMap<>(Map.of("status", "done"))).build();
        when(sessionService.getSession("app", "alice", "thread", java.util.Optional.empty()))
                .thenReturn(Maybe.just(stale), Maybe.just(fresh));

        ReadCacheToken token = manager.startSessionReadCache();
        try {
            assertThat(manager.getSession("app", "alice", "thread").blockingGet()).isSameAs(stale);
            assertThat(manager.getAuthoritativeSession("app", "alice", "thread").blockingGet())
                    .isSameAs(fresh);
        } finally {
            manager.stopSessionReadCache(token);
        }

        verify(sessionService, times(2)).getSession(
                "app", "alice", "thread", java.util.Optional.empty());
    }

    @Test
    void invalidateSessionForcesACacheRefreshOnTheNextRead() {
        manager = directIdManager();
        when(sessionService.getSession("app", "alice", "thread", java.util.Optional.empty()))
                .thenReturn(Maybe.just(session("thread")));

        ReadCacheToken token = manager.startSessionReadCache();
        try {
            manager.resolveSession(context("alice", "thread")).blockingGet();
            manager.invalidateSession("app", "alice", "thread");
            manager.resolveSession(context("alice", "thread")).blockingGet();
        } finally {
            manager.stopSessionReadCache(token);
        }

        verify(sessionService, times(2)).getSession("app", "alice", "thread", java.util.Optional.empty());
    }

    @Test
    void disabledReadCacheReadsDirectlyWithoutCaching() {
        manager = directIdManager();
        when(sessionService.getSession("app", "alice", "thread", java.util.Optional.empty()))
                .thenReturn(Maybe.just(session("thread")));

        ReadCacheToken token = manager.startSessionReadCache();
        try {
            manager.disableSessionReadCache();
            manager.resolveSession(context("alice", "thread")).blockingGet();
            manager.resolveSession(context("alice", "thread")).blockingGet();
        } finally {
            manager.stopSessionReadCache(token);
        }

        // Disabled cache: every read reaches the service.
        verify(sessionService, times(2)).getSession("app", "alice", "thread", java.util.Optional.empty());
    }

    @Test
    void getDefaultReturnsAStableSingletonUntilReset() {
        SessionManager first = SessionManager.getDefault();
        SessionManager second = SessionManager.getDefault();
        assertThat(second).isSameAs(first);

        SessionManager.resetDefault();
        SessionManager after = SessionManager.getDefault();
        assertThat(after).isNotSameAs(first);
        SessionManager.resetDefault();
    }

    @Test
    void startAndStopCleanupTaskAreIdempotent() {
        manager = new SessionManager(sessionService, memoryService);
        manager.startCleanupTask(new com.agui.adk.session.SessionCleanupPolicy(
                java.time.Duration.ofMinutes(20), java.time.Duration.ofMinutes(5), null));
        manager.startCleanupTask(); // idempotent: no duplicate scheduler
        manager.stopCleanupTask();
        manager.stopCleanupTask(); // idempotent
        assertThat(manager.getSessionCount()).isZero();
    }
}
