package com.agui.adk.execution;

import io.reactivex.rxjava3.core.SingleObserver;
import io.reactivex.rxjava3.disposables.Disposable;
import io.reactivex.rxjava3.observers.TestObserver;
import io.reactivex.rxjava3.plugins.RxJavaPlugins;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

class ExecutionCoordinatorTest {

    @Test
    void idleRetirementCannotDetachAnActiveSameKeyQueue() throws Exception {
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        BlockingRemoveMap queues = installBlockingQueueMap(coordinator);
        ExecutionKey key = new ExecutionKey("app", "user", "thread");
        ExecutionLease first = coordinator.acquire(key, new CancellationToken()).blockingGet();
        AtomicReference<Throwable> closeFailure = new AtomicReference<>();
        Thread retire = new Thread(() -> {
            try {
                first.close();
            } catch (Throwable failure) {
                closeFailure.set(failure);
            }
        });
        retire.start();
        assertThat(queues.removeEntered.await(1, TimeUnit.SECONDS)).isTrue();

        AtomicReference<ExecutionLease> detached = new AtomicReference<>();
        Thread enqueue = new Thread(() -> detached.set(coordinator.acquire(key, new CancellationToken()).blockingGet()));
        enqueue.start();
        queues.releaseRemove.countDown();
        retire.join(TimeUnit.SECONDS.toMillis(1));
        enqueue.join(TimeUnit.SECONDS.toMillis(1));
        assertThat(retire.isAlive()).isFalse();
        assertThat(enqueue.isAlive()).isFalse();
        assertThat(closeFailure.get()).isNull();

        TestObserver<ExecutionLease> mapped = coordinator.acquire(key, new CancellationToken()).test();
        mapped.assertNotComplete();
        detached.get().close();
        mapped.assertComplete().assertNoErrors();
        mapped.values().getFirst().close();
    }

    @Test
    void disposingDuringPreEnqueueHandoffDeregistersCancellationListenerAndRetiresEmptyState() throws Exception {
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        BlockingComputeIfAbsentMap queues = installBlockingComputeIfAbsentMap(coordinator);
        CancellationToken cancellation = new CancellationToken();
        ExecutionKey key = new ExecutionKey("app", "user", "thread");
        TestObserver<ExecutionLease> observer = new TestObserver<>();
        Thread acquire = new Thread(() -> coordinator.acquire(key, cancellation).subscribe(observer));
        acquire.start();
        assertThat(queues.computeEntered.await(1, TimeUnit.SECONDS)).isTrue();

        observer.dispose();
        queues.releaseCompute.countDown();
        acquire.join(TimeUnit.SECONDS.toMillis(1));

        assertThat(acquire.isAlive()).isFalse();
        assertThat(queues).isEmpty();
        assertThat(cancellationListenerCount(cancellation)).isZero();
    }

    @Test
    void disposingPreEnqueueWaiterCannotDetachActiveSameKeyQueue() throws Exception {
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        BlockingSecondComputeIfAbsentMap queues = installBlockingSecondComputeIfAbsentMap(coordinator);
        ExecutionKey key = new ExecutionKey("app", "user", "thread");
        ExecutionLease first = coordinator.acquire(key, new CancellationToken()).blockingGet();
        CancellationToken cancellation = new CancellationToken();
        TestObserver<ExecutionLease> cancelled = new TestObserver<>();
        Thread acquire = new Thread(() -> coordinator.acquire(key, cancellation).subscribe(cancelled));
        acquire.start();
        assertThat(queues.secondComputeEntered.await(1, TimeUnit.SECONDS)).isTrue();

        cancelled.dispose();
        queues.releaseSecondCompute.countDown();
        acquire.join(TimeUnit.SECONDS.toMillis(1));
        assertThat(acquire.isAlive()).isFalse();
        assertThat(cancellationListenerCount(cancellation)).isZero();

        TestObserver<ExecutionLease> third = coordinator.acquire(key, new CancellationToken()).test();
        third.assertNotComplete();
        first.close();
        third.assertComplete().assertNoErrors();
        third.values().getFirst().close();
    }

    @Test
    void serializesSameKeyWhileAllowingOtherKeysToAcquire() {
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        ExecutionKey firstKey = new ExecutionKey("app", "user", "thread");
        ExecutionKey otherKey = new ExecutionKey("app", "other-user", "thread");

        ExecutionLease first = coordinator.acquire(firstKey, new CancellationToken()).blockingGet();
        TestObserver<ExecutionLease> queued = coordinator.acquire(firstKey, new CancellationToken()).test();
        TestObserver<ExecutionLease> independent = coordinator.acquire(otherKey, new CancellationToken()).test();

        queued.assertNotComplete();
        independent.assertComplete();
        assertThat(coordinator.isDistributed()).isFalse();

        first.close();
        queued.assertComplete().assertNoErrors();
        queued.values().getFirst().close();
        independent.values().getFirst().close();
    }

