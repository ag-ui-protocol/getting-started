package com.agui.adk.execution;

import com.agui.adk.context.RequestResourceRegistry;
import com.agui.adk.lifecycle.RunLifecycle;
import com.agui.community.core.event.Event;
import io.reactivex.rxjava3.processors.PublishProcessor;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class CancellationPropagationTest {
    @Test
    void downstreamCancellationCancelsRequestAndClosesResourcesExactlyOnce() {
        CancellationToken token = new CancellationToken();
        RequestResourceRegistry resources = RequestResourceRegistry.create();
        AtomicInteger closes = new AtomicInteger();
        resources.register(closes::incrementAndGet);
        PublishProcessor<Event> work = PublishProcessor.create();

        var observer = RunLifecycle.forRun("session", "run")
                .apply(work, token, resources)
                .test();
        observer.cancel();
        work.onComplete();

        assertThat(token.isCancelled()).isTrue();
        assertThat(closes).hasValue(1);
        assertThat(observer.values()).hasSize(1);
    }
}
