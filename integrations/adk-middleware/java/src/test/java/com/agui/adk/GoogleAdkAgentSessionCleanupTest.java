package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.events.Event;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.execution.CancellationToken;
import com.agui.adk.execution.ExecutionCoordinator;
import com.agui.adk.execution.ExecutionKey;
import com.agui.adk.execution.ExecutionLease;
import com.agui.adk.message.MessageReservation;
import com.agui.adk.message.MessageReservationStore;
import com.agui.adk.session.ResolvedSession;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.functions.Consumer;
import io.reactivex.rxjava3.processors.PublishProcessor;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import io.reactivex.rxjava3.schedulers.Schedulers;
import io.reactivex.rxjava3.plugins.RxJavaPlugins;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow.Subscriber;
import java.util.concurrent.Flow.Subscription;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class GoogleAdkAgentSessionCleanupTest {

    @Test
    void explicitCleanupUsesOfficialAppUserSessionArgumentOrder() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session session = session("session-1");
        when(sessions.getSession("app", "user", "session-1", java.util.Optional.empty()))
                .thenReturn(Maybe.just(session));
        when(memory.addSessionToMemory(session)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "session-1")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory);

        manager.cleanupSession("app", "user", "session-1").blockingAwait();

        verify(sessions).deleteSession("app", "user", "session-1");
    }

    @Test
    void defaultReservationStoreAllowsSameMessageAfterConfirmedDirectSessionDeletion() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session deleted = session("thread-1");
        Session recreated = session("thread-1");
        when(sessions.getSession("app", "user", "thread-1", java.util.Optional.empty()))
                .thenReturn(Maybe.just(deleted), Maybe.just(recreated));
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        when(memory.addSessionToMemory(deleted)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "thread-1")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, nullSafeMappings(), new AdkAgUiOptions(true));
        CountingRunner runner = new CountingRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();
        RunAgentInput input = new RunAgentInput(
                "thread-1", "run-1", Map.of(), List.of(new UserMessage("message-1", "hello")), List.of(),
                List.of(new Context("appName", "app")), Map.of());

        RecordingSubscriber first = subscribe(agent.run(input));
        assertThat(first.await()).isTrue();
        manager.archiveAndDeleteSession(deleted).blockingAwait();
        RecordingSubscriber second = subscribe(agent.run(input));

        assertThat(second.await()).isTrue();
        assertThat(second.events).noneMatch(RunErrorEvent.class::isInstance);
        assertThat(runner.runs).isEqualTo(2);
    }

    @Test
    void sharedManagerEvictsReservationsRegisteredByEachAgent() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session deleted = session("thread-1");
        Session recreated = session("thread-1");
        when(sessions.getSession("app", "user", "thread-1", java.util.Optional.empty()))
                .thenReturn(Maybe.just(deleted), Maybe.just(recreated), Maybe.just(recreated), Maybe.just(recreated));
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        when(memory.addSessionToMemory(deleted)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "thread-1")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, nullSafeMappings(), new AdkAgUiOptions(true));
        CountingRunner firstRunner = new CountingRunner();
        CountingRunner secondRunner = new CountingRunner();
        GoogleAdkAgent firstAgent = agent(manager, firstRunner);
        GoogleAdkAgent secondAgent = agent(manager, secondRunner);
        RunAgentInput input = input();

        assertThat(subscribe(firstAgent.run(input)).await()).isTrue();
        assertThat(subscribe(secondAgent.run(input)).await()).isTrue();
        manager.archiveAndDeleteSession(deleted).blockingAwait();

        assertThat(subscribe(firstAgent.run(input)).await()).isTrue();
        assertThat(subscribe(secondAgent.run(input)).await()).isTrue();
        assertThat(firstRunner.runs).isEqualTo(2);
        assertThat(secondRunner.runs).isZero();
    }

    @Test
    void failedDeletionRetainsTheDefaultAgentReservation() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session existing = session("thread-1");
        when(sessions.getSession("app", "user", "thread-1", java.util.Optional.empty()))
                .thenReturn(Maybe.just(existing), Maybe.just(existing));
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        when(memory.addSessionToMemory(existing)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "thread-1")).thenReturn(Completable.error(new IllegalStateException("delete failed")));
        SessionManager manager = new SessionManager(sessions, memory, nullSafeMappings(), new AdkAgUiOptions(true));
        CountingRunner runner = new CountingRunner();
        GoogleAdkAgent agent = agent(manager, runner);
        RunAgentInput input = input();

        assertThat(subscribe(agent.run(input)).await()).isTrue();
        assertThatThrownBy(() -> manager.archiveAndDeleteSession(existing).blockingAwait())
                .isInstanceOf(IllegalStateException.class);
        assertThat(subscribe(agent.run(input)).await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
    }

    @Test
    void acceptedRunFinalizationCannotRestoreDeletedDirectSessionReservationState() throws InterruptedException {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session deleted = session("thread-1");
        Session recreated = session("thread-1");
        when(sessions.getSession("app", "user", "thread-1", java.util.Optional.empty()))
                .thenReturn(Maybe.just(deleted), Maybe.just(recreated));
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        when(memory.addSessionToMemory(deleted)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "thread-1")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, nullSafeMappings(), new AdkAgUiOptions(true));
        HoldingRunner runner = new HoldingRunner();
        GoogleAdkAgent agent = agent(manager, runner);
        RunAgentInput input = input();

        RecordingSubscriber first = subscribe(agent.run(input));
        assertThat(runner.started.await(5, TimeUnit.SECONDS)).isTrue();
        CountDownLatch deletionTerminal = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<Throwable> deletionFailure = new java.util.concurrent.atomic.AtomicReference<>();
        manager.archiveAndDeleteSession(deleted)
                .subscribeOn(Schedulers.io())
                .subscribe(deletionTerminal::countDown, error -> {
                    deletionFailure.set(error);
                    deletionTerminal.countDown();
                });
        assertThat(deletionTerminal.await(250, TimeUnit.MILLISECONDS)).isFalse();
        runner.completeFirstRun();
        assertThat(first.await()).isTrue();
        assertThat(deletionTerminal.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(deletionFailure).hasValue(null);

        RecordingSubscriber second = subscribe(agent.run(input));
        assertThat(second.await()).isTrue();
        assertThat(runner.runs).isEqualTo(2);
    }

    @Test
    void throwingExecutionLeaseCloseReleasesSessionGuardForLaterRunAndDeletion() throws InterruptedException {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session session = session("thread-1");
        when(sessions.getSession("app", "user", "thread-1", java.util.Optional.empty()))
                .thenReturn(Maybe.just(session));
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        when(memory.addSessionToMemory(session)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "thread-1")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, nullSafeMappings(), new AdkAgUiOptions(true));
        FirstCloseThrowingCoordinator coordinator = new FirstCloseThrowingCoordinator();
        CountingRunner runner = new CountingRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .executionCoordinator(coordinator)
                .build();
        List<Throwable> pluginErrors = new CopyOnWriteArrayList<>();
        Consumer<? super Throwable> previousErrorHandler = RxJavaPlugins.getErrorHandler();
        RxJavaPlugins.setErrorHandler(pluginErrors::add);
        try {
            RecordingSubscriber first = subscribe(agent.run(input()));
            assertThat(first.await()).isTrue();
            assertThat(coordinator.awaitThrowingCloseAttempt()).isTrue();
            assertThat(coordinator.throwingCloseAttempts).hasValue(1);

            RecordingSubscriber later = subscribe(agent.run(new RunAgentInput(
                    "thread-1", "run-2", Map.of(), List.of(new UserMessage("message-2", "later")), List.of(),
                    List.of(new Context("appName", "app")), Map.of())));
            assertThat(later.await()).isTrue();
            assertThat(later.events).noneMatch(RunErrorEvent.class::isInstance);

            CountDownLatch deletionTerminal = new CountDownLatch(1);
            java.util.concurrent.atomic.AtomicReference<Throwable> deletionFailure = new java.util.concurrent.atomic.AtomicReference<>();
            manager.archiveAndDeleteSession(session).subscribe(
                    deletionTerminal::countDown,
                    error -> {
                        deletionFailure.set(error);
                        deletionTerminal.countDown();
                    });
            assertThat(deletionTerminal.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(deletionFailure).hasValue(null);
            assertThat(coordinator.throwingCloseAttempts).hasValue(1);
            assertThat(pluginErrors).anySatisfy(error -> assertThat(error)
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("execution lease close failed"));
        } finally {
            RxJavaPlugins.reset();
            if (previousErrorHandler != null) {
                RxJavaPlugins.setErrorHandler(previousErrorHandler);
            }
        }
    }

    @Test
    void confirmedDeletionAttemptsEveryCustomStoreAndMappingInvalidationBeforePropagatingAnEvictionFailure() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        com.agui.adk.session.ThreadSessionMappingStore mappings = mock(com.agui.adk.session.ThreadSessionMappingStore.class);
        Session deleted = session("session-1");
        deleted.state().put(com.agui.adk.session.SessionStateKeys.THREAD_ID, "thread-1");
        EvictingStore failing = new EvictingStore(Completable.error(new IllegalStateException("first eviction failed")));
        EvictingStore succeeding = new EvictingStore(Completable.complete());
        when(memory.addSessionToMemory(deleted)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "session-1")).thenReturn(Completable.complete());
        when(mappings.invalidate(new com.agui.adk.session.SessionMappingKey("app", "user", "thread-1")))
                .thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(false));
        agent(manager, new CountingRunner(), failing);
        agent(manager, new CountingRunner(), succeeding);

        assertThatThrownBy(() -> manager.archiveAndDeleteSession(deleted).blockingAwait())
                .hasMessageContaining("first eviction failed");

        assertThat(failing.evictions).hasValue(1);
        assertThat(succeeding.evictions).hasValue(1);
        org.mockito.Mockito.verify(mappings).invalidate(new com.agui.adk.session.SessionMappingKey("app", "user", "thread-1"));
    }

    @Test
    void confirmedDeletionEvictsDistinctCustomStoresThatCompareEqual() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session deleted = session("session-1");
        EvictingStore first = new EvictingStore(Completable.complete());
        EvictingStore second = new EvictingStore(Completable.complete());
        when(memory.addSessionToMemory(deleted)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "session-1")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory);
        agent(manager, new CountingRunner(), first);
        agent(manager, new CountingRunner(), second);

        manager.archiveAndDeleteSession(deleted).blockingAwait();

        assertThat(first.evictions).hasValue(1);
        assertThat(second.evictions).hasValue(1);
    }

    @Test
    void directArchiveConstructionFailureNeverBlocksTheDeletionAttempt() {
        // M-09: a memory/archive failure is logged and swallowed so the deletion attempt always
        // happens (Python _delete_session catches the memory error and continues); only a
        // confirmed deletion evicts reservation state.
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session session = session("session-1");
        AtomicBoolean failArchive = new AtomicBoolean(true);
        when(memory.addSessionToMemory(session)).thenAnswer(ignored -> {
            if (failArchive.getAndSet(false)) {
                throw new IllegalStateException("archive construction failed");
            }
            return Completable.complete();
        });
        when(sessions.deleteSession("app", "user", "session-1")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory);
        ImmediateEvictingStore store = new ImmediateEvictingStore(null);
        manager.registerMessageReservationStore(store);

        manager.archiveAndDeleteSession(session).test()
                .awaitDone(1, TimeUnit.SECONDS)
                .assertComplete()
                .assertNoErrors();
        verify(sessions).deleteSession("app", "user", "session-1");
        assertThat(store.evictions).hasValue(1);
        manager.archiveAndDeleteSession(session).test()
                .awaitDone(1, TimeUnit.SECONDS)
                .assertComplete()
                .assertNoErrors();
    }

    @Test
    void archiveFailureNeverPreventsTheDeletionAttempt() {
        // M-09: a memory failure is logged and swallowed so the deletion attempt always happens;
        // the reservation store is evicted only after the confirmed backend deletion.
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session session = session("session-1");
        ImmediateEvictingStore store = new ImmediateEvictingStore(null);
        when(memory.addSessionToMemory(session)).thenReturn(Completable.error(new IllegalStateException("archive failed")));
        when(sessions.deleteSession("app", "user", "session-1")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory);
        manager.registerMessageReservationStore(store);

        manager.archiveAndDeleteSession(session).test()
                .awaitDone(1, TimeUnit.SECONDS)
                .assertComplete()
                .assertNoErrors();

        verify(sessions).deleteSession("app", "user", "session-1");
        assertThat(store.evictions).hasValue(1);
    }

    @Test
    void directDeleteConstructionFailureRetainsManagerLocalProcessedState() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session staleView = session("session-1");
        List<Event> appended = new CopyOnWriteArrayList<>();
        UserMessage beforeDelete = new UserMessage("before-delete", "before");
        UserMessage afterFailure = new UserMessage("after-failure", "after");
        when(sessions.appendEvent(any(), any())).thenAnswer(invocation -> {
            appended.add(invocation.getArgument(1));
            return Single.just(Event.builder().build());
        });
        when(memory.addSessionToMemory(staleView)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "session-1"))
                .thenThrow(new IllegalStateException("delete construction failed"));
        SessionManager manager = new SessionManager(sessions, memory);

        manager.markMessagesProcessedWithFingerprints(staleView, List.of(beforeDelete)).blockingAwait();
        manager.archiveAndDeleteSession(staleView).test()
                .assertError(error -> error instanceof IllegalStateException
                        && "delete construction failed".equals(error.getMessage()));
        manager.markMessagesProcessedWithFingerprints(staleView, List.of(afterFailure)).blockingAwait();

        Map<String, Object> laterDelta = appended.get(1).actions().stateDelta();
        assertThat(laterDelta.get("processedMessageIds"))
                .isEqualTo(Set.of("before-delete", "after-failure"));
        assertThat(laterDelta.get("_ag_ui_message_fingerprints"))
                .isEqualTo(Map.of(
                        "before-delete", com.agui.adk.message.MessageFingerprint.of(beforeDelete),
                        "after-failure", com.agui.adk.message.MessageFingerprint.of(afterFailure)));
    }

    @Test
    void directDeleteConstructionFailureDoesNotRetireTheQueuedCurrentGuardEntry() throws InterruptedException {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session session = session("session-1");
        CompletableSubject archive = CompletableSubject.create();
        CountDownLatch cleanupTerminal = new CountDownLatch(1);
        CountDownLatch queuedAdmission = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<Throwable> cleanupFailure = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicReference<Throwable> queuedFailure = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicReference<ExecutionLease> queuedLease = new java.util.concurrent.atomic.AtomicReference<>();
        when(memory.addSessionToMemory(session)).thenReturn(archive);
        when(sessions.deleteSession("app", "user", "session-1"))
                .thenThrow(new IllegalStateException("delete construction failed"));
        SessionManager manager = new SessionManager(sessions, memory);

        manager.archiveAndDeleteSession(session).subscribe(
                cleanupTerminal::countDown,
                error -> {
                    cleanupFailure.set(error);
                    cleanupTerminal.countDown();
                });
        manager.acquireExecutionMutationGuard(session).subscribe(
                lease -> {
                    queuedLease.set(lease);
                    queuedAdmission.countDown();
                }, error -> {
                    queuedFailure.set(error);
                    queuedAdmission.countDown();
                });
        archive.onComplete();

        assertThat(cleanupTerminal.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(cleanupFailure.get()).hasMessage("delete construction failed");
        assertThat(queuedAdmission.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(queuedFailure).hasValue(null);
        assertThat(queuedLease.get()).isNotNull();
        queuedLease.get().close();
    }

    @Test
    void confirmedDeletionKeepsTheRetiringGuardFenceThroughPendingPostDeleteEviction() throws InterruptedException {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session session = session("session-1");
        HoldingEvictingStore store = new HoldingEvictingStore();
        CountDownLatch cleanupTerminal = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<Throwable> cleanupFailure = new java.util.concurrent.atomic.AtomicReference<>();
        when(memory.addSessionToMemory(session)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "session-1")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory);
        manager.registerMessageReservationStore(store);

        manager.archiveAndDeleteSession(session).subscribe(
                cleanupTerminal::countDown,
                error -> {
                    cleanupFailure.set(error);
                    cleanupTerminal.countDown();
                });
        assertThat(store.started.await(1, TimeUnit.SECONDS)).isTrue();

        manager.acquireExecutionMutationGuard(session).test()
                .awaitDone(1, TimeUnit.SECONDS)
                .assertError(error -> error instanceof IllegalStateException
                        && "session deleted before mutation admission".equals(error.getMessage()));
        assertThat(cleanupTerminal.getCount()).isEqualTo(1);

        store.complete();
        assertThat(cleanupTerminal.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(cleanupFailure).hasValue(null);
        ExecutionLease freshLease = manager.acquireExecutionMutationGuard(session).blockingGet();
        freshLease.close();
    }

    @Test
    void directDeleteConstructionFailureSkipsPostDeleteActionsAndReleasesTheGuard() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        com.agui.adk.session.ThreadSessionMappingStore mappings = mock(com.agui.adk.session.ThreadSessionMappingStore.class);
        Session session = session("session-1");
        session.state().put(com.agui.adk.session.SessionStateKeys.THREAD_ID, "thread-1");
        AtomicBoolean failDelete = new AtomicBoolean(true);
        ImmediateEvictingStore store = new ImmediateEvictingStore(null);
        when(memory.addSessionToMemory(session)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "session-1")).thenAnswer(ignored -> {
            if (failDelete.getAndSet(false)) {
                throw new IllegalStateException("delete construction failed");
            }
            return Completable.complete();
        });
        when(mappings.invalidate(new com.agui.adk.session.SessionMappingKey("app", "user", "thread-1")))
                .thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(false));
        manager.registerMessageReservationStore(store);

        manager.archiveAndDeleteSession(session).test()
                .assertError(error -> error instanceof IllegalStateException
                        && "delete construction failed".equals(error.getMessage()));

        assertThat(store.evictions).hasValue(0);
        verify(mappings, never()).invalidate(any());
        manager.archiveAndDeleteSession(session).test()
                .awaitDone(1, TimeUnit.SECONDS)
                .assertComplete()
                .assertNoErrors();
    }

    @Test
    void directFirstStoreFailureOccursOnlyAfterDeletionAndDoesNotSkipLaterActions() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        com.agui.adk.session.ThreadSessionMappingStore mappings = mock(com.agui.adk.session.ThreadSessionMappingStore.class);
        Session session = session("session-1");
        session.state().put(com.agui.adk.session.SessionStateKeys.THREAD_ID, "thread-1");
        AtomicInteger confirmedDeletes = new AtomicInteger();
        ImmediateEvictingStore failing = new ImmediateEvictingStore(new IllegalStateException("first eviction failed"));
        ImmediateEvictingStore succeeding = new ImmediateEvictingStore(null);
        when(memory.addSessionToMemory(session)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "session-1"))
                .thenReturn(Completable.fromAction(confirmedDeletes::incrementAndGet));
        when(mappings.invalidate(new com.agui.adk.session.SessionMappingKey("app", "user", "thread-1")))
                .thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(false));
        manager.registerMessageReservationStore(failing);
        manager.registerMessageReservationStore(succeeding);

        manager.archiveAndDeleteSession(session).test()
                .assertError(error -> error instanceof IllegalStateException
                        && "first eviction failed".equals(error.getMessage()));

        assertThat(confirmedDeletes).hasValue(1);
        assertThat(failing.evictions).hasValue(1);
        assertThat(succeeding.evictions).hasValue(1);
        verify(mappings).invalidate(new com.agui.adk.session.SessionMappingKey("app", "user", "thread-1"));
    }

    @Test
    void configuredBuilderPolicyGovernsTheManagerOwnedBackgroundCleanup() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session runSession = session("thread-1");
        Session expired = session("expired-1");
        expired.lastUpdateTime(Instant.parse("2020-01-01T00:00:00Z"));
        expired.state().put(com.agui.adk.session.SessionStateKeys.THREAD_ID, "expired-thread");
        when(sessions.getSession("app", "user", "thread-1", java.util.Optional.empty()))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(runSession));
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(com.google.adk.events.Event.builder().build()));
        when(sessions.listSessions("app", "user"))
                .thenReturn(Single.just(com.google.adk.sessions.ListSessionsResponse.builder()
                        .sessions(List.of(expired)).build()));
        when(sessions.getSession("app", "user", "expired-1", java.util.Optional.empty()))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(expired));
        when(memory.addSessionToMemory(expired)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "expired-1")).thenReturn(Completable.complete());
        com.agui.adk.session.ThreadSessionMappingStore mappings = nullSafeMappings();
        when(sessions.deleteSession("app", "user", "expired-1")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(true));
        CountingRunner runner = new CountingRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .sessionCleanupPolicy(new com.agui.adk.session.SessionCleanupPolicy(
                        Duration.ofHours(1), Duration.ofMillis(25)))
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(input()));
        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events).noneMatch(RunErrorEvent.class::isInstance);

        verify(sessions, org.mockito.Mockito.timeout(2000)).deleteSession("app", "user", "expired-1");
        verify(sessions, org.mockito.Mockito.atLeastOnce()).listSessions("app", "user");
    }

    private static GoogleAdkAgent agent(SessionManager manager, CountingRunner runner, MessageReservationStore store) {
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .messageReservationStore(store)
                .build();
    }

    private static GoogleAdkAgent agent(SessionManager manager, AdkRunnerClient runner) {
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();
    }

    private static RunAgentInput input() {
        return new RunAgentInput(
                "thread-1", "run-1", Map.of(), List.of(new UserMessage("message-1", "hello")), List.of(),
                List.of(new Context("appName", "app")), Map.of());
    }

    private static com.agui.adk.session.ThreadSessionMappingStore nullSafeMappings() {
        return new com.agui.adk.session.InMemoryThreadSessionMappingStore();
    }

    private static Session session(String id) {
        return Session.builder(id).appName("app").userId("user")
                .state(new java.util.concurrent.ConcurrentHashMap<>()).build();
    }

    private static RecordingSubscriber subscribe(java.util.concurrent.Flow.Publisher<com.agui.community.core.event.Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static final class ImmediateEvictingStore implements MessageReservationStore {
        private final IllegalStateException failure;
        private final AtomicInteger evictions = new AtomicInteger();

        private ImmediateEvictingStore(IllegalStateException failure) {
            this.failure = failure;
        }

        @Override
        public Single<MessageReservation> reserve(ResolvedSession session, List<com.agui.community.core.message.Message> messages, String invocationId) {
            return Single.error(new UnsupportedOperationException());
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.complete();
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.complete();
        }

        @Override
        public Completable evict(Session session) {
            evictions.incrementAndGet();
            if (failure != null) {
                throw failure;
            }
            return Completable.complete();
        }
    }

    private static final class EvictingStore implements MessageReservationStore {
        private final Completable eviction;
        private final AtomicInteger evictions = new AtomicInteger();

        private EvictingStore(Completable eviction) {
            this.eviction = eviction;
        }

        @Override
        public Single<MessageReservation> reserve(ResolvedSession session, List<com.agui.community.core.message.Message> messages, String invocationId) {
            return Single.error(new UnsupportedOperationException());
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.complete();
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.complete();
        }

        @Override
        public Completable evict(Session session) {
            return Completable.defer(() -> {
                evictions.incrementAndGet();
                return eviction;
            });
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof EvictingStore;
        }

        @Override
        public int hashCode() {
            return 1;
        }
    }

    private static final class HoldingEvictingStore implements MessageReservationStore {
        private final CountDownLatch started = new CountDownLatch(1);
        private final CompletableSubject completion = CompletableSubject.create();

        @Override
        public Single<MessageReservation> reserve(ResolvedSession session, List<com.agui.community.core.message.Message> messages, String invocationId) {
            return Single.error(new UnsupportedOperationException());
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.complete();
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.complete();
        }

        @Override
        public Completable evict(Session session) {
            started.countDown();
            return completion;
        }

        private void complete() {
            completion.onComplete();
        }
    }

    private static final class FirstCloseThrowingCoordinator implements ExecutionCoordinator {
        private final AtomicBoolean firstLease = new AtomicBoolean(true);
        private final AtomicInteger throwingCloseAttempts = new AtomicInteger();
        private final CountDownLatch throwingCloseAttempted = new CountDownLatch(1);

        @Override
        public Single<ExecutionLease> acquire(ExecutionKey key, CancellationToken cancellation) {
            return Single.fromSupplier(() -> firstLease.compareAndSet(true, false)
                    ? () -> {
                        throwingCloseAttempts.incrementAndGet();
                        throwingCloseAttempted.countDown();
                        throw new IllegalStateException("execution lease close failed");
                    }
                    : () -> { });
        }

        private boolean awaitThrowingCloseAttempt() throws InterruptedException {
            return throwingCloseAttempted.await(1, TimeUnit.SECONDS);
        }

        @Override
        public boolean isDistributed() {
            return false;
        }
    }

    private static final class HoldingRunner implements AdkRunnerClient {
        private final CountDownLatch started = new CountDownLatch(1);
        private final PublishProcessor<Event> firstRun = PublishProcessor.create();
        private int runs;

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<Event> runAsync(
                String userId, String sessionId, Content content, RunConfig config, Map<String, Object> stateDelta) {
            runs++;
            if (runs == 1) {
                started.countDown();
                return firstRun;
            }
            return Flowable.empty();
        }

        private void completeFirstRun() {
            firstRun.onComplete();
        }
    }

    private static final class CountingRunner implements AdkRunnerClient {
        private int runs;

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<Event> runAsync(
                String userId, String sessionId, Content content, RunConfig config, Map<String, Object> stateDelta) {
            runs++;
            return Flowable.empty();
        }
    }

    private static final class RecordingSubscriber implements Subscriber<com.agui.community.core.event.Event> {
        private final List<com.agui.community.core.event.Event> events = new CopyOnWriteArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);

        @Override
        public void onSubscribe(Subscription subscription) {
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(com.agui.community.core.event.Event event) {
            events.add(event);
        }

        @Override
        public void onError(Throwable throwable) {
            terminal.countDown();
            throw new AssertionError(throwable);
        }

        @Override
        public void onComplete() {
            terminal.countDown();
        }

        private boolean await() {
            try {
                return terminal.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new AssertionError(error);
            }
        }
    }
}