    @Test
    void disposedQueuedAcquireDoesNotAllowLaterAcquireToBypassActiveLease() {
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        ExecutionKey key = new ExecutionKey("app", "user", "thread");
        ExecutionLease first = coordinator.acquire(key, new CancellationToken()).blockingGet();
        TestObserver<ExecutionLease> disposed = coordinator.acquire(key, new CancellationToken()).test();
        disposed.dispose();
        TestObserver<ExecutionLease> later = coordinator.acquire(key, new CancellationToken()).test();

        later.assertNotComplete();

        first.close();
        later.assertComplete().assertNoErrors();
        later.values().getFirst().close();
    }

    @Test
    void cancellingQueuedTokenDefersQueueDeliveryUntilActiveLeaseReleasesAndKeepsLaterWaiterQueued() {
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        ExecutionKey key = new ExecutionKey("app", "user", "thread");
        ExecutionLease first = coordinator.acquire(key, new CancellationToken()).blockingGet();
        CancellationToken cancelled = new CancellationToken();
        TestObserver<ExecutionLease> queued = coordinator.acquire(key, cancelled).test();
        TestObserver<ExecutionLease> later = coordinator.acquire(key, new CancellationToken()).test();

        cancelled.cancel();

        queued.assertNotComplete();
        later.assertNotComplete();
        first.close();
        queued.awaitDone(1, TimeUnit.SECONDS).assertError(CancellationException.class);
        later.awaitDone(1, TimeUnit.SECONDS).assertComplete().assertNoErrors();
        later.values().getFirst().close();
    }

    @Test
    void cancelledQueuedAcquireDoesNotObtainOrLeakLeaseWhenPriorLeaseReleases() {
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        ExecutionKey key = new ExecutionKey("app", "user", "thread");
        ExecutionLease first = coordinator.acquire(key, new CancellationToken()).blockingGet();
        CancellationToken cancelled = new CancellationToken();
        TestObserver<ExecutionLease> queued = coordinator.acquire(key, cancelled).test();

        cancelled.cancel();
        first.close();

        queued.assertError(CancellationException.class);
        ExecutionLease next = coordinator.acquire(key, new CancellationToken()).blockingGet();
        next.close();
    }

