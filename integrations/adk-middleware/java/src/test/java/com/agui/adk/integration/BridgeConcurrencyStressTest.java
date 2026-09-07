package com.agui.adk.integration;

import com.google.adk.agents.RunConfig;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.AdkAgUiOptions;
import com.agui.adk.AdkRunnerClient;
import com.agui.adk.GoogleAdkAgent;
import com.agui.adk.SessionManager;
import com.agui.adk.SessionManagerTestFixtures;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.context.RequestResourceRegistry;
import com.agui.adk.execution.CancellationToken;
import com.agui.adk.hitl.ConfirmationRequest;
import com.agui.adk.hitl.ConfirmationRequestStore;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.SessionConfirmationRequestStore;
import com.agui.adk.hitl.ToolCallLedger;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.input.RunExtensionSupport;
import com.agui.adk.lifecycle.RunLifecycle;
import com.agui.adk.message.MessageReservation;
import com.agui.adk.message.MessageReservationStore;
import com.agui.adk.session.InMemoryThreadSessionMappingStore;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.adk.testsupport.RecordingFlowSubscriber;
import com.agui.adk.session.ThreadSessionMappingStore;
import com.agui.adk.testsupport.VertexLikeSessionService;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.processors.PublishProcessor;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Deterministic stress and cancellation coverage for the AG-UI {@code GoogleAdkAgent} bridge,
 * driven entirely through public APIs. Reuses the private runner and subscriber seams from the
 * execution stress tests while adding cross-instance HITL, session-creation races, and per-phase
 * cancellation guarantees.
 */
class BridgeConcurrencyStressTest {

    private static final String TEST_USER = "test-user";

    // ---------------------------------------------------------------------
    // 1. Same-thread serialization over 100+ runs
    // ---------------------------------------------------------------------

    @Test
    void oneHundredTwentyMessagesOnOneThreadSerializeInStrictOrderWithoutLeakingResources()
            throws InterruptedException {
        int sameKeyRuns = 100;
        int isolatedRuns = 20;
        ControlledRunner runner = new ControlledRunner(isolatedRuns);
        GoogleAdkAgent agent = agent(
                runner,
                new AdkAgUiOptions(false, Duration.ofSeconds(10), isolatedRuns + 1),
                input -> forwarded(input).get("user").toString());
        List<RecordingFlowSubscriber<Event>> subscribers = new ArrayList<>();

        for (int index = 0; index < sameKeyRuns; index++) {
            subscribers.add(subscribe(agent.run(input(
                    "same-message-" + index, "shared-thread", "same-run-" + index, "shared-user"))));
        }
        for (int index = 0; index < isolatedRuns; index++) {
            subscribers.add(subscribe(agent.run(input(
                    "isolated-message-" + index, "isolated-thread-" + index,
                    "isolated-run-" + index, "isolated-user-" + index))));
        }

        assertThat(runner.allIsolatedStarted.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.startedFor("same-run-0").await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.calls.get()).isEqualTo(isolatedRuns + 1);

        for (int index = 0; index < isolatedRuns; index++) {
            runner.complete("isolated-run-" + index);
        }
        for (int index = 0; index < sameKeyRuns; index++) {
            String runId = "same-run-" + index;
            assertThat(runner.startedFor(runId).await(1, TimeUnit.SECONDS)).isTrue();
            runner.complete(runId);
        }

        for (RecordingFlowSubscriber<Event> subscriber : subscribers) {
            assertThat(subscriber.await(Duration.ofSeconds(5))).isTrue();
            assertThat(subscriber.error()).isNull();
            // RUN_STARTED, the mandatory end-of-run STATE_SNAPSHOT, RUN_FINISHED.
            assertThat(subscriber.events()).hasSize(2);
            assertThat(subscriber.events().get(0)).isInstanceOf(RunStartedEvent.class);
            assertThat(subscriber.events().get(1)).isInstanceOf(RunFinishedEvent.class);
        }
        assertThat(runner.sameKeyOrder()).containsExactlyElementsOf(
                java.util.stream.IntStream.range(0, sameKeyRuns)
                        .mapToObj(index -> "same-run-" + index)
                        .toList());
        assertThat(runner.calls.get()).isEqualTo(sameKeyRuns + isolatedRuns);
        assertThat(runner.active.get()).isZero();
        assertThat(runner.cancelled.get()).isZero();
        assertThat(runner.resourcesClosed.get()).isEqualTo(sameKeyRuns + isolatedRuns);
    }

