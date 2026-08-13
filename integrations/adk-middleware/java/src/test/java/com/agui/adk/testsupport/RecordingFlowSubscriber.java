package com.agui.adk.testsupport;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Generic unbounded-demand subscriber used by deterministic concurrency tests. */
public final class RecordingFlowSubscriber<T> implements Flow.Subscriber<T> {
    private final List<T> events = new ArrayList<>();
    private final CountDownLatch terminal = new CountDownLatch(1);
    private final AtomicReference<Throwable> error = new AtomicReference<>();
    private Flow.Subscription subscription;

    @Override
    public void onSubscribe(Flow.Subscription value) {
        subscription = value;
        value.request(Long.MAX_VALUE);
    }

    @Override
    public void onNext(T event) {
        events.add(event);
    }

    @Override
    public void onError(Throwable failure) {
        error.set(failure);
        terminal.countDown();
    }

    @Override
    public void onComplete() {
        terminal.countDown();
    }

    /** Returns the events received so far. */
    public List<T> events() {
        return events;
    }

    /** Returns the terminal subscriber failure, if any. */
    public Throwable error() {
        return error.get();
    }

    /** Waits for a terminal signal up to the supplied timeout. */
    public boolean await(Duration timeout) throws InterruptedException {
        return terminal.await(timeout.toMillis(), TimeUnit.MILLISECONDS);
    }

    /** Cancels the upstream subscription. */
    public void cancel() {
        subscription.cancel();
    }
}