    @Test
    void cancellingTokenAfterSelectedListenerDeregistrationDoesNotTransferOrLeakLease() throws Exception {
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        ExecutionKey key = new ExecutionKey("app", "user", "thread");
        ExecutionLease first = coordinator.acquire(key, new CancellationToken()).blockingGet();
        CancellationToken cancellation = new CancellationToken();
        BlockingListenerRemovalMap listeners = installBlockingListenerRemovalMap(cancellation);
        TestObserver<ExecutionLease> cancelled = coordinator.acquire(key, cancellation).test();
        TestObserver<ExecutionLease> later = coordinator.acquire(key, new CancellationToken()).test();
        Thread promotion = new Thread(first::close);

        promotion.start();
        assertThat(listeners.removalCompleted.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(cancellation.cancel()).isTrue();
        listeners.releaseRemoval.countDown();
        promotion.join(TimeUnit.SECONDS.toMillis(1));

        try {
            assertThat(promotion.isAlive()).isFalse();
            cancelled.awaitDone(1, TimeUnit.SECONDS).assertError(CancellationException.class);
            later.awaitDone(1, TimeUnit.SECONDS).assertComplete().assertNoErrors();
        } finally {
            cancelled.values().forEach(ExecutionLease::close);
            later.values().forEach(ExecutionLease::close);
        }
    }

    @Test
    void throwingNonFatalCancellationErrorCallbackDoesNotStrandLaterFifoWaiter() {
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        ExecutionKey key = new ExecutionKey("app", "user", "thread");
        ExecutionLease first = coordinator.acquire(key, new CancellationToken()).blockingGet();
        CancellationToken cancelled = new CancellationToken();
        IllegalStateException callbackFailure = new IllegalStateException("downstream cancellation callback failure");
        AtomicReference<Throwable> reported = new AtomicReference<>();
        RxJavaPlugins.setErrorHandler(reported::set);
        try {
            coordinator.acquire(key, cancelled).subscribe(new SingleObserver<ExecutionLease>() {
                @Override
                public void onSubscribe(Disposable disposable) {
                    // The coordinator owns cancellation through its real acquire API.
                }

                @Override
                public void onSuccess(ExecutionLease lease) {
                    throw new AssertionError("cancelled waiter must not receive a lease");
                }

                @Override
                public void onError(Throwable error) {
                    throw callbackFailure;
                }
            });
            TestObserver<ExecutionLease> later = coordinator.acquire(key, new CancellationToken()).test();

            cancelled.cancel();

            assertThatCode(first::close).doesNotThrowAnyException();
            assertThat(reported.get()).isSameAs(callbackFailure);
            later.assertComplete().assertNoErrors();
            later.values().getFirst().close();
        } finally {
            RxJavaPlugins.reset();
        }
    }

    private static BlockingComputeIfAbsentMap installBlockingComputeIfAbsentMap(InProcessExecutionCoordinator coordinator)
            throws ReflectiveOperationException {
        Field field = InProcessExecutionCoordinator.class.getDeclaredField("queues");
        field.setAccessible(true);
        BlockingComputeIfAbsentMap queues = new BlockingComputeIfAbsentMap();
        field.set(coordinator, queues);
        return queues;
    }

    private static int cancellationListenerCount(CancellationToken cancellation) throws ReflectiveOperationException {
        Field field = CancellationToken.class.getDeclaredField("listeners");
        field.setAccessible(true);
        return ((ConcurrentHashMap<?, ?>) field.get(cancellation)).size();
    }

    private static BlockingListenerRemovalMap installBlockingListenerRemovalMap(CancellationToken cancellation)
            throws ReflectiveOperationException {
        Field field = CancellationToken.class.getDeclaredField("listeners");
        field.setAccessible(true);
        BlockingListenerRemovalMap listeners = new BlockingListenerRemovalMap();
        field.set(cancellation, listeners);
        return listeners;
    }

    private static BlockingSecondComputeIfAbsentMap installBlockingSecondComputeIfAbsentMap(
            InProcessExecutionCoordinator coordinator) throws ReflectiveOperationException {
        Field field = InProcessExecutionCoordinator.class.getDeclaredField("queues");
        field.setAccessible(true);
        BlockingSecondComputeIfAbsentMap queues = new BlockingSecondComputeIfAbsentMap();
        field.set(coordinator, queues);
        return queues;
    }

    private static BlockingRemoveMap installBlockingQueueMap(InProcessExecutionCoordinator coordinator)
            throws ReflectiveOperationException {
        Field field = InProcessExecutionCoordinator.class.getDeclaredField("queues");
        field.setAccessible(true);
        BlockingRemoveMap queues = new BlockingRemoveMap();
        field.set(coordinator, queues);
        return queues;
    }

    private static final class BlockingComputeIfAbsentMap extends ConcurrentHashMap<ExecutionKey, Object> {
        private final CountDownLatch computeEntered = new CountDownLatch(1);
        private final CountDownLatch releaseCompute = new CountDownLatch(1);

        @Override
        public Object computeIfAbsent(ExecutionKey key,
                                      Function<? super ExecutionKey, ? extends Object> mappingFunction) {
            computeEntered.countDown();
            try {
                if (!releaseCompute.await(1, TimeUnit.SECONDS)) {
                    throw new AssertionError("pre-enqueue cancellation was not released");
                }
            } catch (InterruptedException failure) {
                Thread.currentThread().interrupt();
                throw new AssertionError(failure);
            }
            return super.computeIfAbsent(key, mappingFunction);
        }
    }

    private static final class BlockingSecondComputeIfAbsentMap extends ConcurrentHashMap<ExecutionKey, Object> {
        private final CountDownLatch secondComputeEntered = new CountDownLatch(1);
        private final CountDownLatch releaseSecondCompute = new CountDownLatch(1);
        private int computeCount;

        @Override
        public synchronized Object computeIfAbsent(ExecutionKey key,
                                                   Function<? super ExecutionKey, ? extends Object> mappingFunction) {
            if (++computeCount == 2) {
                secondComputeEntered.countDown();
                try {
                    if (!releaseSecondCompute.await(1, TimeUnit.SECONDS)) {
                        throw new AssertionError("second pre-enqueue cancellation was not released");
                    }
                } catch (InterruptedException failure) {
                    Thread.currentThread().interrupt();
                    throw new AssertionError(failure);
                }
            }
            return super.computeIfAbsent(key, mappingFunction);
        }
    }

    private static final class BlockingListenerRemovalMap extends ConcurrentHashMap<Object, Runnable> {
        private final CountDownLatch removalCompleted = new CountDownLatch(1);
        private final CountDownLatch releaseRemoval = new CountDownLatch(1);

        @Override
        public Runnable remove(Object key) {
            Runnable removed = super.remove(key);
            if (removed != null) {
                removalCompleted.countDown();
                try {
                    if (!releaseRemoval.await(1, TimeUnit.SECONDS)) {
                        throw new AssertionError("selected listener removal was not released");
                    }
                } catch (InterruptedException failure) {
                    Thread.currentThread().interrupt();
                    throw new AssertionError(failure);
                }
            }
            return removed;
        }
    }

    private static final class BlockingRemoveMap extends ConcurrentHashMap<ExecutionKey, Object> {
        private final CountDownLatch removeEntered = new CountDownLatch(1);
        private final CountDownLatch releaseRemove = new CountDownLatch(1);

        @Override
        public boolean remove(Object key, Object value) {
            removeEntered.countDown();
            try {
                if (!releaseRemove.await(1, TimeUnit.SECONDS)) {
                    throw new AssertionError("retirement removal was not released");
                }
            } catch (InterruptedException failure) {
                Thread.currentThread().interrupt();
                throw new AssertionError(failure);
            }
            return super.remove(key, value);
        }
    }
}
