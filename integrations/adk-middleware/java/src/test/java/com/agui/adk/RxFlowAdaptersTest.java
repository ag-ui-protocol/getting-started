package com.agui.adk;

import io.reactivex.rxjava3.core.Flowable;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Flow;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

class RxFlowAdaptersTest {

    @Test
    void forwardsDemandIncrementallyWithoutEagerEmission() {
        ManualSubscriber<Integer> subscriber = new ManualSubscriber<>();
        RxFlowAdapters.toFlowPublisher(Flowable.just(1, 2, 3)).subscribe(subscriber);

        assertThat(subscriber.items).isEmpty();
        subscriber.subscription.request(1);
        assertThat(subscriber.items).containsExactly(1);
        subscriber.subscription.request(2);
        assertThat(subscriber.items).containsExactly(1, 2, 3);
        assertThat(subscriber.complete).isTrue();
    }

    @Test
    void forwardsCancellationAndStopsSignals() {
        AtomicBoolean cancelled = new AtomicBoolean();
        ManualSubscriber<Integer> subscriber = new ManualSubscriber<>();
        RxFlowAdapters.toFlowPublisher(Flowable.range(1, 100).doOnCancel(() -> cancelled.set(true)))
                .subscribe(subscriber);

        subscriber.subscription.request(1);
        subscriber.subscription.cancel();
        subscriber.subscription.request(10);

        assertThat(subscriber.items).containsExactly(1);
        assertThat(cancelled).isTrue();
        assertThat(subscriber.complete).isFalse();
    }

    @Test
    void delegatesInvalidDemandToReactiveStreamsError() {
        ManualSubscriber<Integer> subscriber = new ManualSubscriber<>();
        RxFlowAdapters.toFlowPublisher(Flowable.just(1)).subscribe(subscriber);

        subscriber.subscription.request(0);

        assertThat(subscriber.error).isInstanceOf(IllegalArgumentException.class);
        assertThat(subscriber.items).isEmpty();
    }

    private static final class ManualSubscriber<T> implements Flow.Subscriber<T> {
        private final List<T> items = new ArrayList<>();
        private Flow.Subscription subscription;
        private Throwable error;
        private boolean complete;

        @Override
        public void onSubscribe(Flow.Subscription value) {
            subscription = value;
        }

        @Override
        public void onNext(T item) {
            items.add(item);
        }

        @Override
        public void onError(Throwable value) {
            error = value;
        }

        @Override
        public void onComplete() {
            complete = true;
        }
    }
}