    // ---------------------------------------------------------------------
    // 2. Different-thread concurrency across 120 runs
    // ---------------------------------------------------------------------

    @Test
    void oneHundredTwentyDistinctThreadsRunConcurrentlyAndAllCloseResources()
            throws InterruptedException {
        int runs = 120;
        ConcurrentRunner runner = new ConcurrentRunner(runs);
        GoogleAdkAgent agent = agent(
                runner,
                new AdkAgUiOptions(false, Duration.ofSeconds(10), runs),
                ignored -> TEST_USER);
        List<RecordingFlowSubscriber<Event>> subscribers = new ArrayList<>();

        for (int index = 0; index < runs; index++) {
            subscribers.add(subscribe(agent.run(input(
                    "message-" + index, "thread-" + index, "run-" + index))));
        }

        assertThat(runner.allStarted.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.calls.get()).isEqualTo(runs);
        assertThat(runner.maxConcurrent.get()).isGreaterThanOrEqualTo(100);

        for (int index = 0; index < runs; index++) {
            runner.complete("run-" + index);
        }
        for (RecordingFlowSubscriber<Event> subscriber : subscribers) {
            assertThat(subscriber.await(Duration.ofSeconds(5))).isTrue();
            assertThat(subscriber.error()).isNull();
            // RUN_STARTED, the mandatory end-of-run STATE_SNAPSHOT, RUN_FINISHED.
            assertThat(subscriber.events()).hasSize(2);
        }
        assertThat(runner.resourcesClosed.get()).isEqualTo(runs);
        assertThat(runner.active.get()).isZero();
    }

    // ---------------------------------------------------------------------
    // 3. Two users sharing one thread never block each other, same-key serializes
    // ---------------------------------------------------------------------

    @Test
    void twoUsersOnOneThreadRunConcurrentlyWhilePerUserSlotsSerialize() throws InterruptedException {
        int perUser = 50;
        int total = perUser * 2;
        PerUserRunner runner = new PerUserRunner(total);
        GoogleAdkAgent agent = agent(
                runner,
                new AdkAgUiOptions(false, Duration.ofSeconds(10), total),
                input -> forwarded(input).get("user").toString());
        List<RecordingFlowSubscriber<Event>> subscribers = new ArrayList<>();

        for (int index = 0; index < perUser; index++) {
            subscribers.add(subscribe(agent.run(input(
                    "a-message-" + index, "shared-thread", "a-run-" + index, "user-a"))));
            subscribers.add(subscribe(agent.run(input(
                    "b-message-" + index, "shared-thread", "b-run-" + index, "user-b"))));
        }

        // Cross-user same-thread must be admitted concurrently even before either key finishes.
        assertThat(runner.startedFor("a-run-0").await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.startedFor("b-run-0").await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.calls.get()).isEqualTo(2);

        for (int index = 0; index < perUser; index++) {
            runner.complete("a-run-" + index);
            runner.complete("b-run-" + index);
        }
        for (RecordingFlowSubscriber<Event> subscriber : subscribers) {
            assertThat(subscriber.await(Duration.ofSeconds(5))).isTrue();
            assertThat(subscriber.error()).isNull();
            // RUN_STARTED, the mandatory end-of-run STATE_SNAPSHOT, RUN_FINISHED.
            assertThat(subscriber.events()).hasSize(2);
        }
        assertThat(runner.orderFor("a-run-")).containsExactlyElementsOf(
                java.util.stream.IntStream.range(0, perUser).mapToObj(index -> "a-run-" + index).toList());
        assertThat(runner.orderFor("b-run-")).containsExactlyElementsOf(
                java.util.stream.IntStream.range(0, perUser).mapToObj(index -> "b-run-" + index).toList());
        assertThat(runner.active.get()).isZero();
        assertThat(runner.cancelled.get()).isZero();
        assertThat(runner.resourcesClosed.get()).isEqualTo(total);
    }

