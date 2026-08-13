package com.agui.adk.execution;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.AdkAgUiOptions;
import com.agui.adk.AdkRunnerClient;
import com.agui.adk.GoogleAdkAgent;
import com.agui.adk.SessionManager;
import com.agui.adk.SessionManagerTestFixtures;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.adk.testsupport.RecordingFlowSubscriber;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ExecutionStressTest {

    @Test
    void typedOptionsPreserveTheBooleanConstructorAndUseSafeDefaults() {
        AdkAgUiOptions legacy = new AdkAgUiOptions(true);
        AdkAgUiOptions defaults = AdkAgUiOptions.defaults();

        assertThat(legacy.useThreadIdAsSessionId()).isTrue();
        assertThat(defaults.runTimeout()).isPositive();
        assertThat(defaults.globalConcurrencyLimit()).isPositive();
    }

    @Test
    void acceptedRunTimesOutOnceAndReleasesGlobalAdmission() throws InterruptedException {
        BlockingRunner runner = new BlockingRunner();
        GoogleAdkAgent agent = agent(runner, new AdkAgUiOptions(false, Duration.ofMillis(25), 1));

        RecordingFlowSubscriber<Event> timedOut = subscribe(agent.run(input("one", "thread-one", "run-one")));

        assertThat(timedOut.await(Duration.ofSeconds(1))).isTrue();
        assertThat(timedOut.error()).isNull();
        assertThat(timedOut.events()).startsWith(
                new RunStartedEvent("thread-one", "run-one"),
                new RunErrorEvent("Google ADK run timed out", "EXECUTION_TIMEOUT", null, null));
        assertThat(runner.cancelled.get()).isEqualTo(1);

        RecordingFlowSubscriber<Event> admittedAfterTimeout = subscribe(agent.run(input("two", "thread-two", "run-two")));
        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();
        admittedAfterTimeout.cancel();
    }

    @Test
    void acceptedRunRejectsGlobalCapacityOnceWithoutQueueingAndReleasesItOnCancellation()
            throws InterruptedException {
        BlockingRunner runner = new BlockingRunner();
        GoogleAdkAgent agent = agent(runner, new AdkAgUiOptions(false, Duration.ofSeconds(5), 1));

        RecordingFlowSubscriber<Event> first = subscribe(agent.run(input("one", "thread-one", "run-one")));
        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();

        RecordingFlowSubscriber<Event> rejected = subscribe(agent.run(input("two", "thread-two", "run-two")));
        assertThat(rejected.await(Duration.ofSeconds(1))).isTrue();
        assertThat(rejected.error()).isNull();
        assertThat(rejected.events()).startsWith(
                new RunStartedEvent("thread-two", "run-two"),
                new RunErrorEvent("Global execution concurrency limit reached", "CONCURRENCY_LIMIT", null, null));
        assertThat(runner.calls.get()).isEqualTo(1);

        first.cancel();
        assertThat(runner.cancelled.get()).isEqualTo(1);

        RecordingFlowSubscriber<Event> admittedAfterCancellation = subscribe(agent.run(input("three", "thread-three", "run-three")));
        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();
        admittedAfterCancellation.cancel();
    }

    @Test
    void publicAgentCoordinatesOneHundredTwentyRunsWithoutLeakingOwnership() throws InterruptedException {
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
                    "isolated-message-" + index,
                    "isolated-thread-" + index,
                    "isolated-run-" + index,
                    "isolated-user-" + index))));
        }

        assertThat(runner.allIsolatedStarted.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.startedFor("same-run-0").await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.calls.get()).isEqualTo(isolatedRuns + 1);
        assertThat(runner.startOrder()).containsSubsequence("same-run-0");

        for (int index = 0; index < isolatedRuns; index++) {
            runner.complete("isolated-run-" + index);
        }
        for (int index = 0; index < sameKeyRuns; index++) {
            String runId = "same-run-" + index;
            assertThat(runner.startedFor(runId).await(1, TimeUnit.SECONDS)).isTrue();
            runner.complete(runId);
        }

        for (RecordingFlowSubscriber<Event> subscriber : subscribers) {
            assertThat(subscriber.await(Duration.ofSeconds(1))).isTrue();
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

    @Test
    void publicAgentReleasesGlobalAdmissionAcrossOneHundredTwentyCancellationTransitions()
            throws InterruptedException {
        int runs = 120;
        ControlledRunner runner = new ControlledRunner(0);
        GoogleAdkAgent agent = agent(
                runner,
                new AdkAgUiOptions(false, Duration.ofSeconds(10), 1),
                ignored -> "user");

        for (int index = 0; index < runs; index++) {
            String runId = "cancel-run-" + index;
            RecordingFlowSubscriber<Event> active = subscribe(agent.run(input(
                    "cancel-message-" + index, "cancel-thread-" + index, runId)));
            assertThat(runner.startedFor(runId).await(1, TimeUnit.SECONDS)).isTrue();

            RecordingFlowSubscriber<Event> rejected = subscribe(agent.run(input(
                    "rejected-message-" + index, "rejected-thread-" + index, "rejected-run-" + index)));
            assertThat(rejected.await(Duration.ofSeconds(1))).isTrue();
            assertThat(rejected.error()).isNull();
            assertThat(rejected.events()).startsWith(
                    new RunStartedEvent("rejected-thread-" + index, "rejected-run-" + index),
                    new RunErrorEvent(
                            "Global execution concurrency limit reached", "CONCURRENCY_LIMIT", null, null));

            active.cancel();
            assertThat(runner.cancelled.get()).isEqualTo(index + 1);
            assertThat(runner.active.get()).isZero();
            assertThat(runner.resourcesClosed.get()).isEqualTo(index + 1);
        }
        assertThat(runner.calls.get()).isEqualTo(runs);
    }

    private static GoogleAdkAgent agent(BlockingRunner runner, AdkAgUiOptions options) {
        return agent(runner, options, ignored -> "user");
    }

    private static GoogleAdkAgent agent(
            AdkRunnerClient runner,
            AdkAgUiOptions options,
            Function<RunAgentInput, String> userIdExtractor) {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenAnswer(invocation -> {
            AdkAgUiRunContext context = invocation.getArgument(0);
            Session session = Session.builder(context.sessionId()).appName(context.appName())
                    .userId(context.userId()).state(Map.of()).build();
            return Single.just(new ResolvedSession(session, new SessionMapping(
                    new SessionMappingKey(context.appName(), context.userId(), context.threadId()), context.sessionId())));
        });
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .userIdExtractor(userIdExtractor)
                .configuredBackendToolNames(List.of())
                .options(options)
                .build();
    }

    private static RunAgentInput input(String messageId, String threadId, String runId) {
        return input(messageId, threadId, runId, "user");
    }

    private static RunAgentInput input(String messageId, String threadId, String runId, String userId) {
        return new RunAgentInput(threadId, runId, Map.of(), List.of(new UserMessage(messageId, "Hello")),
                List.of(), List.of(new Context("appName", "app")), Map.of("user", userId));
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

    private static final class ControlledRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicInteger active = new AtomicInteger();
        private final AtomicInteger cancelled = new AtomicInteger();
        private final AtomicInteger resourcesClosed = new AtomicInteger();
        private final CountDownLatch allIsolatedStarted;
        private final Map<String, CompletableSubject> completions = new ConcurrentHashMap<>();
        private final Map<String, CountDownLatch> starts = new ConcurrentHashMap<>();
        private final List<String> startOrder = new CopyOnWriteArrayList<>();

        private ControlledRunner(int isolatedRuns) {
            allIsolatedStarted = new CountDownLatch(isolatedRuns);
        }

        @Override
        public String appName() {
            return "app";
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

        private List<String> startOrder() {
            return List.copyOf(startOrder);
        }

        private List<String> sameKeyOrder() {
            return startOrder.stream().filter(runId -> runId.startsWith("same-run-")).toList();
        }
    }

    private static final class BlockingRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicInteger cancelled = new AtomicInteger();
        private CountDownLatch started = new CountDownLatch(1);

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            calls.incrementAndGet();
            started.countDown();
            return Flowable.<com.google.adk.events.Event>never().doOnCancel(cancelled::incrementAndGet);
        }
    }


}
