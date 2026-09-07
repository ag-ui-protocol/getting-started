package com.agui.adk;

import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.observers.TestObserver;
import io.reactivex.rxjava3.plugins.RxJavaPlugins;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class ReservationFinalizerTest {
    @Test
    void synchronousDurableSupplierFailureRetainsCleanupUntilCancelledOwnerSettles() {
        CompletableSubject cleanup = CompletableSubject.create();
        AtomicInteger leaseCloses = new AtomicInteger();
        GoogleAdkAgent.ReservationFinalizer finalizer = new GoogleAdkAgent.ReservationFinalizer(
                () -> { throw new IllegalStateException("durable supplier"); },
                () -> cleanup, leaseCloses::incrementAndGet);

        TestObserver<Void> observer = finalizer.finalizeDurably().test();

        assertThat(cleanup.hasObservers()).isTrue();
        observer.dispose();
        finalizer.cancel();
        assertThat(leaseCloses).hasValue(0);

        cleanup.onComplete();

        assertThat(leaseCloses).hasValue(1);
    }

    @Test
    void synchronousCleanupSupplierFailureTerminatesAndClosesRunnerFailureLease() {
        AtomicInteger leaseCloses = new AtomicInteger();
        GoogleAdkAgent.ReservationFinalizer finalizer = new GoogleAdkAgent.ReservationFinalizer(
                Completable::complete,
                () -> { throw new IllegalStateException("cleanup supplier"); }, leaseCloses::incrementAndGet);

        finalizer.rollbackAfterRunnerFailure().test()
                .assertComplete()
                .assertNoErrors();

        assertThat(leaseCloses).hasValue(1);
    }

    @Test
    void cancellationCannotClaimRollbackAfterDurableFinalizationWinsInterleaving()
            throws InterruptedException {
        CompletableSubject durableFinalization = CompletableSubject.create();
        CompletableSubject cleanup = CompletableSubject.create();
        AtomicInteger leaseCloses = new AtomicInteger();
        CountDownLatch cancellationReadActive = new CountDownLatch(1);
        CountDownLatch permitCancellationClaim = new CountDownLatch(1);
        GoogleAdkAgent.ReservationFinalizer finalizer = new GoogleAdkAgent.ReservationFinalizer(
                () -> durableFinalization,
                () -> cleanup,
                leaseCloses::incrementAndGet,
                () -> {
                    cancellationReadActive.countDown();
                    await(permitCancellationClaim);
                });
        Thread cancellation = new Thread(finalizer::cancel);

        cancellation.start();
        assertThat(cancellationReadActive.await(1, TimeUnit.SECONDS)).isTrue();

        TestObserver<Void> observer = finalizer.finalizeDurably().test();
        assertThat(durableFinalization.hasObservers()).isTrue();
        permitCancellationClaim.countDown();
        cancellation.join(1_000);

        assertThat(cancellation.isAlive()).isFalse();
        assertThat(durableFinalization.hasObservers()).isTrue();
        assertThat(cleanup.hasObservers()).isFalse();
        assertThat(leaseCloses).hasValue(0);

        durableFinalization.onComplete();

        observer.assertComplete().assertNoErrors();
        assertThat(leaseCloses).hasValue(1);
    }

    @Test
    void throwingLeaseCloseStillCompletesDurableSettlementAndRoutesCloseFailure() {
        withPluginErrors(pluginErrors -> {
            AtomicBoolean closeAttempted = new AtomicBoolean();
            GoogleAdkAgent.ReservationFinalizer finalizer = new GoogleAdkAgent.ReservationFinalizer(
                    Completable::complete,
                    Completable::complete,
                    () -> {
                        closeAttempted.set(true);
                        throw new IllegalStateException("lease close");
                    });

            finalizer.finalizeDurably().test()
                    .assertComplete()
                    .assertNoErrors();

            assertThat(closeAttempted).isTrue();
            assertCloseFailure(pluginErrors);
        });
    }

    @Test
    void throwingLeaseCloseStillPreservesCompensationFailureAndRoutesCloseFailure() {
        withPluginErrors(pluginErrors -> {
            AtomicBoolean closeAttempted = new AtomicBoolean();
            GoogleAdkAgent.ReservationFinalizer finalizer = new GoogleAdkAgent.ReservationFinalizer(
                    () -> Completable.error(new IllegalArgumentException("durable failed")),
                    Completable::complete,
                    () -> {
                        closeAttempted.set(true);
                        throw new IllegalStateException("lease close");
                    });

            finalizer.finalizeDurably().test()
                    .assertError(error -> error instanceof IllegalArgumentException
                            && "durable failed".equals(error.getMessage()))
                    .assertNotComplete();

            assertThat(closeAttempted).isTrue();
            assertCloseFailure(pluginErrors);
        });
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(1, TimeUnit.SECONDS)) {
                throw new AssertionError("Timed out waiting for test interleaving");
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError(error);
        }
    }

    private static void assertCloseFailure(List<Throwable> pluginErrors) {
        assertThat(pluginErrors).singleElement().satisfies(error -> assertThat(error)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("lease close"));
    }

    private static void withPluginErrors(java.util.function.Consumer<List<Throwable>> assertion) {
        List<Throwable> pluginErrors = new CopyOnWriteArrayList<>();
        io.reactivex.rxjava3.functions.Consumer<? super Throwable> previousErrorHandler =
                RxJavaPlugins.getErrorHandler();
        RxJavaPlugins.setErrorHandler(pluginErrors::add);
        try {
            assertion.accept(pluginErrors);
        } finally {
            RxJavaPlugins.reset();
            if (previousErrorHandler != null) {
                RxJavaPlugins.setErrorHandler(previousErrorHandler);
            }
        }
    }
}
