package com.agui.adk.hitl;

import com.agui.adk.encoding.CanonicalEventEncoder;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.encoding.PreEncodedEvent;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import org.junit.jupiter.api.Test;
import org.reactivestreams.Subscriber;
import org.reactivestreams.Subscription;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PersistBeforeVisibilityTest {

    private static final PendingCallScope SCOPE = new PendingCallScope("app", "principal", "session");
    private static final ToolCallChunkEvent EVENT = new ToolCallChunkEvent("call-1", "frontend", "{\"x\":1}");
    private static final ToolCallChunkEvent IDENTIFIED_EVENT = EVENT;
    private static final String EVENT_JSON = "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"call-1\",\"toolCallName\":\"frontend\",\"delta\":\"{\\\"x\\\":1}\"}";

    @Test
    void encodesPersistsAndOnlyThenEmitsFrontendCall() {
        List<String> trace = new ArrayList<>();
        PendingCallStore store = new RecordingStore(trace, false);
        CanonicalEventEncoder encoder = event -> {
            trace.add("encode");
            return new EncodedEvent(event, EVENT_JSON);
        };

        List<Event> events = new PendingToolCallEmitter(store, encoder, new ToolCallLedger())
                .emit(SCOPE, "invocation", 0, EVENT, true)
                .doOnNext(ignored -> trace.add("emit"))
                .toList().blockingGet();

        assertThat(trace).containsExactly("encode", "persist", "emit");
        assertThat(events).singleElement().isInstanceOfSatisfying(ToolCallChunkEvent.class, visible ->
                assertThat(visible.rawEvent()).isEqualTo(new PreEncodedEvent(IDENTIFIED_EVENT, EVENT_JSON)));
    }

    @Test
    void reportsEncodingErrorWithoutMakingFrontendCallVisible() {
        PendingCallStore store = new RecordingStore(new ArrayList<>(), false);
        CanonicalEventEncoder encoder = event -> {
            throw new IllegalArgumentException("bad event");
        };

        List<Event> events = new PendingToolCallEmitter(store, encoder, new ToolCallLedger())
                .emit(SCOPE, "invocation", 0, EVENT, true)
                .toList().blockingGet();

        assertThat(events).containsExactly(
                new RunErrorEvent("Event encoding failed", "ENCODING_ERROR", null, null));
    }

    @Test
    void reportsPersistenceErrorWithoutMakingFrontendCallVisible() {
        PendingCallStore store = new RecordingStore(new ArrayList<>(), true);
        CanonicalEventEncoder encoder = event -> new EncodedEvent(event, EVENT_JSON);

        List<Event> events = new PendingToolCallEmitter(store, encoder, new ToolCallLedger())
                .emit(SCOPE, "invocation", 0, EVENT, true)
                .toList().blockingGet();

        assertThat(events).containsExactly(
                new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
    }

    @Test
    void reportsSynchronousPersistenceErrorWithoutMakingFrontendCallVisible() {
        PendingCallStore store = new PendingCallStore() {
            @Override
            public Completable persist(PendingToolCall call) {
                throw new IllegalStateException("unavailable before Completable");
            }

            @Override
            public io.reactivex.rxjava3.core.Flowable<PendingToolCall> pending(PendingCallScope scope) {
                return io.reactivex.rxjava3.core.Flowable.empty();
            }
        };

        List<Event> events = new PendingToolCallEmitter(store,
                        event -> new EncodedEvent(event, EVENT_JSON),
                        new ToolCallLedger())
                .emit(SCOPE, "invocation", 0, EVENT, true)
                .toList().blockingGet();

        assertThat(events).containsExactly(
                new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
    }

    @Test
    void publicEmitterWithholdsFrontendCallUntilDurablePersistenceCompletes()
            throws InterruptedException {
        CompletableSubject durableCompletion = CompletableSubject.create();
        List<String> trace = new ArrayList<>();
        PendingCallStore store = new RecordingStore(trace, false) {
            @Override
            public Completable persist(PendingToolCall call) {
                trace.add("persist");
                return durableCompletion.doOnComplete(() -> trace.add("durable"));
            }
        };
        RecordingSubscriber subscriber = new RecordingSubscriber();
        PendingToolCallEmitter emitter = new PendingToolCallEmitter(
                store,
                event -> {
                    trace.add("encode");
                    return new EncodedEvent(event, EVENT_JSON);
                },
                new ToolCallLedger());

        emitter.emit(SCOPE, "invocation", 0, EVENT, true).subscribe(subscriber);

        assertThat(durableCompletion.hasObservers()).isTrue();
        assertThat(subscriber.isTerminal()).isFalse();
        assertThat(subscriber.events).isEmpty();
        assertThat(trace).containsExactly("encode", "persist");

        durableCompletion.onComplete();

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).singleElement()
                .isInstanceOfSatisfying(ToolCallChunkEvent.class, emitted ->
                        assertThat(emitted.rawEvent()).isEqualTo(
                                new PreEncodedEvent(IDENTIFIED_EVENT, EVENT_JSON)));
        assertThat(trace).containsExactly("encode", "persist", "durable");
    }

    @Test
    void nativeHitlEndIsInvisibleUntilDurableCorrelationCommit() throws InterruptedException {
        CompletableSubject durableCommit = CompletableSubject.create();
        PendingToolCallEmitter emitter = new PendingToolCallEmitter(
                new RecordingStore(new ArrayList<>(), false), null, new ToolCallLedger());
        emitter.deferEnd(new ToolCallEndEvent("native-1"));
        RecordingSubscriber subscriber = new RecordingSubscriber();

        emitter.emitDeferredEndsAfter(durableCommit).subscribe(subscriber);

        assertThat(subscriber.events).isEmpty();
        assertThat(subscriber.isTerminal()).isFalse();
        assertThat(emitter.deferredEndIds()).containsExactly("native-1");

        durableCommit.onComplete();

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events).containsExactly(new ToolCallEndEvent("native-1"));
        assertThat(emitter.deferredEndIds()).isEmpty();
    }

    @Test
    void nativeHitlCrashWindowNeverExposesEndBeforeDurability() {
        CompletableSubject durableCommit = CompletableSubject.create();
        PendingToolCallEmitter emitter = new PendingToolCallEmitter(
                new RecordingStore(new ArrayList<>(), false), null, new ToolCallLedger());
        emitter.deferEnd(new ToolCallEndEvent("native-crash"));
        RecordingSubscriber subscriber = new RecordingSubscriber();

        emitter.emitDeferredEndsAfter(durableCommit).subscribe(subscriber);
        subscriber.cancel();

        assertThat(subscriber.events).isEmpty();
        assertThat(emitter.deferredEndIds()).containsExactly("native-crash");
    }

    @Test
    void publicEmitterCancellationDisposesInFlightPersistence() {
        CompletableSubject persistenceCompletion = CompletableSubject.create();
        AtomicBoolean persistenceDisposed = new AtomicBoolean();
        AtomicReference<PendingToolCall> durable = new AtomicReference<>();
        PendingCallStore store = new PendingCallStore() {
            @Override
            public Completable persist(PendingToolCall call) {
                return persistenceCompletion
                        .doOnComplete(() -> durable.set(call))
                        .doOnDispose(() -> persistenceDisposed.set(true));
            }

            @Override
            public io.reactivex.rxjava3.core.Flowable<PendingToolCall> pending(PendingCallScope scope) {
                return durable.get() == null
                        ? io.reactivex.rxjava3.core.Flowable.empty()
                        : io.reactivex.rxjava3.core.Flowable.just(durable.get());
            }
        };
        RecordingSubscriber subscriber = new RecordingSubscriber();
        PendingToolCallEmitter emitter = new PendingToolCallEmitter(
                store,
                event -> new EncodedEvent(event, EVENT_JSON),
                new ToolCallLedger());

        emitter.emit(SCOPE, "invocation", 0, EVENT, true).subscribe(subscriber);

        assertThat(persistenceCompletion.hasObservers()).isTrue();
        assertThat(subscriber.events).isEmpty();
        assertThat(subscriber.isTerminal()).isFalse();
        assertThat(subscriber.error).isNull();

        subscriber.cancel();

        assertThat(persistenceDisposed).isTrue();
        assertThat(persistenceCompletion.hasObservers()).isFalse();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).isEmpty();
        assertThat(subscriber.isTerminal()).isFalse();

        persistenceCompletion.onComplete();

        assertThat(durable).hasValue(null);
        assertThat(emitter.replay(SCOPE, Set.of()).toList().blockingGet()).isEmpty();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).isEmpty();
    }

    @Test
    void publicBatchCancellationDisposesInFlightCompensation() {
        ToolCallChunkEvent secondEvent =
                new ToolCallChunkEvent(
                        "call-2",
                        "frontend",
                        "{\"x\":2}");
        String secondJson =
                "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"call-2\","
                        + "\"toolCallName\":\"frontend\",\"delta\":\"{\\\"x\\\":2}\"}";
        CompletableSubject compensationCompletion =
                CompletableSubject.create();
        AtomicBoolean compensationDisposed =
                new AtomicBoolean();
        AtomicInteger persistCount =
                new AtomicInteger();
        AtomicReference<Set<String>> removalIds =
                new AtomicReference<>();
        List<PendingToolCall> durable =
                new ArrayList<>();
        PendingCallStore store =
                new PendingCallStore() {
                    @Override
                    public Completable persist(
                            PendingToolCall call) {
                        if (persistCount.getAndIncrement()
                                == 0) {
                            return Completable.fromAction(
                                    () -> durable.add(call));
                        }
                        return Completable.error(
                                new IllegalStateException(
                                        "cannot persist second sibling"));
                    }

                    @Override
                    public Completable remove(
                            PendingCallGroupKey group,
                            Set<String> toolCallIds) {
                        removalIds.set(
                                Set.copyOf(toolCallIds));
                        return compensationCompletion
                                .doOnComplete(() ->
                                        durable.removeIf(call ->
                                                toolCallIds.contains(
                                                        call.key()
                                                                .toolCallId())))
                                .doOnDispose(() ->
                                        compensationDisposed
                                                .set(true));
                    }

                    @Override
                    public io.reactivex.rxjava3.core.Flowable<PendingToolCall>
                    pending(PendingCallScope scope) {
                        return io.reactivex.rxjava3.core.Flowable
                                .fromIterable(
                                        List.copyOf(durable));
                    }
                };
        RecordingSubscriber subscriber =
                new RecordingSubscriber();
        PendingToolCallEmitter emitter =
                new PendingToolCallEmitter(
                        store,
                        event ->
                                new EncodedEvent(
                                        event,
                                        event.toolCallId()
                                                        .equals("call-1")
                                                ? EVENT_JSON
                                                : secondJson),
                        new ToolCallLedger());

        emitter.emitAll(
                        SCOPE,
                        "invocation",
                        List.of(
                                new PendingToolCallEmitter
                                                .PositionedToolCall(
                                        0,
                                        EVENT),
                                new PendingToolCallEmitter
                                                .PositionedToolCall(
                                        1,
                                        secondEvent)))
                .subscribe(subscriber);

        assertThat(persistCount).hasValue(2);
        assertThat(removalIds)
                .hasValue(Set.of("call-1"));
        assertThat(compensationCompletion.hasObservers())
                .isTrue();
        assertThat(durable)
                .singleElement()
                .satisfies(call ->
                        assertThat(
                                        call.key()
                                                .toolCallId())
                                .isEqualTo("call-1"));
        assertThat(subscriber.events).isEmpty();
        assertThat(subscriber.isTerminal()).isFalse();
        assertThat(subscriber.error).isNull();

        subscriber.cancel();

        assertThat(compensationDisposed).isTrue();
        assertThat(compensationCompletion.hasObservers())
                .isFalse();
        assertThat(subscriber.events).isEmpty();
        assertThat(subscriber.isTerminal()).isFalse();
        assertThat(subscriber.error).isNull();

        compensationCompletion.onComplete();

        assertThat(durable).singleElement().satisfies(call ->
                assertThat(call.key().toolCallId()).isEqualTo("call-1"));
        assertThat(
                        emitter.replay(
                                        SCOPE,
                                        Set.of())
                                .toList()
                                .blockingGet())
                .hasSize(1);
        assertThat(subscriber.events).isEmpty();
        assertThat(subscriber.isTerminal()).isFalse();
        assertThat(subscriber.error).isNull();
    }

    @Test
    void rejectsSemanticallyInconsistentEncodedJsonBeforePersistence() {
        List<String> trace = new ArrayList<>();
        PendingCallStore store = new RecordingStore(trace, false);
        CanonicalEventEncoder encoder = event -> new EncodedEvent(event,
                "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"other-call\",\"toolCallName\":\"frontend\",\"delta\":\"{\\\"x\\\":1}\"}");

        List<Event> events = new PendingToolCallEmitter(store, encoder, new ToolCallLedger())
                .emit(SCOPE, "invocation", 0, EVENT, true)
                .toList().blockingGet();

        assertThat(events).containsExactly(
                new RunErrorEvent("Event encoding failed", "ENCODING_ERROR", null, null));
        assertThat(trace).isEmpty();
    }

    @Test
    void usesPersistedSnapshotForInitialVisibilityAndReplayAfterCallerMutation() {
        Map<String, Object> mutableRaw = new java.util.LinkedHashMap<>(Map.of("value", "before"));
        ToolCallChunkEvent event = new ToolCallChunkEvent("call-1", "frontend", null,
                "{\"x\":1}", null, mutableRaw);
        CompletableSubject persistenceCompletion = CompletableSubject.create();
        AtomicReference<PendingToolCall> persisted = new AtomicReference<>();
        PendingCallStore store = new PendingCallStore() {
            @Override
            public Completable persist(PendingToolCall call) {
                persisted.set(call);
                return persistenceCompletion;
            }

            @Override
            public io.reactivex.rxjava3.core.Flowable<PendingToolCall> pending(PendingCallScope scope) {
                return persisted.get() == null
                        ? io.reactivex.rxjava3.core.Flowable.empty()
                        : io.reactivex.rxjava3.core.Flowable.just(persisted.get());
            }
        };
        PendingToolCallEmitter emitter = new PendingToolCallEmitter(store,
                encoded -> new EncodedEvent(encoded, EVENT_JSON), new ToolCallLedger());
        AtomicReference<Event> initiallyVisible = new AtomicReference<>();

        var subscription = emitter.emit(SCOPE, "invocation", 0, event, true)
                .doOnNext(initiallyVisible::set)
                .subscribe();
        assertThat(persisted).hasValueSatisfying(call ->
                assertThat(call.event().rawEvent()).isEqualTo(Map.of("value", "before")));

        mutableRaw.put("value", "after");
        persistenceCompletion.onComplete();

        ToolCallChunkEvent initial = (ToolCallChunkEvent) initiallyVisible.get();
        PreEncodedEvent initialEncoded = (PreEncodedEvent) initial.rawEvent();
        EncodedEvent replay = emitter.replay(SCOPE, Set.of()).blockingFirst();
        PreEncodedEvent replayEncoded = (PreEncodedEvent) replay.event().rawEvent();
        assertThat(initialEncoded.delegate().rawEvent()).isEqualTo(Map.of("value", "before"));
        assertThat(replayEncoded.delegate().rawEvent()).isEqualTo(Map.of("value", "before"));
        assertThat(persisted.get().event().rawEvent()).isEqualTo(Map.of("value", "before"));
        assertThat(initialEncoded.json()).isEqualTo(EVENT_JSON);
        assertThat(replayEncoded.json()).isEqualTo(initialEncoded.json());
        assertThat(replay.json()).isEqualTo(initialEncoded.json());
        assertThat(persisted.get().json()).isEqualTo(initialEncoded.json());
        subscription.dispose();
    }

    @Test
    void snapshotsMutableRawEventBeforePersistence() {
        Map<String, Object> mutableRaw = new java.util.LinkedHashMap<>(Map.of("value", "before"));
        ToolCallChunkEvent event = new ToolCallChunkEvent("call-1", "frontend", null,
                "{\"x\":1}", null, mutableRaw);
        SessionPendingCallStore store = new SessionPendingCallStore();
        PendingToolCallEmitter emitter = new PendingToolCallEmitter(store,
                encoded -> new EncodedEvent(encoded, EVENT_JSON), new ToolCallLedger());

        emitter.emit(SCOPE, "invocation", 0, event, true).blockingSubscribe();
        mutableRaw.put("value", "after");

        PendingToolCall persisted = store.pending(SCOPE).blockingFirst();
        assertThat(persisted.event().rawEvent()).isEqualTo(Map.of("value", "before"));
        assertThatThrownBy(() -> ((Map<String, Object>) persisted.event().rawEvent()).put("value", "changed"))
                .isInstanceOf(UnsupportedOperationException.class);
        List<Event> duplicate = emitter.emit(SCOPE, "invocation", 0, event, true).toList().blockingGet();
        assertThat(duplicate).containsExactly(
                new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(store.pending(SCOPE).toList().blockingGet()).hasSize(1);
    }

    @Test
    void doesNotPersistBackendCalls() {
        List<String> trace = new ArrayList<>();
        PendingCallStore store = new RecordingStore(trace, false);
        CanonicalEventEncoder encoder = event -> {
            trace.add("encode");
            return new EncodedEvent(event, "json");
        };

        List<Event> events = new PendingToolCallEmitter(store, encoder, new ToolCallLedger())
                .emit(SCOPE, "invocation", 0, EVENT, false)
                .toList().blockingGet();

        assertThat(trace).isEmpty();
        assertThat(events).containsExactly(EVENT);
    }

    private static final class RecordingSubscriber implements Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private Subscription subscription;
        private Throwable error;

        @Override
        public void onSubscribe(Subscription subscribed) {
            subscription = subscribed;
            subscribed.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event event) {
            events.add(event);
        }

        @Override
        public void onError(Throwable failure) {
            error = failure;
            terminal.countDown();
        }

        @Override
        public void onComplete() {
            terminal.countDown();
        }

        private boolean await() throws InterruptedException {
            return terminal.await(1, TimeUnit.SECONDS);
        }

        private void cancel() {
            subscription.cancel();
        }

        private boolean isTerminal() {
            return terminal.getCount() == 0;
        }
    }

    @Test
    void persistsOfficialInterruptBeforeFrontendVisibility() {
        List<String> trace = new ArrayList<>();
        SessionInterruptStore delegate = new SessionInterruptStore();
        InterruptStore interrupts = new InterruptStore() {
            @Override public Completable persistGroup(List<PendingInterrupt> values) {
                return delegate.persistGroup(values).doOnComplete(() -> trace.add("interrupt"));
            }
            @Override public Completable removeGroup(PendingCallGroupKey group, Set<String> ids) {
                return delegate.removeGroup(group, ids);
            }
            @Override public io.reactivex.rxjava3.core.Flowable<PendingInterrupt> outstanding(
                    PendingCallScope scope) { return delegate.outstanding(scope); }
            @Override public io.reactivex.rxjava3.core.Single<List<PendingInterrupt>> lookup(
                    PendingCallScope scope, List<String> ids) { return delegate.lookup(scope, ids); }
            @Override public io.reactivex.rxjava3.core.Single<InterruptSubmission> submit(
                    PendingCallScope scope, List<com.agui.community.core.interrupt.Resume> resumes) {
                return delegate.submit(scope, resumes);
            }
            @Override public Completable release(InterruptGroupClaim claim) { return delegate.release(claim); }
            @Override public Completable markFinalizationPending(InterruptGroupClaim claim) {
                return delegate.markFinalizationPending(claim);
            }
            @Override public io.reactivex.rxjava3.core.Single<Boolean> finalizationPending(
                    InterruptGroupClaim claim) { return delegate.finalizationPending(claim); }
            @Override public Completable releaseFinalization(InterruptGroupClaim claim) {
                return delegate.releaseFinalization(claim);
            }
            @Override public Completable complete(InterruptGroupClaim claim) { return delegate.complete(claim); }
        };
        PendingToolCallEmitter emitter = new PendingToolCallEmitter(
                new RecordingStore(trace, false),
                event -> new EncodedEvent(event, EVENT_JSON),
                new ToolCallLedger(), interrupts, new InterruptFactory(), "run-1");

        List<Event> events = emitter.emit(SCOPE, "invocation", 0, EVENT, true)
                .doOnNext(ignored -> trace.add("visible"))
                .toList().blockingGet();
        List<PendingInterrupt> outstanding = interrupts.outstanding(SCOPE).toList().blockingGet();

        assertThat(events).singleElement().isInstanceOf(ToolCallChunkEvent.class);
        assertThat(trace).containsExactly("persist", "interrupt", "visible");
        assertThat(outstanding).singleElement().satisfies(interrupt -> {
            assertThat(interrupt.originRunId()).isEqualTo("run-1");
            assertThat(interrupt.toolCallId()).isEqualTo("call-1");
            assertThat(interrupt.interrupt().reason()).isEqualTo("tool_call");
        });
    }

    private static class RecordingStore implements PendingCallStore {
        private final List<String> trace;
        private final boolean fail;

        private RecordingStore(List<String> trace, boolean fail) {
            this.trace = trace;
            this.fail = fail;
        }

        @Override
        public Completable persist(PendingToolCall call) {
            trace.add("persist");
            return fail ? Completable.error(new IllegalStateException("unavailable")) : Completable.complete();
        }

        @Override
        public io.reactivex.rxjava3.core.Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return io.reactivex.rxjava3.core.Flowable.empty();
        }
    }
}
