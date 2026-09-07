package com.agui.adk;

import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.Session;
import com.agui.adk.execution.ExecutionLease;
import com.agui.adk.session.InMemoryThreadSessionMappingStore;
import io.reactivex.rxjava3.core.SingleObserver;
import io.reactivex.rxjava3.disposables.Disposable;
import io.reactivex.rxjava3.functions.Consumer;
import io.reactivex.rxjava3.plugins.RxJavaPlugins;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class SessionManagerCorrectiveWaveTest {
    @Test
    void queuedMutationGuardSubscriptionReturnsPromptlyWhileAnotherLeaseIsHeld() throws Exception {
        SessionManager manager = manager();
        Session session = session("session");
        ExecutionLease holder = manager.acquireExecutionMutationGuard(session).blockingGet();
        ExecutorService caller = Executors.newSingleThreadExecutor();
        CountDownLatch subscriptionReturned = new CountDownLatch(1);
        AtomicReference<Disposable> queued = new AtomicReference<>();
        Future<?> subscription = caller.submit(() -> {
            queued.set(manager.acquireExecutionMutationGuard(session)
                    .subscribe(ExecutionLease::close, ignored -> { }));
            subscriptionReturned.countDown();
        });

        try {
            assertThat(subscriptionReturned.await(500, TimeUnit.MILLISECONDS)).isTrue();
        } finally {
            Disposable disposable = queued.get();
            if (disposable != null) {
                disposable.dispose();
            }
            holder.close();
            subscription.cancel(true);
            caller.shutdownNow();
            assertThat(caller.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void disposingQueuedMutationGuardsPhysicallyRemovesThemBeforeHolderRelease() throws Exception {
        SessionManager manager = manager();
        Session session = session("session");
        ExecutionLease holder = manager.acquireExecutionMutationGuard(session).blockingGet();
        List<Disposable> queued = new ArrayList<>();

        for (int index = 0; index < 100; index++) {
            queued.add(manager.acquireExecutionMutationGuard(session).subscribe(ignored -> { }, ignored -> { }));
        }
        queued.forEach(Disposable::dispose);

        try {
            assertThat(waiterCount(manager)).isZero();
        } finally {
            holder.close();
        }
    }

    @Test
    void disposalAfterDeliverySelectionDoesNotWaitForBlockedSuccessCallback() throws Exception {
        SessionManager manager = manager();
        Session session = session("session");
        ExecutionLease holder = manager.acquireExecutionMutationGuard(session).blockingGet();
        AtomicReference<Disposable> selectedSubscription = new AtomicReference<>();
        CountDownLatch selectedCallback = new CountDownLatch(1);
        SingleObserver<ExecutionLease> selected = new SingleObserver<>() {
            @Override
            public void onSubscribe(Disposable disposable) {
                selectedSubscription.set(disposable);
            }

            @Override
            public synchronized void onSuccess(ExecutionLease lease) {
                selectedCallback.countDown();
                lease.close();
            }

            @Override
            public void onError(Throwable error) {
                throw new AssertionError(error);
            }
        };
        manager.acquireExecutionMutationGuard(session).subscribe(selected);
        CountDownLatch followingAdmitted = new CountDownLatch(1);
        AtomicReference<ExecutionLease> following = new AtomicReference<>();
        manager.acquireExecutionMutationGuard(session).subscribe(lease -> {
            following.set(lease);
            followingAdmitted.countDown();
        }, ignored -> { });
        ExecutorService callers = Executors.newFixedThreadPool(2);
        AtomicReference<Thread> holderReleaseThread = new AtomicReference<>();
        Future<?> release;

        try {
            synchronized (selected) {
                release = callers.submit(() -> {
                    holderReleaseThread.set(Thread.currentThread());
                    holder.close();
                });
                assertThat(awaitCondition(() -> holderReleaseThread.get() != null
                        && holderReleaseThread.get().getState() == Thread.State.BLOCKED)).isTrue();
                CountDownLatch disposed = new CountDownLatch(1);
                callers.submit(() -> {
                    selectedSubscription.get().dispose();
                    disposed.countDown();
                });
                assertThat(disposed.await(250, TimeUnit.MILLISECONDS)).isTrue();
                assertThat(selectedCallback.getCount()).isEqualTo(1);
            }
            release.get(1, TimeUnit.SECONDS);
            assertThat(selectedCallback.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(followingAdmitted.await(1, TimeUnit.SECONDS)).isTrue();
        } finally {
            ExecutionLease lease = following.get();
            if (lease != null) {
                lease.close();
            }
            callers.shutdownNow();
            assertThat(callers.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void throwingSuccessCallbackReleasesLeaseAndAllowsFollowingWaiterToProgress() throws Exception {
        SessionManager manager = manager();
        Session session = session("session");
        ExecutionLease holder = manager.acquireExecutionMutationGuard(session).blockingGet();
        List<Throwable> pluginErrors = new ArrayList<>();
        Consumer<? super Throwable> previousErrorHandler = RxJavaPlugins.getErrorHandler();
        RxJavaPlugins.setErrorHandler(pluginErrors::add);
        CountDownLatch followingAdmitted = new CountDownLatch(1);
        AtomicReference<ExecutionLease> following = new AtomicReference<>();
        manager.acquireExecutionMutationGuard(session).subscribe(new SingleObserver<>() {
            @Override
            public void onSubscribe(Disposable disposable) {
            }

            @Override
            public void onSuccess(ExecutionLease lease) {
                throw new IllegalStateException("success callback failed");
            }

            @Override
            public void onError(Throwable error) {
                throw new AssertionError(error);
            }
        });
        manager.acquireExecutionMutationGuard(session).subscribe(lease -> {
            following.set(lease);
            followingAdmitted.countDown();
        }, ignored -> { });

        try {
            assertThatCode(holder::close).doesNotThrowAnyException();
            assertThat(followingAdmitted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(pluginErrors).hasSize(1);
            assertThat(pluginErrors.getFirst()).isInstanceOf(IllegalStateException.class)
                    .hasMessage("success callback failed");
        } finally {
            ExecutionLease lease = following.get();
            if (lease != null) {
                lease.close();
            }
            RxJavaPlugins.reset();
            if (previousErrorHandler != null) {
                RxJavaPlugins.setErrorHandler(previousErrorHandler);
            }
        }
    }

    @Test
    void throwingPluginHandlerAfterSuccessCallbackFailureDoesNotStrandFollowingWaiter() throws Exception {
        SessionManager manager = manager();
        Session session = session("session");
        ExecutionLease holder = manager.acquireExecutionMutationGuard(session).blockingGet();
        AtomicInteger handlerCalls = new AtomicInteger();
        Consumer<? super Throwable> previousErrorHandler = RxJavaPlugins.getErrorHandler();
        RxJavaPlugins.setErrorHandler(error -> {
            handlerCalls.incrementAndGet();
            throw new IllegalStateException("plugin handler failed");
        });
        CountDownLatch followingAdmitted = new CountDownLatch(1);
        AtomicReference<ExecutionLease> following = new AtomicReference<>();
        manager.acquireExecutionMutationGuard(session).subscribe(new SingleObserver<>() {
            @Override
            public void onSubscribe(Disposable disposable) {
            }

            @Override
            public void onSuccess(ExecutionLease lease) {
                throw new IllegalStateException("success callback failed");
            }

            @Override
            public void onError(Throwable error) {
                throw new AssertionError(error);
            }
        });
        manager.acquireExecutionMutationGuard(session).subscribe(lease -> {
            following.set(lease);
            followingAdmitted.countDown();
        }, ignored -> { });

        try {
            assertThatCode(holder::close).doesNotThrowAnyException();
            assertThat(followingAdmitted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(handlerCalls).hasValue(1);
        } finally {
            ExecutionLease lease = following.get();
            if (lease != null) {
                lease.close();
            }
            RxJavaPlugins.reset();
            if (previousErrorHandler != null) {
                RxJavaPlugins.setErrorHandler(previousErrorHandler);
            }
        }
    }

    @Test
    void throwingRetirementCallbackDoesNotSkipLaterStaleAdmissions() throws Exception {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session session = session("session");
        when(memory.addSessionToMemory(session)).thenReturn(io.reactivex.rxjava3.core.Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
        List<Throwable> pluginErrors = new ArrayList<>();
        Consumer<? super Throwable> previousErrorHandler = RxJavaPlugins.getErrorHandler();
        RxJavaPlugins.setErrorHandler(pluginErrors::add);
        CountDownLatch secondRetired = new CountDownLatch(1);
        when(sessions.deleteSession("app", "user", "session")).thenReturn(
                io.reactivex.rxjava3.core.Completable.create(emitter -> {
                    manager.acquireExecutionMutationGuard(session).subscribe(new SingleObserver<>() {
                        @Override
                        public void onSubscribe(Disposable disposable) {
                        }

                        @Override
                        public void onSuccess(ExecutionLease lease) {
                            throw new AssertionError("stale admission was delivered");
                        }

                        @Override
                        public void onError(Throwable error) {
                            throw new IllegalStateException("retirement callback failed");
                        }
                    });
                    manager.acquireExecutionMutationGuard(session).subscribe(ignored -> {
                        throw new AssertionError("stale admission was delivered");
                    }, error -> secondRetired.countDown());
                    emitter.onComplete();
                }));

        try {
            assertThatCode(() -> manager.archiveAndDeleteSession(session).blockingAwait()).doesNotThrowAnyException();
            assertThat(secondRetired.getCount()).isZero();
            assertThat(pluginErrors).hasSize(1);
            assertThat(pluginErrors.getFirst()).isInstanceOf(IllegalStateException.class)
                    .hasMessage("retirement callback failed");
            assertThat(mutationGuardRegistry(manager)).isEmpty();
        } finally {
            RxJavaPlugins.reset();
            if (previousErrorHandler != null) {
                RxJavaPlugins.setErrorHandler(previousErrorHandler);
            }
        }
    }

    @Test
    void deliveredLeaseRemainsOwnedWhenSubscriberDisposesDuringSuccessCallback() throws Exception {
        SessionManager manager = manager();
        Session session = session("session");
        ExecutionLease holder = manager.acquireExecutionMutationGuard(session).blockingGet();
        AtomicReference<Disposable> selectedSubscription = new AtomicReference<>();
        CountDownLatch selectedCallback = new CountDownLatch(1);
        manager.acquireExecutionMutationGuard(session).subscribe(new SingleObserver<>() {
            @Override
            public void onSubscribe(Disposable disposable) {
                selectedSubscription.set(disposable);
            }

            @Override
            public void onSuccess(ExecutionLease lease) {
                selectedSubscription.get().dispose();
                selectedCallback.countDown();
                lease.close();
            }

            @Override
            public void onError(Throwable error) {
                throw new AssertionError(error);
            }
        });
        CountDownLatch followingAdmitted = new CountDownLatch(1);
        AtomicReference<ExecutionLease> following = new AtomicReference<>();
        manager.acquireExecutionMutationGuard(session).subscribe(lease -> {
            following.set(lease);
            followingAdmitted.countDown();
        }, ignored -> { });

        try {
            holder.close();
            assertThat(selectedCallback.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(followingAdmitted.await(1, TimeUnit.SECONDS)).isTrue();
        } finally {
            ExecutionLease lease = following.get();
            if (lease != null) {
                lease.close();
            }
        }
    }

    @Test
    void liveSameIdentityWaitersAreAdmittedInSubscriptionOrder() {
        SessionManager manager = manager();
        Session session = session("session");
        ExecutionLease holder = manager.acquireExecutionMutationGuard(session).blockingGet();
        List<String> admissionOrder = new ArrayList<>();

        manager.acquireExecutionMutationGuard(session).subscribe(lease -> {
            admissionOrder.add("first");
            lease.close();
        }, ignored -> { });
        manager.acquireExecutionMutationGuard(session).subscribe(lease -> {
            admissionOrder.add("second");
            lease.close();
        }, ignored -> { });

        holder.close();

        assertThat(admissionOrder).containsExactly("first", "second");
    }

    @Test
    void confirmedDeletionAfterQueuedDisposalDoesNotReportAnUndeliverableError() throws Exception {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session session = session("session");
        when(memory.addSessionToMemory(session)).thenReturn(io.reactivex.rxjava3.core.Completable.complete());
        when(sessions.deleteSession("app", "user", "session")).thenReturn(io.reactivex.rxjava3.core.Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
        ExecutionLease holder = manager.acquireExecutionMutationGuard(session).blockingGet();
        Disposable disposed = manager.acquireExecutionMutationGuard(session).subscribe(ignored -> { }, ignored -> { });
        List<Throwable> undeliverable = new ArrayList<>();
        Consumer<? super Throwable> previousErrorHandler = RxJavaPlugins.getErrorHandler();
        RxJavaPlugins.setErrorHandler(undeliverable::add);
        try {
            disposed.dispose();
            holder.close();
            manager.archiveAndDeleteSession(session).blockingAwait();
            assertThat(undeliverable).isEmpty();
        } finally {
            RxJavaPlugins.reset();
            if (previousErrorHandler != null) {
                RxJavaPlugins.setErrorHandler(previousErrorHandler);
            }
        }
    }

    @Test
    void immediateLeaseCloseDrainsALargeFifoWithoutRecursiveStackGrowth() {
        SessionManager manager = manager();
        Session session = session("session");
        ExecutionLease holder = manager.acquireExecutionMutationGuard(session).blockingGet();
        int waiterCount = 20_000;
        AtomicInteger completed = new AtomicInteger();

        for (int index = 0; index < waiterCount; index++) {
            manager.acquireExecutionMutationGuard(session).subscribe(lease -> {
                completed.incrementAndGet();
                lease.close();
            }, ignored -> { });
        }

        holder.close();

        assertThat(completed).hasValue(waiterCount);
    }

    @Test
    void confirmedDeletionRetiresSettledMutationGuardsForDistinctSessions() throws Exception {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        when(memory.addSessionToMemory(any())).thenReturn(io.reactivex.rxjava3.core.Completable.complete());
        when(sessions.deleteSession(any(), any(), any())).thenReturn(io.reactivex.rxjava3.core.Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));

        for (int index = 0; index < 100; index++) {
            manager.archiveAndDeleteSession(session("session-" + index)).blockingAwait();
        }

        assertThat(mutationGuardRegistry(manager)).isEmpty();
    }

    @Test
    void staleQueuedMutationCannotLeaseAfterConfirmedDeletionButFreshAcquisitionCan() throws Exception {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session session = session("session");
        SessionManager manager = new SessionManager(sessions, memory, new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
        AtomicReference<Throwable> staleFailure = new AtomicReference<>();
        when(memory.addSessionToMemory(session)).thenReturn(io.reactivex.rxjava3.core.Completable.complete());
        when(sessions.deleteSession("app", "user", "session")).thenReturn(
                io.reactivex.rxjava3.core.Completable.create(emitter -> {
                    manager.acquireExecutionMutationGuard(session)
                            .subscribe(ignored -> { }, staleFailure::set);
                    emitter.onComplete();
                }));

        manager.archiveAndDeleteSession(session).blockingAwait();
        CountDownLatch freshAdmitted = new CountDownLatch(1);
        AtomicReference<ExecutionLease> fresh = new AtomicReference<>();
        manager.acquireExecutionMutationGuard(session).subscribe(lease -> {
            fresh.set(lease);
            freshAdmitted.countDown();
        }, ignored -> { });

        try {
            assertThat(staleFailure.get()).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("deleted before mutation admission");
            assertThat(freshAdmitted.await(1, TimeUnit.SECONDS)).isTrue();
        } finally {
            ExecutionLease lease = fresh.get();
            if (lease != null) {
                lease.close();
            }
        }
    }

    private static boolean awaitCondition(BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) {
                return true;
            }
            Thread.sleep(10);
        }
        return condition.getAsBoolean();
    }

    private static int waiterCount(SessionManager manager) throws Exception {
        Object entry = mutationGuardRegistry(manager).values().iterator().next();
        Field waiters = entry.getClass().getDeclaredField("waiters");
        waiters.setAccessible(true);
        return ((java.util.ArrayDeque<?>) waiters.get(entry)).size();
    }

    @SuppressWarnings("unchecked")
    private static Map<?, ?> mutationGuardRegistry(SessionManager manager) throws Exception {
        Field registry = SessionManager.class.getDeclaredField("sessionMutationGuards");
        registry.setAccessible(true);
        return (Map<?, ?>) registry.get(manager);
    }

    private static SessionManager manager() {
        return new SessionManager(mock(BaseSessionService.class), mock(BaseMemoryService.class),
                new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
    }

    private static Session session(String id) {
        return Session.builder(id).appName("app").userId("user").state(new ConcurrentHashMap<>()).build();
    }
}
