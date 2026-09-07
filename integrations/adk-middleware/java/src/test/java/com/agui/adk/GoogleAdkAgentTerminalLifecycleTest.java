package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.hitl.PendingCallGroupKey;
import com.agui.adk.hitl.PendingCallKey;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingCallStore;
import com.agui.adk.hitl.PendingStatus;
import com.agui.adk.hitl.PendingToolCall;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.message.MessageReservation;
import com.agui.adk.message.MessageReservationStore;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GoogleAdkAgentTerminalLifecycleTest {
    private static final RunAgentInput INPUT = new RunAgentInput(
            "thread", "run", Map.of(), List.of(new UserMessage("message", "Hello")),
            List.of(new Tool("browser", "Browser tool", new ToolParameters(Map.of(), List.of()))),
            List.of(new Context("appName", "app")), Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of(
                    "rawToolSchemas", List.of(Map.of("position", 0, "name", "browser", "schema", Map.of("type", "object"))))));

    @Test
    void rejectedResolvedUserValidationStillUsesOneCodedAcceptedLifecycle() throws InterruptedException {
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(new RecordingRunner(RecordingRunner.frontendCall()))
                .sessionManager(mock(SessionManager.class))
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "")
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(INPUT));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Invalid run input", "INVALID_RUN_INPUT", null, null));
    }

    @Test
    void rejectedToolSetupStillUsesOneCodedAcceptedLifecycle() throws InterruptedException {
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(new RecordingRunner(RecordingRunner.frontendCall()))
                .sessionManager(mock(SessionManager.class))
                .configuredBackendToolNames(Set.of("browser"))
                .userIdExtractor(ignored -> "user")
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(INPUT));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Duplicate tool name", "DUPLICATE_TOOL_NAME", null, null));
    }

    @Test
    void ordinaryResolvedExecutionClosesItsRegisteredRequestResource() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        AtomicInteger closes = new AtomicInteger();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(new ResourceRegisteringRunner(closes))
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .eventEncoder(event -> new EncodedEvent(event, encodedJson(event)))
                .messageReservationStore(new RecordingReservationStore())
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(INPUT));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunFinishedEvent("thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(closes).hasValue(1);
    }

    @Test
    void publicSubscriptionCancellationOwnsResolvedTokenUpstreamAndResources() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        CancellationObservingRunner runner = new CancellationObservingRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .eventEncoder(event -> new EncodedEvent(event, encodedJson(event)))
                .messageReservationStore(new RecordingReservationStore())
                .build();
        List<Event> events = new ArrayList<>();
        AtomicReference<Flow.Subscription> subscription = new AtomicReference<>();
        AtomicReference<Throwable> error = new AtomicReference<>();
        agent.run(INPUT).subscribe(new Flow.Subscriber<>() {
            @Override public void onSubscribe(Flow.Subscription value) {
                subscription.set(value);
                value.request(Long.MAX_VALUE);
            }
            @Override public void onNext(Event event) { events.add(event); }
            @Override public void onError(Throwable failure) { error.set(failure); }
            @Override public void onComplete() { }
        });

        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();
        subscription.get().cancel();
        subscription.get().cancel();

        assertThat(runner.cancelled.await(1, TimeUnit.SECONDS)).isTrue();
        AdkAgUiRunContext resolvedContext = runner.resolvedContext.get();
        assertThat(resolvedContext).isNotNull();
        assertThat(runner.runnerVisibleToken.get()).isSameAs(resolvedContext.cancellation());
        assertThat(resolvedContext.cancellation().isCancelled()).isTrue();
        assertThat(runner.resourcesClosed.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.resourceCloses).hasValue(1);
        assertThat(error).hasValue(null);
        assertThat(events).containsExactly(new RunStartedEvent("thread", "run"));
    }

    @Test
    void cancellingOrdinaryRunCancelsRunnerVisibleTokenAndClosesResourcesExactlyOnce() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        CancellationObservingRunner runner = new CancellationObservingRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .eventEncoder(event -> new EncodedEvent(event, encodedJson(event)))
                .messageReservationStore(new RecordingReservationStore())
                .build();
        List<Event> events = new ArrayList<>();
        AtomicReference<Flow.Subscription> subscription = new AtomicReference<>();
        AtomicReference<Throwable> error = new AtomicReference<>();
        agent.run(INPUT).subscribe(new Flow.Subscriber<>() {
            @Override public void onSubscribe(Flow.Subscription value) {
                subscription.set(value);
                value.request(Long.MAX_VALUE);
            }
            @Override public void onNext(Event event) { events.add(event); }
            @Override public void onError(Throwable failure) { error.set(failure); }
            @Override public void onComplete() { }
        });

        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();
        subscription.get().cancel();

        assertThat(runner.cancelled.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.resourcesClosed.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.runnerVisibleToken.get()).isNotNull();
        assertThat(runner.runnerVisibleToken.get().isCancelled()).isTrue();
        assertThat(runner.resourceCloses).hasValue(1);
        assertThat(error).hasValue(null);
        assertThat(events).containsExactly(new RunStartedEvent("thread", "run"));
    }

    @Test
    void ordinaryExecutionFailureUsesStableAdkExecutionCode() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        RecordingReservationStore reservations = new RecordingReservationStore();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(new FailingRunner())
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .eventEncoder(event -> new EncodedEvent(event, encodedJson(event)))
                .messageReservationStore(reservations)
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(INPUT));
        assertThat(reservations.rollback.hasObservers()).isTrue();
        reservations.rollback.onComplete();

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("runner unavailable", "EXECUTION_ERROR", null, null));
    }

    @Test
    void conflictingFrontendResultGroupsUseCanonicalPendingCallsCode() throws InterruptedException {
        TestFixture fixture = fixture(event -> new EncodedEvent(event, encodedJson(event)),
                new TwoPendingCallsStore());
        RunAgentInput results = new RunAgentInput("thread", "run", Map.of(),
                List.of(new ToolMessage("first", "{}", "first"), new ToolMessage("second", "{}", "second")),
                INPUT.tools(), List.of(new Context("appName", "app")), Map.of(
                        AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of("rawToolSchemas", List.of(Map.of(
                                "position", 0, "name", "browser", "schema", Map.of("type", "object"))))));

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(results));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Pending tool calls", "PENDING_TOOL_CALLS", null, null));
    }

    @Test
    void normalValuedRunErrorTerminatesAcceptedRunWithoutRunFinished() throws InterruptedException {
        TestFixture fixture = fixture(event -> new EncodedEvent(event, encodedJson(event)), new NeverPersistStore());
        RunAgentInput unknownResult = new RunAgentInput("thread", "run", Map.of(),
                List.of(new ToolMessage("result", "{}", "unknown")), INPUT.tools(),
                List.of(new Context("appName", "app")), Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of(
                        "rawToolSchemas", List.of(Map.of("position", 0, "name", "browser",
                                "schema", Map.of("type", "object"))))));

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(unknownResult));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
    }

    @Test
    void publicFreshTranslatorConstructionFailureUsesAdkExecutionCodeAfterRollback() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        RecordingReservationStore reservations = new RecordingReservationStore();
        RecordingRunner runner = new RecordingRunner(RecordingRunner.frontendCall());
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .eventEncoder(event -> new EncodedEvent(event, encodedJson(event)))
                .eventTranslatorFactory((thread, run, outputSchemaAgentNames) -> {
                    throw new IllegalStateException("translator construction");
                })
                .messageHistoryProvider(session -> Single.just(
                        com.agui.adk.history.MessageHistoryProvider.Result.unavailable()))
                .pendingCallStore(new NeverPersistStore())
                .messageReservationStore(reservations)
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(INPUT));
        long rollbackDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (reservations.rollbacks.get() != 1 && System.nanoTime() < rollbackDeadline) {
            Thread.onSpinWait();
        }
        assertThat(reservations.rollbacks).hasValue(1);
        assertThat(reservations.rollback.hasObservers()).isTrue();
        assertThat(subscriber.isTerminal()).isFalse();

        reservations.rollback.onComplete();

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("translator construction", "EXECUTION_ERROR", null, null));
        assertThat(runner.calls).hasValue(0);
        assertThat(reservations.commits).hasValue(0);
        assertThat(reservations.rollbacks).hasValue(1);
    }

    @Test
    void publicProviderErrorPreservesCodeAndMessageWithoutFinishOrSnapshot() throws InterruptedException {
        TestFixture fixture = fixture(event -> new EncodedEvent(event, encodedJson(event)), new NeverPersistStore(),
                com.google.adk.events.Event.builder().errorCode(new com.google.genai.types.FinishReason("SAFETY"))
                        .errorMessage("blocked").build());

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(INPUT));
        assertThat(fixture.reservations.rollback.hasObservers()).isTrue();
        fixture.reservations.rollback.onComplete();

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"), new RunErrorEvent("blocked", "SAFETY", null, null));
    }

    @Test
    void encoderFailureTerminatesAcceptedRunAndRollsBackBeforeRetry() throws InterruptedException {
        assertFrontendFailure("Event encoding failed", event -> {
            throw new IllegalArgumentException("cannot encode");
        }, new NeverPersistStore());
    }

    @Test
    void publicFrontendEncodingFailureCompletesWithStructuredEncodingErrorBeforeVisibility()
            throws InterruptedException {
        AtomicInteger persistenceCalls = new AtomicInteger();
        PendingCallStore store = new PendingCallStore() {
            @Override
            public Completable persist(PendingToolCall call) {
                persistenceCalls.incrementAndGet();
                return Completable.complete();
            }

            @Override
            public Flowable<PendingToolCall> pending(PendingCallScope scope) {
                return Flowable.empty();
            }
        };
        TestFixture fixture = fixture(event -> {
            throw new IllegalArgumentException("cannot encode");
        }, store);

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(INPUT));
        assertThat(fixture.reservations.rollback.hasObservers()).isTrue();
        fixture.reservations.rollback.onComplete();

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Event encoding failed", "ENCODING_ERROR", null, null));
        assertThat(subscriber.events).noneMatch(event -> event instanceof ToolCallChunkEvent
                || event instanceof ToolCallStartEvent
                || event instanceof ToolCallArgsEvent
                || event instanceof ToolCallEndEvent);
        assertThat(persistenceCalls).hasValue(0);
        assertThat(fixture.reservations.commits).hasValue(0);
        assertThat(fixture.reservations.rollbacks).hasValue(1);
        assertThat(fixture.runner.calls).hasValue(1);
    }

    @Test
    void publicSynchronousPersistenceFailureCompletesWithStructuredPersistenceErrorBeforeVisibility()
            throws InterruptedException {
        AtomicInteger persistenceCalls = new AtomicInteger();
        PendingCallStore store = new PendingCallStore() {
            @Override
            public Completable persist(PendingToolCall call) {
                persistenceCalls.incrementAndGet();
                throw new IllegalStateException("store unavailable");
            }

            @Override
            public Flowable<PendingToolCall> pending(PendingCallScope scope) {
                return Flowable.empty();
            }
        };
        TestFixture fixture = fixture(event -> new EncodedEvent(event, encodedJson(event)), store);

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(INPUT));
        assertThat(fixture.reservations.rollback.hasObservers()).isTrue();
        fixture.reservations.rollback.onComplete();

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(subscriber.events).noneMatch(event -> event instanceof ToolCallChunkEvent
                || event instanceof ToolCallStartEvent
                || event instanceof ToolCallArgsEvent
                || event instanceof ToolCallEndEvent);
        assertThat(persistenceCalls).hasValue(1);
        assertThat(fixture.reservations.commits).hasValue(0);
        assertThat(fixture.reservations.rollbacks).hasValue(1);
        assertThat(fixture.runner.calls).hasValue(1);
    }

    @Test
    void publicAsynchronousPersistenceFailureCompletesWithStructuredPersistenceErrorBeforeVisibility()
            throws InterruptedException {
        CompletableSubject persistence = CompletableSubject.create();
        RecordingStore store = new RecordingStore(persistence);
        TestFixture fixture = fixture(event -> new EncodedEvent(event, encodedJson(event)), store);

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(INPUT));
        assertThat(persistence.hasObservers()).isTrue();
        assertThat(subscriber.isTerminal()).isFalse();
        assertThat(subscriber.events).containsExactly(new RunStartedEvent("thread", "run"));

        persistence.onError(new IllegalStateException("store unavailable"));
        assertThat(fixture.reservations.rollback.hasObservers()).isTrue();
        fixture.reservations.rollback.onComplete();

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(subscriber.events).noneMatch(event -> event instanceof ToolCallChunkEvent
                || event instanceof ToolCallStartEvent
                || event instanceof ToolCallArgsEvent
                || event instanceof ToolCallEndEvent);
        assertThat(store.persists).hasValue(1);
        assertThat(fixture.reservations.commits).hasValue(0);
        assertThat(fixture.reservations.rollbacks).hasValue(1);
        assertThat(fixture.runner.calls).hasValue(1);
    }

    @Test
    void asynchronousPersistenceFailureTerminatesAcceptedRunAndRollsBackBeforeRetry() throws InterruptedException {
        CompletableSubject persistence = CompletableSubject.create();
        RecordingStore store = new RecordingStore(persistence);
        TestFixture fixture = fixture(event -> new EncodedEvent(event, encodedJson(event)), store);

        RecordingSubscriber first = subscribe(fixture.agent.run(INPUT));
        assertThat(persistence.hasObservers()).isTrue();
        persistence.onError(new IllegalStateException("store unavailable"));

        assertTerminalFailureAndRetry(fixture, first,
                new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
    }

    private static void assertFrontendFailure(
            String expectedMessage,
            com.agui.adk.encoding.CanonicalEventEncoder encoder,
            PendingCallStore store) throws InterruptedException {
        TestFixture fixture = fixture(encoder, store);
        RecordingSubscriber first = subscribe(fixture.agent.run(INPUT));

        assertTerminalFailureAndRetry(fixture, first,
                new RunErrorEvent(expectedMessage, "ENCODING_ERROR", null, null));
    }

    private static void assertTerminalFailureAndRetry(
            TestFixture fixture, RecordingSubscriber first, RunErrorEvent expectedError) throws InterruptedException {
        assertThat(fixture.reservations.rollback.hasObservers()).isTrue();
        assertThat(first.isTerminal()).isFalse();
        subscribe(fixture.agent.run(INPUT));
        assertThat(fixture.runner.calls).hasValue(1);

        fixture.reservations.rollback.onComplete();

        assertThat(first.await()).isTrue();
        assertThat(first.error).isNull();
        assertThat(first.events).startsWith(
                new RunStartedEvent("thread", "run"), expectedError);
        assertThat(first.events).noneMatch(event -> event instanceof ToolCallChunkEvent
                || event instanceof ToolCallStartEvent
                || event instanceof ToolCallArgsEvent
                || event instanceof ToolCallEndEvent);
        assertThat(fixture.reservations.commits).hasValue(0);
        assertThat(fixture.reservations.rollbacks).hasValue(1);
        assertThat(fixture.runner.calls).hasValue(2);
    }

    private static TestFixture fixture(
            com.agui.adk.encoding.CanonicalEventEncoder encoder, PendingCallStore store) {
        return fixture(encoder, store, RecordingRunner.frontendCall());
    }

    private static TestFixture fixture(
            com.agui.adk.encoding.CanonicalEventEncoder encoder,
            PendingCallStore store,
            com.google.adk.events.Event providerEvent) {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        RecordingReservationStore reservations = new RecordingReservationStore();
        RecordingRunner runner = new RecordingRunner(providerEvent);
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .eventEncoder(encoder)
                .pendingCallStore(store)
                .messageReservationStore(reservations)
                .build();
        return new TestFixture(agent, runner, reservations);
    }

    private static String encodedJson(com.agui.community.core.event.ToolCallChunkEvent event) {
        return "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"" + event.toolCallId()
                + "\",\"toolCallName\":\"" + event.toolCallName() + "\",\"delta\":\"{}\"}";
    }

    private static ResolvedSession resolvedSession() {
        Session session = Session.builder("session").appName("app").userId("user").state(Map.of()).build();
        return new ResolvedSession(session, new SessionMapping(new SessionMappingKey("app", "user", "thread"), "session"));
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private record TestFixture(GoogleAdkAgent agent, RecordingRunner runner, RecordingReservationStore reservations) {
    }

    private static final class NeverPersistStore implements PendingCallStore {
        @Override
        public Completable persist(PendingToolCall call) {
            return Completable.complete();
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return Flowable.empty();
        }
    }

    private static final class TwoPendingCallsStore implements PendingCallStore {
        @Override
        public Completable persist(PendingToolCall call) {
            return Completable.complete();
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            PendingCallGroupKey firstGroup = new PendingCallGroupKey(scope, "first-turn");
            PendingCallGroupKey secondGroup = new PendingCallGroupKey(scope, "second-turn");
            return Flowable.just(
                    pendingCall(firstGroup, "first"),
                    pendingCall(secondGroup, "second"));
        }

        private static PendingToolCall pendingCall(PendingCallGroupKey group, String id) {
            return new PendingToolCall(
                    new PendingCallKey(group, id),
                    new ToolCallChunkEvent(id, "browser", "parent", "{}", 1L, null),
                    "{}",
                    PendingStatus.PENDING);
        }
    }

    private static final class RecordingStore implements PendingCallStore {
        private final Completable firstPersistence;
        private final AtomicInteger persists = new AtomicInteger();

        private RecordingStore(Completable firstPersistence) {
            this.firstPersistence = firstPersistence;
        }

        @Override
        public Completable persist(PendingToolCall call) {
            return persists.getAndIncrement() == 0 ? firstPersistence : Completable.complete();
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return Flowable.empty();
        }
    }

    private static final class RecordingReservationStore implements MessageReservationStore {
        private final CompletableSubject rollback = CompletableSubject.create();
        private final AtomicInteger commits = new AtomicInteger();
        private final AtomicInteger rollbacks = new AtomicInteger();

        @Override
        public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            return Single.just(new MessageReservation(session, messages, invocationId));
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.fromAction(commits::incrementAndGet);
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            rollbacks.incrementAndGet();
            return rollback;
        }
    }

    private static final class RecordingRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final com.google.adk.events.Event firstEvent;

        private RecordingRunner(com.google.adk.events.Event firstEvent) {
            this.firstEvent = firstEvent;
        }

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            return calls.getAndIncrement() == 0 ? Flowable.just(firstEvent) : Flowable.never();
        }

        private static com.google.adk.events.Event frontendCall() {
            return com.google.adk.events.Event.builder().author("model").content(Content.builder().role("model")
                    .parts(Part.builder().functionCall(FunctionCall.builder().id("call").name("browser").args(Map.of()).build())
                            .build()).build()).build();
        }
    }

    private static final class FailingRunner implements AdkRunnerClient {
        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            return Flowable.error(new IllegalStateException("runner unavailable"));
        }
    }

    private static final class CancellationObservingRunner implements AdkRunnerClient {
        private final AtomicReference<AdkAgUiRunContext> resolvedContext = new AtomicReference<>();
        private final AtomicReference<com.agui.adk.execution.CancellationToken> runnerVisibleToken =
                new AtomicReference<>();
        private final AtomicInteger resourceCloses = new AtomicInteger();
        private final CountDownLatch started = new CountDownLatch(1);
        private final CountDownLatch cancelled = new CountDownLatch(1);
        private final CountDownLatch resourcesClosed = new CountDownLatch(1);

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            AdkAgUiRunContext context = AdkAgUiRunContext.from(runConfig).orElseThrow();
            resolvedContext.set(context);
            runnerVisibleToken.set(context.cancellation());
            context.resources().register(() -> {
                resourceCloses.incrementAndGet();
                resourcesClosed.countDown();
            });
            started.countDown();
            return Flowable.<com.google.adk.events.Event>never().doOnCancel(cancelled::countDown);
        }
    }

    private static final class ResourceRegisteringRunner implements AdkRunnerClient {
        private final AtomicInteger closes;

        private ResourceRegisteringRunner(AtomicInteger closes) {
            this.closes = closes;
        }

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            AdkAgUiRunContext.from(runConfig).orElseThrow().resources().register(() -> closes.incrementAndGet());
            return Flowable.empty();
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private Throwable error;

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            subscription.request(Long.MAX_VALUE);
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

        private boolean isTerminal() {
            return terminal.getCount() == 0;
        }
    }
}
