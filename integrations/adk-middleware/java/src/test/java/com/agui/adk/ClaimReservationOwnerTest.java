package com.agui.adk;

import com.agui.adk.message.MessageReservation;
import com.agui.adk.session.ResolvedSession;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.disposables.Disposable;
import io.reactivex.rxjava3.subscribers.DisposableSubscriber;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import com.agui.community.core.event.Event;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class ClaimReservationOwnerTest {
    @Test
    void normalConstructionFailureRetainsRollbackThenReleaseAfterCancellation() {
        AtomicInteger releases = new AtomicInteger();
        AtomicInteger leaseCloses = new AtomicInteger();
        CompletableSubject rollback = CompletableSubject.create();
        GoogleAdkAgent.ClaimReservationOwner owner = new GoogleAdkAgent.ClaimReservationOwner(
                Completable.fromAction(releases::incrementAndGet), leaseCloses::incrementAndGet);

        Disposable subscription = owner.reserve(
                        Single.just(reservation()), ignored -> { throw new IllegalStateException("construct"); },
                        ignored -> rollback.andThen(Completable.fromAction(releases::incrementAndGet)))
                .subscribe();
        subscription.dispose();

        assertThat(releases).hasValue(0);
        assertThat(leaseCloses).hasValue(0);
        rollback.onComplete();

        assertThat(releases).hasValue(1);
        assertThat(leaseCloses).hasValue(1);
    }

    @Test
    void recoveryConstructionFailureRetainsRollbackWithoutClaimReleaseAfterCancellation() {
        AtomicInteger releases = new AtomicInteger();
        AtomicInteger leaseCloses = new AtomicInteger();
        CompletableSubject rollback = CompletableSubject.create();
        GoogleAdkAgent.ClaimReservationOwner owner = new GoogleAdkAgent.ClaimReservationOwner(
                Completable.fromAction(releases::incrementAndGet), leaseCloses::incrementAndGet);

        Disposable subscription = owner.reserve(
                        Single.just(reservation()), ignored -> { throw new IllegalStateException("construct"); },
                        ignored -> rollback)
                .subscribe();
        subscription.dispose();

        assertThat(releases).hasValue(0);
        assertThat(leaseCloses).hasValue(0);
        rollback.onComplete();

        assertThat(releases).hasValue(0);
        assertThat(leaseCloses).hasValue(1);
    }

    @Test
    void synchronousFirstContinuationEventCancellationDisposesContinuationWork() {
        AtomicInteger releases = new AtomicInteger();
        AtomicInteger leaseCloses = new AtomicInteger();
        AtomicInteger cancellations = new AtomicInteger();
        GoogleAdkAgent.ClaimReservationOwner<MessageReservation> owner =
                new GoogleAdkAgent.ClaimReservationOwner<>(
                        Completable.fromAction(releases::incrementAndGet), leaseCloses::incrementAndGet);
        DisposableSubscriber<Event> subscriber = new DisposableSubscriber<>() {
            @Override public void onNext(Event event) { dispose(); }
            @Override public void onError(Throwable error) { }
            @Override public void onComplete() { }
        };

        owner.reserve(
                        Single.just(reservation()),
                        ignored -> Flowable.<Event>just(
                                        new com.agui.community.core.event.RunStartedEvent("thread", "run"))
                                .concatWith(Flowable.<Event>never().doOnCancel(cancellations::incrementAndGet)),
                        ignored -> Completable.fromAction(releases::incrementAndGet))
                .subscribe(subscriber);

        assertThat(subscriber.isDisposed()).isTrue();
        assertThat(cancellations).hasValue(1);
        assertThat(releases).hasValue(0);
        assertThat(leaseCloses).hasValue(0);
    }

    @Test
    void cancellationDuringContinuationConstructionPreventsSynchronousContinuationWork()
            throws InterruptedException {
        AtomicInteger releases = new AtomicInteger();
        AtomicInteger leaseCloses = new AtomicInteger();
        AtomicInteger continuationRuns = new AtomicInteger();
        CountDownLatch constructing = new CountDownLatch(1);
        CountDownLatch allowConstruction = new CountDownLatch(1);
        GoogleAdkAgent.ClaimReservationOwner<MessageReservation> owner =
                new GoogleAdkAgent.ClaimReservationOwner<>(
                        Completable.fromAction(releases::incrementAndGet), leaseCloses::incrementAndGet);

        Disposable subscription = owner.reserve(
                        Single.just(reservation()),
                        ignored -> {
                            constructing.countDown();
                            awaitUninterruptibly(allowConstruction);
                            return Flowable.defer(() -> {
                                continuationRuns.incrementAndGet();
                                return Flowable.empty();
                            });
                        },
                        ignored -> Completable.fromAction(releases::incrementAndGet))
                .subscribeOn(io.reactivex.rxjava3.schedulers.Schedulers.io())
                .subscribe();

        assertThat(constructing.await(1, TimeUnit.SECONDS)).isTrue();
        subscription.dispose();
        allowConstruction.countDown();

        awaitValue(leaseCloses, 1);
        assertThat(continuationRuns).hasValue(0);
        assertThat(releases).hasValue(1);
        assertThat(leaseCloses).hasValue(1);
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(1, TimeUnit.SECONDS)) {
                throw new IllegalStateException("timed out");
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(error);
        }
    }

    private static void awaitUninterruptibly(CountDownLatch latch) {
        boolean interrupted = false;
        while (true) {
            try {
                latch.await();
                break;
            } catch (InterruptedException error) {
                interrupted = true;
            }
        }
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static void awaitValue(AtomicInteger value, int expected) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (value.get() != expected && System.nanoTime() < deadline) {
            Thread.onSpinWait();
        }
        assertThat(value).hasValue(expected);
    }

    private static MessageReservation reservation() {
        return new MessageReservation(mock(ResolvedSession.class), List.of(), "invocation");
    }
}