    // ---------------------------------------------------------------------
    // 4. Session-creation races: atomic and non-atomic mapping stores
    // ---------------------------------------------------------------------

    @Test
    void atomicMappingStoreCreatesExactlyOneSessionUnderConcurrentMiss() throws Exception {
        VertexLikeSessionService service = new VertexLikeSessionService();
        SessionManager manager = new SessionManager(
                service, mock(BaseMemoryService.class), new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(false));
        AdkAgUiRunContext context = sessionContext("alice", "thread");

        int workers = 2;
        ExecutorService pool = Executors.newFixedThreadPool(workers);
        CountDownLatch go = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(workers);
        List<ResolvedSession> results = new CopyOnWriteArrayList<>();
        for (int index = 0; index < workers; index++) {
            pool.submit(() -> {
                try {
                    go.await(5, TimeUnit.SECONDS);
                    results.add(manager.resolveSession(context).blockingGet());
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                } finally {
                    done.countDown();
                }
            });
        }
        go.countDown();
        assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();
        pool.shutdown();

        assertThat(service.createdCount()).isEqualTo(1);
        assertThat(results).hasSize(workers);
        assertThat(results.get(0).session().id()).isEqualTo(results.get(1).session().id());
        assertThat(results.get(0).mapping().sessionId())
                .isEqualTo(results.get(1).mapping().sessionId());
    }

    @Test
    void nonAtomicMappingStoreIsToleratedAndStillResolvesEveryConcurrentMissWithoutError()
            throws Exception {
        VertexLikeSessionService service = new VertexLikeSessionService();
        SessionManager manager = new SessionManager(
                service,
                mock(BaseMemoryService.class),
                new DeliberatelyNonAtomicMappingStore(), new AdkAgUiOptions(false));
        AdkAgUiRunContext context = sessionContext("bob", "thread");

        int workers = 4;
        ExecutorService pool = Executors.newFixedThreadPool(workers);
        CountDownLatch go = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(workers);
        List<ResolvedSession> results = new CopyOnWriteArrayList<>();
        List<Throwable> failures = new CopyOnWriteArrayList<>();
        for (int index = 0; index < workers; index++) {
            pool.submit(() -> {
                try {
                    go.await(5, TimeUnit.SECONDS);
                    results.add(manager.resolveSession(context).blockingGet());
                } catch (Throwable failure) {
                    failures.add(failure);
                } finally {
                    done.countDown();
                }
            });
        }
        go.countDown();
        assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();
        pool.shutdown();

        assertThat(failures).isEmpty();
        assertThat(results).hasSize(workers);
        // Every concurrent miss resolves to a real, non-null session without error or deadlock
        // even under a deliberately non-atomic mapping store. Whether the racy pre-create scans
        // happen to converge onto one session (recoverGeneratedMapping thread-marker reuse) or
        // allocate several (duplicate mappings) is scheduling-dependent, so it is not asserted
        // here; the deterministic duplicate-tolerance behavior under coordinated concurrent
        // misses is covered in SessionMappingTest.nonAtomicStoreAllocatesDuplicateMappings...
        assertThat(results).allSatisfy(result -> {
            assertThat(result.session()).isNotNull();
            assertThat(result.session().id()).isNotBlank();
            assertThat(result.mapping()).isNotNull();
        });
    }

    // ---------------------------------------------------------------------
    // 5. Cross-instance HITL: two agents sharing one confirmation store resolve once
    // ---------------------------------------------------------------------

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void simultaneousIndependentAgentsResolveOneConfirmationExactlyOnce() throws Exception {
        SessionConfirmationRequestStore confirmations = new SessionConfirmationRequestStore();
        confirmations.persist(new ConfirmationRequest(
                new PendingCallScope("test-app", "test-user", "thread"), "invocation", "call"))
                .blockingAwait();
        BlockingRunner runner = new BlockingRunner();

        GoogleAdkAgent first = hitlAgent(existingSessions(), runner, confirmations);
        GoogleAdkAgent second = hitlAgent(existingSessions(), runner, confirmations);

        Thread owner = Thread.ofVirtual().start(() -> collectUnchecked(
                first.run(confirmationInput("invocation", "call", true))));
        assertThat(runner.started.await(5, TimeUnit.SECONDS)).isTrue();
        List<Event> loser = collect(second.run(confirmationInput("invocation", "call", true)));
        runner.finish.onComplete();
        owner.join();

        assertThat(runner.calls).hasValue(1);
        assertThat(loser).containsExactly(
                new RunErrorEvent("Unknown tool result", "UNKNOWN_TOOL_RESULT", null, null));
    }

