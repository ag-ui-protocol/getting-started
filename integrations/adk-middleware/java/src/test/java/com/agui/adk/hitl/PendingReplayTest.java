package com.agui.adk.hitl;

import com.agui.adk.encoding.CanonicalEventEncoder;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.ToolCallChunkEvent;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class PendingReplayTest {

    private static final PendingCallScope SCOPE = new PendingCallScope("app", "principal", "session");
    private static final ToolCallChunkEvent EVENT = new ToolCallChunkEvent("call-1", "frontend", "{\"x\":1}");
    private static final ToolCallChunkEvent IDENTIFIED_EVENT = EVENT;
    private static final String JSON = "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"call-1\",\"toolCallName\":\"frontend\",\"delta\":\"{\\\"x\\\":1}\"}";

    @Test
    void replaysPersistedJsonByteForByteAfterCancellationBeforeDelivery() throws InterruptedException {
        DelayedCompletionStore store = new DelayedCompletionStore();
        PendingToolCallEmitter emitter = new PendingToolCallEmitter(store, event -> new EncodedEvent(event, JSON), new ToolCallLedger());
        AtomicReference<Event> delivered = new AtomicReference<>();

        var subscription = emitter.emit(SCOPE, "invocation", 0, EVENT, true)
                .doOnNext(delivered::set)
                .subscribe();
        assertThat(store.awaitPersisted()).isTrue();
        subscription.dispose();
        store.complete();

        List<EncodedEvent> replay = emitter.replay(SCOPE, Set.of()).toList().blockingGet();

        assertThat(delivered).hasValue(null);
        assertThat(replay).singleElement().satisfies(encoded -> {
            assertThat(encoded.event().rawEvent()).isEqualTo(new com.agui.adk.encoding.PreEncodedEvent(
                    IDENTIFIED_EVENT, JSON));
            assertThat(encoded.json()).isEqualTo(JSON);
        });
    }

    @Test
    void suppressesReplayWhenClientAlreadyKnowsCallId() {
        SessionPendingCallStore store = new SessionPendingCallStore();
        PendingToolCallEmitter emitter = new PendingToolCallEmitter(store, event -> new EncodedEvent(event, JSON), new ToolCallLedger());
        emitter.emit(SCOPE, "invocation", 0, EVENT, true).blockingSubscribe();

        assertThat(emitter.replay(SCOPE, Set.of("call-1")).toList().blockingGet()).isEmpty();
    }

    private static final class DelayedCompletionStore implements PendingCallStore {
        private final SessionPendingCallStore delegate = new SessionPendingCallStore();
        private final CompletableSubject completion = CompletableSubject.create();
        private final CountDownLatch persisted = new CountDownLatch(1);

        @Override
        public Completable persist(PendingToolCall call) {
            return delegate.persist(call)
                    .andThen(Completable.fromAction(persisted::countDown))
                    .andThen(completion);
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return delegate.pending(scope);
        }

        boolean awaitPersisted() throws InterruptedException {
            return persisted.await(1, TimeUnit.SECONDS);
        }

        void complete() {
            completion.onComplete();
        }
    }
}
