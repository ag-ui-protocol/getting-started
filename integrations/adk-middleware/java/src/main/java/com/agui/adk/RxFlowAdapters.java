package com.agui.adk;

import io.reactivex.rxjava3.core.Flowable;
import org.reactivestreams.Subscriber;
import org.reactivestreams.Subscription;

import java.util.concurrent.Flow;

/** Bridges RxJava publishers to the JDK Flow API without changing demand or cancellation. */
final class RxFlowAdapters {

    private RxFlowAdapters() {
    }

    /**
     * Adapts an RxJava stream to JDK Flow while forwarding demand and cancellation.
     *
     * @param source RxJava source
     * @param <T> published item type
     * @return JDK Flow publisher
     */
    static <T> Flow.Publisher<T> toFlowPublisher(Flowable<T> source) {
        return downstream -> source.subscribe(new Subscriber<>() {
            @Override
            public void onSubscribe(Subscription upstream) {
                downstream.onSubscribe(new Flow.Subscription() {
                    @Override
                    public void request(long count) {
                        upstream.request(count);
                    }

                    @Override
                    public void cancel() {
                        upstream.cancel();
                    }
                });
            }

            @Override
            public void onNext(T item) {
                downstream.onNext(item);
            }

            @Override
            public void onError(Throwable error) {
                downstream.onError(error);
            }

            @Override
            public void onComplete() {
                downstream.onComplete();
            }
        });
    }
}