    // ---------------------------------------------------------------------
    // 6. Cancellation during each phase
    // ---------------------------------------------------------------------

    @Test
    void cancellationDuringLlmStreamingCancelsRunnerExactlyOnce() throws InterruptedException {
        AtomicInteger cancelled = new AtomicInteger();
        BlockingStreamRunner runner = new BlockingStreamRunner(cancelled);
        GoogleAdkAgent agent = agent(
                runner, new AdkAgUiOptions(false, Duration.ofSeconds(10), 1), ignored -> TEST_USER);

        RecordingFlowSubscriber<Event> subscriber = subscribe(agent.run(input("m", "t", "r")));
        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.calls.get()).isEqualTo(1);

        subscriber.cancel();

        assertThat(cancelled.get()).isEqualTo(1);
        assertThat(runner.calls.get()).isEqualTo(1);
    }

    @Test
    void cancellationDuringToolExecutionClosesResourcesExactlyOnce() throws InterruptedException {
        AtomicInteger cancelled = new AtomicInteger();
        AtomicInteger active = new AtomicInteger();
        ControlledRunner runner = new ControlledRunner(cancelled, active);
        GoogleAdkAgent agent = agent(
                runner, new AdkAgUiOptions(false, Duration.ofSeconds(10), 1), ignored -> TEST_USER);

        RecordingFlowSubscriber<Event> subscriber = subscribe(agent.run(input("one", "thread-one", "run-one")));
        assertThat(runner.startedFor("run-one").await(1, TimeUnit.SECONDS)).isTrue();

        subscriber.cancel();
        runner.complete("run-one");

        assertThat(cancelled.get()).isEqualTo(1);
        assertThat(active.get()).isZero();
    }

    @Test
    void cancellationDuringPersistentAppendKeepsReservationAndLeaseUntilCommitSettles()
            throws InterruptedException {
        CompletableSubject append = CompletableSubject.create();
        SessionManager sessions = sessions(resolvedSession("session", "thread"));
        CollectedRunner runner = new CollectedRunner();
        GoogleAdkAgent agent = agent(sessions, runner, new AdkAgUiOptions(false, Duration.ofSeconds(10), 1));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(append);

        RecordingFlowSubscriber<Event> first = subscribe(agent.run(input("m", "t", "r")));
        assertThat(runner.runCount()).isOne();
        assertThat(append.hasObservers()).isTrue();

        first.cancel();
        RecordingFlowSubscriber<Event> retry = subscribe(agent.run(input("m", "t", "r")));

        assertThat(runner.runCount()).isOne();
        append.onComplete();
        assertThat(retry.await(Duration.ofSeconds(5))).isTrue();
        assertThat(runner.runCount()).isOne();

        RecordingFlowSubscriber<Event> afterCommit = subscribe(agent.run(input("m", "t", "r")));
        assertThat(afterCommit.await(Duration.ofSeconds(5))).isTrue();
        assertThat(runner.runCount()).isOne();
    }

    @Test
    void cancellationDuringSseEmissionClosesResourcesExactlyOnce() {
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
        // RunLifecycle emits its own RunStartedEvent before the subscriber is cancelled.
        assertThat(observer.values()).hasSize(1);
    }

    // ---------------------------------------------------------------------
    // 7. Cancellation is non-blocking even while a rollback is pending
    // ---------------------------------------------------------------------

    @Test
    void cancellationReturnsInUnderOneHundredMillisWhileRollbackIsPending() throws InterruptedException {
        CompletableSubject rollback = CompletableSubject.create();
        ControllableReservationStore reservations = new ControllableReservationStore(rollback);
        SessionManager sessions = sessions(resolvedSession("session", "thread"));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());
        CollectedRunner runner = new CollectedRunner();
        runner.neverComplete();
        GoogleAdkAgent agent = agent(runner, sessions, reservations,
                new AdkAgUiOptions(false, Duration.ofSeconds(10), 1));

        RecordingFlowSubscriber<Event> cancelled = subscribe(agent.run(input("m", "t", "r")));
        assertThat(runner.awaitFirstRun()).isTrue();
        assertThat(runner.runCount()).isOne();
        long startedAt = System.nanoTime();
        cancelled.cancel();
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt);
        RecordingFlowSubscriber<Event> retry = subscribe(agent.run(input("m", "t", "r")));

        assertThat(elapsedMillis).isLessThan(100L);
        assertThat(runner.runCount()).isOne();
        runner.completeNormally();
        rollback.onComplete();
        assertThat(retry.await(Duration.ofSeconds(5))).isTrue();
        assertThat(runner.runCount()).isEqualTo(2);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /** Builds an agent over the ordinary path with a mock session manager that resolves from context. */
    private static GoogleAdkAgent agent(
            AdkRunnerClient runner, AdkAgUiOptions options, Function<RunAgentInput, String> userIdExtractor) {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenAnswer(invocation -> {
            AdkAgUiRunContext context = invocation.getArgument(0);
            Session session = Session.builder(context.sessionId()).appName(context.appName())
                    .userId(context.userId()).state(Map.of()).build();
            return Single.just(new ResolvedSession(session, new SessionMapping(
                    new SessionMappingKey(context.appName(), context.userId(), context.threadId()),
                    context.sessionId())));
        });
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .userIdExtractor(userIdExtractor)
                .configuredBackendToolNames(List.of())
                .options(options)
                .build();
    }

    private static GoogleAdkAgent agent(
            SessionManager sessions, AdkRunnerClient runner, AdkAgUiOptions options) {
        return agent(runner, sessions, null, options);
    }

    private static GoogleAdkAgent agent(
            AdkRunnerClient runner,
            SessionManager sessions,
            MessageReservationStore reservationStore,
            AdkAgUiOptions options) {
        GoogleAdkAgent.Builder builder = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .userIdExtractor(ignored -> TEST_USER)
                .configuredBackendToolNames(List.of())
                .options(options);
        if (reservationStore != null) {
            builder.messageReservationStore(reservationStore);
        }
        return builder.build();
    }

    private static GoogleAdkAgent hitlAgent(
            SessionManager sessions, AdkRunnerClient runner, ConfirmationRequestStore confirmations) {
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .confirmationRequestStore(confirmations)
                .userIdExtractor(ignored -> TEST_USER)
                .configuredBackendToolNames(List.of())
                .options(AdkAgUiOptions.defaults())
                .build();
    }

    /** Default mock session manager: resolveSession + mutation guard + processed marker. */
    private static SessionManager sessions(ResolvedSession session) {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(session));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        return sessions;
    }

    private static SessionManager existingSessions() {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession("thread", "thread")));
        return sessions;
    }

    private static ResolvedSession resolvedSession(String sessionId, String threadId) {
        return new ResolvedSession(
                Session.builder(sessionId).appName("test-app").userId(TEST_USER).build(),
                new SessionMapping(new SessionMappingKey("test-app", TEST_USER, threadId), sessionId));
    }

    private static RunAgentInput input(String messageId, String threadId, String runId) {
        return input(messageId, threadId, runId, TEST_USER);
    }

    private static RunAgentInput input(String messageId, String threadId, String runId, String userId) {
        return new RunAgentInput(threadId, runId, Map.of(), List.of(new UserMessage(messageId, "Hello")),
                List.of(), List.of(new Context("appName", "test-app")), Map.of("user", userId));
    }

    private static RunAgentInput confirmationInput(String invocationId, String toolCallId, boolean approved) {
        return RunExtensionSupport.attach(
                new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null),
                new AdkRunExtensions(null, List.of()));
    }

    private static AdkAgUiRunContext sessionContext(String userId, String threadId) {
        return new AdkAgUiRunContext("app", userId, threadId, "run", null, threadId,
                new RunAgentInput(threadId, "run", Map.of(), List.of(), List.of(), List.of(), Map.of()),
                List.of(), new ToolCallLedger(), new CancellationToken(), RequestResourceRegistry.create(), "invocation");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> forwarded(RunAgentInput input) {
        return (Map<String, Object>) input.forwardedProps();
    }

    private static RecordingFlowSubscriber<Event> subscribe(Flow.Publisher<Event> publisher) {
        RecordingFlowSubscriber<Event> subscriber = new RecordingFlowSubscriber<>();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static List<Event> collect(Flow.Publisher<Event> publisher) throws InterruptedException {
        List<Event> events = new ArrayList<>();
        CountDownLatch terminal = new CountDownLatch(1);
        publisher.subscribe(new Flow.Subscriber<>() {
            @Override public void onSubscribe(Flow.Subscription subscription) { subscription.request(Long.MAX_VALUE); }
            @Override public void onNext(Event item) { events.add(item); }
            @Override public void onError(Throwable error) { throw new AssertionError(error); }
            @Override public void onComplete() { terminal.countDown(); }
        });
        assertThat(terminal.await(5, TimeUnit.SECONDS)).isTrue();
        return events;
    }

    private static void collectUnchecked(Flow.Publisher<Event> publisher) {
        try {
            collect(publisher);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new AssertionError(exception);
        }
    }

    // ---------------------------------------------------------------------
    // Runners / stores
    // ---------------------------------------------------------------------

    private static final class ControlledRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicInteger active;
        private final AtomicInteger cancelled;
        private final AtomicInteger resourcesClosed = new AtomicInteger();
        private final CountDownLatch allIsolatedStarted;
        private final Map<String, CompletableSubject> completions = new ConcurrentHashMap<>();
        private final Map<String, CountDownLatch> starts = new ConcurrentHashMap<>();
        private final List<String> startOrder = new CopyOnWriteArrayList<>();

        private ControlledRunner(int isolatedRuns) {
            this.allIsolatedStarted = new CountDownLatch(isolatedRuns);
            this.active = new AtomicInteger();
            this.cancelled = new AtomicInteger();
        }

        private ControlledRunner(AtomicInteger cancelled, AtomicInteger active) {
            this.allIsolatedStarted = new CountDownLatch(0);
            this.active = active;
            this.cancelled = cancelled;
        }

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            AdkAgUiRunContext context = AdkAgUiRunContext.from(runConfig).orElseThrow();
            context.resources().register(resourcesClosed::incrementAndGet);
            String runId = context.runId();
            CompletableSubject completion = CompletableSubject.create();
            completions.put(runId, completion);
            calls.incrementAndGet();
            active.incrementAndGet();
            startOrder.add(runId);
            starts.computeIfAbsent(runId, ignored -> new CountDownLatch(1)).countDown();
            if (runId.startsWith("isolated-run-")) {
                allIsolatedStarted.countDown();
            }
            return completion.<com.google.adk.events.Event>toFlowable()
                    .doOnCancel(cancelled::incrementAndGet)
                    .doFinally(active::decrementAndGet);
        }

        private CountDownLatch startedFor(String runId) {
            return starts.computeIfAbsent(runId, ignored -> new CountDownLatch(1));
        }

        private void complete(String runId) {
            CompletableSubject completion = completions.get(runId);
            assertThat(completion).as("completion for %s", runId).isNotNull();
            completion.onComplete();
        }

        private List<String> sameKeyOrder() {
            return startOrder.stream().filter(runId -> runId.startsWith("same-run-")).toList();
        }

        private List<String> orderFor(String prefix) {
            return startOrder.stream().filter(runId -> runId.startsWith(prefix)).toList();
        }
    }

    private static final class ConcurrentRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicInteger resourcesClosed = new AtomicInteger();
        private final AtomicInteger active = new AtomicInteger();
        private final AtomicInteger maxConcurrent = new AtomicInteger();
        private final CountDownLatch allStarted;
        private final Map<String, CompletableSubject> completions = new ConcurrentHashMap<>();

        private ConcurrentRunner(int runs) {
            allStarted = new CountDownLatch(runs);
        }

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            AdkAgUiRunContext context = AdkAgUiRunContext.from(runConfig).orElseThrow();
            context.resources().register(resourcesClosed::incrementAndGet);
            String runId = context.runId();
            CompletableSubject completion = CompletableSubject.create();
            completions.put(runId, completion);
            calls.incrementAndGet();
            allStarted.countDown();
            int current = active.incrementAndGet();
            maxConcurrent.accumulateAndGet(current, Math::max);
            return completion.<com.google.adk.events.Event>toFlowable()
                    .doFinally(active::decrementAndGet);
        }

        private void complete(String runId) {
            completions.get(runId).onComplete();
        }
    }

    private static final class PerUserRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicInteger active = new AtomicInteger();
        private final AtomicInteger cancelled = new AtomicInteger();
        private final AtomicInteger resourcesClosed = new AtomicInteger();
        private final Map<String, CompletableSubject> completions = new ConcurrentHashMap<>();
        private final Map<String, CountDownLatch> starts = new ConcurrentHashMap<>();
        private final List<String> startOrder = new CopyOnWriteArrayList<>();

        private PerUserRunner(int runs) {
        }

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            AdkAgUiRunContext context = AdkAgUiRunContext.from(runConfig).orElseThrow();
            context.resources().register(resourcesClosed::incrementAndGet);
            String runId = context.runId();
            CompletableSubject completion = CompletableSubject.create();
            completions.put(runId, completion);
            calls.incrementAndGet();
            active.incrementAndGet();
            startOrder.add(runId);
            starts.computeIfAbsent(runId, ignored -> new CountDownLatch(1)).countDown();
            return completion.<com.google.adk.events.Event>toFlowable()
                    .doOnCancel(cancelled::incrementAndGet)
                    .doFinally(active::decrementAndGet);
        }

        private CountDownLatch startedFor(String runId) {
            return starts.computeIfAbsent(runId, ignored -> new CountDownLatch(1));
        }

        private void complete(String runId) {
            completions.get(runId).onComplete();
        }

        private List<String> orderFor(String prefix) {
            return startOrder.stream().filter(runId -> runId.startsWith(prefix)).toList();
        }
    }

    private static final class BlockingRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final CountDownLatch started = new CountDownLatch(1);
        private final CompletableSubject finish = CompletableSubject.create();

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            calls.incrementAndGet();
            started.countDown();
            return finish.andThen(Flowable.empty());
        }
    }

    private static final class BlockingStreamRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final CountDownLatch started = new CountDownLatch(1);
        private final AtomicInteger cancelled;

        private BlockingStreamRunner(AtomicInteger cancelled) {
            this.cancelled = cancelled;
        }

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            calls.incrementAndGet();
            started.countDown();
            return Flowable.<com.google.adk.events.Event>never()
                    .doOnCancel(cancelled::incrementAndGet);
        }
    }

    private static final class CollectedRunner implements AdkRunnerClient {
        private final CountDownLatch firstRun = new CountDownLatch(1);
        private int runCount;
        private Throwable failure;
        private boolean neverCompletes;

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            runCount++;
            firstRun.countDown();
            if (neverCompletes) {
                return Flowable.never();
            }
            return failure == null ? Flowable.empty() : Flowable.error(failure);
        }

        int runCount() {
            return runCount;
        }

        boolean awaitFirstRun() throws InterruptedException {
            return firstRun.await(5, TimeUnit.SECONDS);
        }

        void neverComplete() {
            neverCompletes = true;
        }

        void completeNormally() {
            neverCompletes = false;
        }
    }

    private static final class ControllableReservationStore implements MessageReservationStore {
        private final Completable rollback;

        private ControllableReservationStore(Completable rollback) {
            this.rollback = rollback;
        }

        @Override
        public Single<MessageReservation> reserve(
                ResolvedSession session, List<Message> messages, String invocationId) {
            return Single.just(new MessageReservation(session, messages, invocationId));
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.complete();
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return rollback;
        }
    }

    private static final class DeliberatelyNonAtomicMappingStore implements ThreadSessionMappingStore {
        @Override
        public Single<SessionMapping> getOrCreateMapping(
                SessionMappingKey key, Supplier<Single<SessionMapping>> factory) {
            return Single.defer(factory::get);
        }

        @Override
        public Completable invalidate(SessionMappingKey key) {
            return Completable.complete();
        }

        @Override
        public boolean isDistributedAtomic() {
            return false;
        }
    }


}
