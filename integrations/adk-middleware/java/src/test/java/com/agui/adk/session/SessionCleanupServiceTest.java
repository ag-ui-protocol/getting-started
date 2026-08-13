package com.agui.adk.session;

import com.google.adk.events.Event;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import com.agui.adk.AdkAgUiOptions;
import com.agui.adk.SessionManager;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.schedulers.Schedulers;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SessionCleanupServiceTest {
    @Test
    void deletesOnlySessionsExpiredByExplicitPolicy() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("expired", now.minus(Duration.ofHours(2)));
        Session current = session("current", now.minus(Duration.ofMinutes(30)));
        AtomicInteger deleted = new AtomicInteger();
        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15));
        SessionCleanupService service = new SessionCleanupService(policy, session -> {
            deleted.incrementAndGet();
            return Completable.complete();
        });

        service.cleanup(List.of(expired, current), now).blockingAwait();

        assertThat(deleted).hasValue(1);
        assertThat(policy.interval()).isEqualTo(Duration.ofMinutes(15));
    }

    @Test
    void managerCleanupSelectsOnlyExpiredSessionsAndUsesTheDeletionTransactionInOrder() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("expired", now.minus(Duration.ofHours(2)));
        expired.state().put(SessionStateKeys.THREAD_ID, "thread");
        Session current = session("current", now.minus(Duration.ofMinutes(30)));
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        ThreadSessionMappingStore mappings = mock(ThreadSessionMappingStore.class);
        when(sessions.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(expired, current)).build()));
        when(sessions.getSession("app", "user", "expired", java.util.Optional.empty())).thenReturn(io.reactivex.rxjava3.core.Maybe.just(expired));
        when(memory.addSessionToMemory(expired)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "expired")).thenReturn(Completable.complete());
        when(mappings.invalidate(new SessionMappingKey("app", "user", "thread"))).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(false));

        manager.cleanupExpiredSessions("app", "user",
                new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15)), now).blockingAwait();

        InOrder ordered = inOrder(memory, sessions, mappings);
        ordered.verify(memory).addSessionToMemory(expired);
        ordered.verify(sessions).deleteSession("app", "user", "expired");
        ordered.verify(mappings).invalidate(new SessionMappingKey("app", "user", "thread"));
        verify(sessions).listSessions("app", "user");
        verify(sessions).deleteSession("app", "user", "expired");
    }

    @Test
    void managerCleanupHydratesMetadataOnlyGeneratedSessionBeforeArchivingAndInvalidating() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session listed = session("generated", now.minus(Duration.ofHours(2)));
        Session full = session("generated", now.minus(Duration.ofHours(2)));
        full.state().put(SessionStateKeys.THREAD_ID, "thread");
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        ThreadSessionMappingStore mappings = mock(ThreadSessionMappingStore.class);
        when(sessions.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(listed)).build()));
        when(sessions.getSession("app", "user", "generated", java.util.Optional.empty())).thenReturn(io.reactivex.rxjava3.core.Maybe.just(full));
        when(memory.addSessionToMemory(full)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "generated")).thenReturn(Completable.complete());
        when(mappings.invalidate(new SessionMappingKey("app", "user", "thread"))).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(false));

        manager.cleanupExpiredSessions("app", "user", new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15)), now).blockingAwait();

        verify(memory).addSessionToMemory(full);
        verify(memory, never()).addSessionToMemory(listed);
        verify(mappings).invalidate(new SessionMappingKey("app", "user", "thread"));
    }

    @Test
    void managerCleanupDoesNotInvalidateMappingsForDirectThreadIdSessions() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("thread", now.minus(Duration.ofHours(2)));
        expired.state().put(SessionStateKeys.THREAD_ID, "thread");
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        ThreadSessionMappingStore mappings = mock(ThreadSessionMappingStore.class);
        when(sessions.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()));
        when(sessions.getSession("app", "user", "expired", java.util.Optional.empty())).thenReturn(io.reactivex.rxjava3.core.Maybe.just(expired));
        when(sessions.getSession("app", "user", "thread", java.util.Optional.empty())).thenReturn(io.reactivex.rxjava3.core.Maybe.just(expired));
        when(memory.addSessionToMemory(expired)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "thread")).thenReturn(Completable.complete());
        when(mappings.invalidate(new SessionMappingKey("app", "user", "thread"))).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(true));

        manager.cleanupExpiredSessions("app", "user",
                new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15)), now).blockingAwait();

        verify(mappings, never()).invalidate(any());
    }

    @Test
    void managerCleanupPropagatesDeleteFailureWithoutInvalidatingTheGeneratedMapping() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("expired", now.minus(Duration.ofHours(2)));
        expired.state().put(SessionStateKeys.THREAD_ID, "thread");
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        ThreadSessionMappingStore mappings = mock(ThreadSessionMappingStore.class);
        IllegalStateException failure = new IllegalStateException("delete failed");
        when(sessions.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()));
        when(sessions.getSession("app", "user", "expired", java.util.Optional.empty())).thenReturn(io.reactivex.rxjava3.core.Maybe.just(expired));
        when(memory.addSessionToMemory(expired)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "expired")).thenReturn(Completable.error(failure));
        when(mappings.invalidate(new SessionMappingKey("app", "user", "thread"))).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(false));

        assertThatThrownBy(() -> manager.cleanupExpiredSessions("app", "user",
                new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15)), now).blockingAwait())
                .isSameAs(failure);

        verify(mappings, never()).invalidate(any());
    }

    @Test
    void mappingInvalidationFailurePropagatesAfterDeletionButStillEvictsManagerProcessedState() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("expired", now.minus(Duration.ofHours(2)));
        expired.state().put(SessionStateKeys.THREAD_ID, "thread");
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        ThreadSessionMappingStore mappings = mock(ThreadSessionMappingStore.class);
        IllegalStateException failure = new IllegalStateException("mapping failed");
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        when(sessions.listSessions("app", "user")).thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()));
        when(sessions.getSession("app", "user", "expired", java.util.Optional.empty())).thenReturn(io.reactivex.rxjava3.core.Maybe.just(expired));
        when(memory.addSessionToMemory(expired)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "expired")).thenReturn(Completable.complete());
        when(mappings.invalidate(new SessionMappingKey("app", "user", "thread"))).thenReturn(Completable.error(failure));
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(false));
        manager.markMessagesProcessed(expired, List.of("before-delete")).blockingAwait();

        assertThatThrownBy(() -> manager.cleanupExpiredSessions("app", "user", new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15)), now).blockingAwait()).isSameAs(failure);
        Session replacement = Session.builder("expired").appName("app").userId("user").state(new ConcurrentHashMap<>()).build();
        manager.markMessagesProcessed(replacement, List.of("after-delete")).blockingAwait();

        ArgumentCaptor<Event> events = ArgumentCaptor.forClass(Event.class);
        verify(sessions, times(2)).appendEvent(any(), events.capture());
        assertThat(events.getAllValues().get(1).actions().stateDelta().get("processedMessageIds"))
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.SET).containsExactly("after-delete");
    }

    @Test
    void managerCleanupIsIdempotentWhenTheSecondListingIsEmpty() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("expired", now.minus(Duration.ofHours(2)));
        expired.state().put(SessionStateKeys.THREAD_ID, "thread");
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        ThreadSessionMappingStore mappings = mock(ThreadSessionMappingStore.class);
        when(sessions.listSessions("app", "user")).thenReturn(
                Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()),
                Single.just(ListSessionsResponse.builder().sessions(List.of()).build()));
        when(sessions.getSession("app", "user", "expired", java.util.Optional.empty())).thenReturn(io.reactivex.rxjava3.core.Maybe.just(expired));
        when(memory.addSessionToMemory(expired)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "expired")).thenReturn(Completable.complete());
        when(mappings.invalidate(new SessionMappingKey("app", "user", "thread"))).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(false));
        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15));

        manager.cleanupExpiredSessions("app", "user", policy, now).blockingAwait();
        manager.cleanupExpiredSessions("app", "user", policy, now).blockingAwait();

        verify(memory).addSessionToMemory(expired);
        verify(sessions).deleteSession("app", "user", "expired");
        verify(mappings).invalidate(new SessionMappingKey("app", "user", "thread"));
    }

    @Test
    void successfulManagerCleanupEvictsCachedProcessedMessageStateForTheDeletedSession() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("expired", now.minus(Duration.ofHours(2)));
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        when(sessions.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()));
        when(sessions.getSession("app", "user", "expired", java.util.Optional.empty())).thenReturn(io.reactivex.rxjava3.core.Maybe.just(expired));
        when(memory.addSessionToMemory(expired)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "expired")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory);
        manager.markMessagesProcessed(expired, List.of("before-delete")).blockingAwait();

        manager.cleanupExpiredSessions("app", "user",
                new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15)), now).blockingAwait();
        Session replacement = Session.builder("expired").appName("app").userId("user")
                .state(new ConcurrentHashMap<>()).build();
        manager.markMessagesProcessed(replacement, List.of("after-delete")).blockingAwait();

        ArgumentCaptor<Event> events = ArgumentCaptor.forClass(Event.class);
        verify(sessions, times(2)).appendEvent(any(), events.capture());
        assertThat(events.getAllValues().get(1).actions().stateDelta().get("processedMessageIds"))
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.SET)
                .containsExactly("after-delete");
    }

    @Test
    void cleanupStartedFromTerminalObservationCreatesANewSameKeyInvocation() {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        AtomicInteger listCalls = new AtomicInteger();
        when(sessions.listSessions("app", "user")).thenAnswer(ignored -> {
            listCalls.incrementAndGet();
            return Single.just(ListSessionsResponse.builder().sessions(List.of()).build());
        });
        SessionManager manager = new SessionManager(sessions, memory);
        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15));

        manager.cleanupExpiredSessions("app", "user", policy, now).subscribe(
                () -> manager.cleanupExpiredSessions("app", "user", policy, now).blockingAwait(),
                error -> {
                    throw new AssertionError(error);
                });

        assertThat(listCalls).hasValue(2);
    }

    @Test
    void overlappingCleanupForTheSameUserAndAppCoalescesUntilTheDeletionCompletes() throws InterruptedException {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session expired = session("expired", now.minus(Duration.ofHours(2)));
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        CountDownLatch deletionStarted = new CountDownLatch(1);
        CountDownLatch secondDeletionStarted = new CountDownLatch(1);
        CountDownLatch releaseDeletion = new CountDownLatch(1);
        AtomicInteger deleteCalls = new AtomicInteger();
        when(sessions.listSessions("app", "user")).thenReturn(
                Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()),
                Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()));
        when(sessions.getSession("app", "user", "expired", java.util.Optional.empty()))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(expired));
        when(memory.addSessionToMemory(expired)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "expired")).thenReturn(Completable.fromAction(() -> {
            if (deleteCalls.incrementAndGet() == 1) {
                deletionStarted.countDown();
                if (!releaseDeletion.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("timed out waiting for deletion release");
                }
            } else {
                secondDeletionStarted.countDown();
            }
        }));
        SessionManager manager = new SessionManager(sessions, memory);
        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15));

        io.reactivex.rxjava3.observers.TestObserver<Void> first = manager
                .cleanupExpiredSessions("app", "user", policy, now).subscribeOn(Schedulers.io()).test();
        assertThat(deletionStarted.await(5, TimeUnit.SECONDS)).isTrue();
        io.reactivex.rxjava3.observers.TestObserver<Void> overlapping = manager
                .cleanupExpiredSessions("app", "user", policy, now).subscribeOn(Schedulers.io()).test();

        assertThat(secondDeletionStarted.await(250, TimeUnit.MILLISECONDS)).isFalse();
        releaseDeletion.countDown();
        first.awaitDone(5, TimeUnit.SECONDS).assertComplete().assertNoErrors();
        overlapping.awaitDone(5, TimeUnit.SECONDS).assertComplete().assertNoErrors();

        manager.cleanupExpiredSessions("app", "user", policy, now).blockingAwait();
        // The coalescing entry was released (the fresh third cycle re-runs the listing), but
        // the already deleted-and-forgotten session is not re-deleted — Python _delete_session
        // untracks it so a later cleanup never re-processes it (M-09/M-21). Total listings:
        // one shared by the coalesced pair plus one for the fresh third cycle.
        assertThat(deleteCalls).hasValue(1);
        verify(sessions, times(2)).listSessions("app", "user");
    }

    @Test
    void overlappingCleanupForDifferentUserAndAppKeysRemainsIndependent() throws InterruptedException {
        Instant now = Instant.parse("2026-08-03T12:00:00Z");
        Session firstExpired = session("first", now.minus(Duration.ofHours(2)));
        Session secondExpired = Session.builder("second").appName("app").userId("other")
                .state(java.util.Map.of()).build();
        secondExpired.lastUpdateTime(now.minus(Duration.ofHours(2)));
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        CountDownLatch deletionsStarted = new CountDownLatch(2);
        CountDownLatch releaseDeletion = new CountDownLatch(1);
        when(sessions.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(firstExpired)).build()));
        when(sessions.listSessions("app", "other"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(secondExpired)).build()));
        when(sessions.getSession("app", "user", "first", java.util.Optional.empty()))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(firstExpired));
        when(sessions.getSession("app", "other", "second", java.util.Optional.empty()))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(secondExpired));
        when(memory.addSessionToMemory(any())).thenReturn(Completable.complete());
        when(sessions.deleteSession(any(), any(), any())).thenReturn(Completable.fromAction(() -> {
            deletionsStarted.countDown();
            if (!releaseDeletion.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("timed out waiting for deletion release");
            }
        }));
        SessionManager manager = new SessionManager(sessions, memory);
        SessionCleanupPolicy policy = new SessionCleanupPolicy(Duration.ofHours(1), Duration.ofMinutes(15));

        io.reactivex.rxjava3.observers.TestObserver<Void> first = manager
                .cleanupExpiredSessions("app", "user", policy, now).subscribeOn(Schedulers.io()).test();
        io.reactivex.rxjava3.observers.TestObserver<Void> second = manager
                .cleanupExpiredSessions("app", "other", policy, now).subscribeOn(Schedulers.io()).test();

        assertThat(deletionsStarted.await(5, TimeUnit.SECONDS)).isTrue();
        releaseDeletion.countDown();
        first.awaitDone(5, TimeUnit.SECONDS).assertComplete().assertNoErrors();
        second.awaitDone(5, TimeUnit.SECONDS).assertComplete().assertNoErrors();
    }

    private static Session session(String id, Instant lastUpdate) {
        Session session = Session.builder(id).appName("app").userId("user").state(java.util.Map.of()).build();
        session.lastUpdateTime(lastUpdate);
        return session;
    }
}
