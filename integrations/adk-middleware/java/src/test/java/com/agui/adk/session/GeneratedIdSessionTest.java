package com.agui.adk.session;

import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.Session;
import com.agui.adk.AdkAgUiOptions;
import com.agui.adk.SessionManager;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.context.RequestResourceRegistry;
import com.agui.adk.execution.CancellationToken;
import com.agui.adk.hitl.ToolCallLedger;
import com.agui.adk.testsupport.VertexLikeSessionService;
import com.agui.community.core.agent.RunAgentInput;
import io.reactivex.rxjava3.core.Completable;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GeneratedIdSessionTest {

    @Test
    void generatedIdModeUsesPersistentMappingAndThreadState() {
        VertexLikeSessionService service = new VertexLikeSessionService();
        ThreadSessionMappingStore mappings = new InMemoryThreadSessionMappingStore();
        SessionManager manager = new SessionManager(service, mock(BaseMemoryService.class), mappings, new AdkAgUiOptions(false));

        ResolvedSession resolved = manager.resolveSession(context("alice", "thread")).blockingGet();
        ResolvedSession second = manager.resolveSession(context("alice", "thread")).blockingGet();

        assertThat(resolved.session().id()).isEqualTo("generated-1");
        assertThat(second.session().id()).isEqualTo("generated-1");
        assertThat(resolved.session().state())
                .containsEntry(SessionStateKeys.THREAD_ID, "thread")
                .containsEntry(SessionStateKeys.APP_NAME, "app")
                .containsEntry(SessionStateKeys.USER_ID, "alice");
        assertThat(service.createdCount()).isEqualTo(1);
    }

    @Test
    void directIdModeUsesThreadIdForCompatibleServices() {
        VertexLikeSessionService service = new VertexLikeSessionService(true);
        SessionManager manager = new SessionManager(service, mock(BaseMemoryService.class),
                new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));

        ResolvedSession resolved = manager.resolveSession(context("alice", "thread")).blockingGet();

        assertThat(resolved.session().id()).isEqualTo("thread");
        assertThat(resolved.mapping().sessionId()).isEqualTo("thread");
        assertThat(resolved.session().state())
                .containsEntry(SessionStateKeys.THREAD_ID, "thread")
                .containsEntry(SessionStateKeys.APP_NAME, "app")
                .containsEntry(SessionStateKeys.USER_ID, "alice");
    }

    @Test
    void recoversGeneratedSessionByScanningThreadStateAfterCacheLoss() {
        VertexLikeSessionService service = new VertexLikeSessionService();
        Session preexisting = service.createSession("app", "alice", new java.util.concurrent.ConcurrentHashMap<>(
                Map.of(SessionStateKeys.THREAD_ID, "thread")), null).blockingGet();
        SessionManager manager = new SessionManager(service, mock(BaseMemoryService.class),
                new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(false));

        ResolvedSession resolved = manager.resolveSession(context("alice", "thread")).blockingGet();

        assertThat(resolved.mapping().sessionId()).isEqualTo(preexisting.id());
        assertThat(resolved.session().id()).isEqualTo(preexisting.id());
        assertThat(service.createdCount()).isEqualTo(1);
    }

    @Test
    void readOnlyLookupRecoversExistingGeneratedSessionWithoutCreatingAMappingOrSession() {
        VertexLikeSessionService service = new VertexLikeSessionService();
        Session existing = service.createSession("app", "alice", new java.util.concurrent.ConcurrentHashMap<>(
                Map.of(SessionStateKeys.THREAD_ID, "thread")), null).blockingGet();
        SessionManager manager = new SessionManager(service, mock(BaseMemoryService.class),
                new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(false));

        ResolvedSession resolved = manager.findExistingSession("app", "alice", "thread").blockingGet();

        assertThat(resolved.session().id()).isEqualTo(existing.id());
        assertThat(resolved.mapping().sessionId()).isEqualTo(existing.id());
        assertThat(service.createdCount()).isEqualTo(1);
    }

    @Test
    void readOnlyLookupDoesNotAllocateForAnUnknownThread() {
        VertexLikeSessionService service = new VertexLikeSessionService();
        SessionManager manager = new SessionManager(service, mock(BaseMemoryService.class),
                new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(false));

        assertThat(manager.findExistingSession("app", "alice", "missing").isEmpty().blockingGet()).isTrue();
        assertThat(service.createdCount()).isZero();
    }

    @Test
    void cleanupInvalidatesTheDeletedThreadMapping() {
        VertexLikeSessionService service = new VertexLikeSessionService();
        ThreadSessionMappingStore mappings = new InMemoryThreadSessionMappingStore();
        BaseMemoryService memoryService = mock(BaseMemoryService.class);
        when(memoryService.addSessionToMemory(org.mockito.ArgumentMatchers.any(Session.class)))
                .thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(service, memoryService, mappings, new AdkAgUiOptions(false));
        manager.resolveSession(context("alice", "thread")).blockingGet();

        manager.deleteAllUserAppNameSessions("app", "alice").blockingAwait();

        ResolvedSession replacement = manager.resolveSession(context("alice", "thread")).blockingGet();

        assertThat(replacement.session().id()).isEqualTo("generated-2");
    }

    @Test
    void cleanupPassesAppUserAndSessionIdInAdkOrder() {
        VertexLikeSessionService service = new VertexLikeSessionService();
        service.createSession("app", "alice", new java.util.concurrent.ConcurrentHashMap<>(), null).blockingGet();
        BaseMemoryService memoryService = mock(BaseMemoryService.class);
        when(memoryService.addSessionToMemory(org.mockito.ArgumentMatchers.any(Session.class)))
                .thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(service, memoryService);

        manager.deleteAllUserAppNameSessions("app", "alice").blockingAwait();

        assertThat(service.lastDeleteArguments()).containsExactly("app", "alice", "generated-1");
    }

    private static AdkAgUiRunContext context(String userId, String threadId) {
        return new AdkAgUiRunContext("app", userId, threadId, "run", null, threadId,
                new RunAgentInput(threadId, "run", Map.of(), List.of(), List.of(), List.of(), Map.of()),
                List.of(), new ToolCallLedger(), new CancellationToken(), RequestResourceRegistry.create(), "invocation");
    }
}
