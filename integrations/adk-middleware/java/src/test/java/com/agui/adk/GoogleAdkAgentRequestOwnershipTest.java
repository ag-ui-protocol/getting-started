package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.execution.CancellationToken;
import com.agui.adk.execution.ExecutionCoordinator;
import com.agui.adk.execution.ExecutionKey;
import com.agui.adk.execution.ExecutionLease;
import com.agui.adk.execution.InProcessExecutionCoordinator;
import com.agui.adk.message.MessageReservation;
import com.agui.adk.message.MessageReservationStore;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GoogleAdkAgentRequestOwnershipTest {

    @Test
    void successfulRunClosesFinalContextResourcesWithoutCancellingItsToken() throws InterruptedException {
        OwnershipRunner runner = OwnershipRunner.success();
        RecordingExecutionCoordinator coordinator = new RecordingExecutionCoordinator();
        RecordingSubscriber subscriber = subscribe(agent(runner, coordinator, Duration.ofSeconds(5), 1)
                .run(input("success")));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error.get()).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread-success", "success"),
                new RunFinishedEvent("thread-success", "success", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertRunnerOwnership(runner, coordinator, false);
    }

    @Test
    void runnerFailureClosesFinalContextResourcesWithoutCancellingItsToken() throws InterruptedException {
        OwnershipRunner runner = OwnershipRunner.failure(new IllegalStateException("runner failed"));
        RecordingExecutionCoordinator coordinator = new RecordingExecutionCoordinator();
        RecordingSubscriber subscriber = subscribe(agent(runner, coordinator, Duration.ofSeconds(5), 1)
                .run(input("failure")));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error.get()).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread-failure", "failure"),
                new RunErrorEvent("runner failed", "EXECUTION_ERROR", null, null));
        assertRunnerOwnership(runner, coordinator, false);
    }

    @Test
    void timedOutRunClosesFinalContextResourcesAndCancelsItsToken() throws InterruptedException {
        OwnershipRunner runner = OwnershipRunner.blocking();
        RecordingExecutionCoordinator coordinator = new RecordingExecutionCoordinator();
        RecordingSubscriber subscriber = subscribe(agent(runner, coordinator, Duration.ofMillis(100), 1)
                .run(input("timeout")));

        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error.get()).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread-timeout", "timeout"),
                new RunErrorEvent("Google ADK run timed out", "EXECUTION_TIMEOUT", null, null));
        assertRunnerOwnership(runner, coordinator, true);
    }

    @Test
    void clientCancellationClosesFinalContextResourcesAndCancelsItsToken() throws InterruptedException {
        OwnershipRunner runner = OwnershipRunner.blocking();
        RecordingExecutionCoordinator coordinator = new RecordingExecutionCoordinator();
        RecordingSubscriber subscriber = subscribe(agent(runner, coordinator, Duration.ofSeconds(5), 1)
                .run(input("cancelled")));
        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();

        subscriber.cancel();

        assertThat(subscriber.error.get()).isNull();
        assertRunnerOwnership(runner, coordinator, true);
    }

    @Test
    void globalConcurrencyRejectionCancelsRejectedFinalTokenAndDoesNotInvokeRunner()
            throws InterruptedException {
        OwnershipRunner runner = OwnershipRunner.blocking();
        RecordingExecutionCoordinator coordinator = new RecordingExecutionCoordinator();
        GoogleAdkAgent agent = agent(runner, coordinator, Duration.ofSeconds(5), 1);
        RecordingSubscriber active = subscribe(agent.run(input("active")));
        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();

        RecordingSubscriber rejected = subscribe(agent.run(input("rejected")));

        assertThat(rejected.await()).isTrue();
        assertThat(rejected.error.get()).isNull();
        assertThat(rejected.events).startsWith(
                new RunStartedEvent("thread-rejected", "rejected"),
                new RunErrorEvent(
                        "Global execution concurrency limit reached", "CONCURRENCY_LIMIT", null, null));
        assertThat(runner.calls).hasValue(1);
        assertThat(coordinator.tokens).hasSize(2);
        CancellationToken rejectedToken = coordinator.tokens.get(1);
        assertThat(rejectedToken.isCancelled()).isTrue();

        active.cancel();

        assertThat(active.error.get()).isNull();
        assertThat(runner.context.get().cancellation()).isSameAs(coordinator.tokens.get(0));
        assertThat(runner.context.get().cancellation().isCancelled()).isTrue();
        assertThat(runner.resourceCloses).hasValue(1);
    }

    @Test
    void finishedCallbackCanReenterWithoutObservingStaleGlobalAdmission() throws InterruptedException {
        OwnershipRunner runner = OwnershipRunner.success();
        RecordingExecutionCoordinator coordinator = new RecordingExecutionCoordinator();
        GoogleAdkAgent agent = agent(runner, coordinator, Duration.ofSeconds(5), 1);
        AtomicReference<RecordingSubscriber> reentrant = new AtomicReference<>();
        AtomicInteger leasesVisibleAtTerminal = new AtomicInteger(-1);

        RecordingSubscriber owner = subscribe(
                agent.run(input("owner")),
                event -> {
                    if (event instanceof RunFinishedEvent) {
                        leasesVisibleAtTerminal.set(coordinator.activeLeases.get());
                        reentrant.set(subscribe(agent.run(input("reentrant"))));
                    }
                });

        assertThat(owner.await()).isTrue();
        assertThat(owner.error.get()).isNull();
        assertThat(owner.events).startsWith(
                new RunStartedEvent("thread-owner", "owner"),
                new RunFinishedEvent("thread-owner", "owner", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertSuccessfulReentry(reentrant, leasesVisibleAtTerminal);
        assertThat(runner.calls).hasValue(2);
    }

    @Test
    void asynchronouslyFinishedCallbackCanReenterWithoutObservingStaleGlobalAdmission()
            throws InterruptedException {
        OwnershipRunner runner = OwnershipRunner.success();
        RecordingExecutionCoordinator coordinator = new RecordingExecutionCoordinator();
        CompletableSubject durableAppend = CompletableSubject.create();
        GoogleAdkAgent agent = agent(runner, coordinator, Duration.ofSeconds(5), 1, durableAppend);
        AtomicReference<RecordingSubscriber> reentrant = new AtomicReference<>();
        AtomicInteger leasesVisibleAtTerminal = new AtomicInteger(-1);
        RecordingSubscriber owner = subscribe(
                agent.run(input("owner-async-finished")),
                event -> {
                    if (event instanceof RunFinishedEvent) {
                        leasesVisibleAtTerminal.set(coordinator.activeLeases.get());
                        reentrant.set(subscribe(agent.run(input("reentrant"))));
                    }
                });
        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(coordinator.activeLeases).hasValue(1);

        durableAppend.onComplete();

        assertThat(owner.await()).isTrue();
        assertThat(owner.error.get()).isNull();
        assertThat(owner.events).startsWith(
                new RunStartedEvent("thread-owner-async-finished", "owner-async-finished"),
                new RunFinishedEvent("thread-owner-async-finished", "owner-async-finished", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertSuccessfulReentry(reentrant, leasesVisibleAtTerminal);
        assertThat(runner.calls).hasValue(2);
    }

    @Test
    void publicCancellationThatObservedActiveCannotRollbackAfterDurableFinalizationClaimsOwnership()
            throws InterruptedException {
        CompletableSubject runnerCompletion = CompletableSubject.create();
        OwnershipRunner runner = OwnershipRunner.completingWith(runnerCompletion);
        RecordingExecutionCoordinator coordinator = new RecordingExecutionCoordinator();
        CompletableSubject durableAppend = CompletableSubject.create();
        TrackingReservationStore reservations = new TrackingReservationStore();
        CountDownLatch cancellationReadActive = new CountDownLatch(1);
        CountDownLatch permitCancellationClaim = new CountDownLatch(1);
        GoogleAdkAgent agent = agent(
                runner,
                coordinator,
                Duration.ofSeconds(5),
                1,
                durableAppend,
                reservations,
                () -> {
                    cancellationReadActive.countDown();
                    await(permitCancellationClaim);
                });
        RecordingSubscriber subscriber = subscribe(agent.run(input("cancel-finalizing")));
        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();
        AtomicReference<Throwable> cancellationFailure = new AtomicReference<>();
        Thread cancellation = new Thread(() -> {
            try {
                subscriber.cancel();
            } catch (Throwable failure) {
                cancellationFailure.set(failure);
            }
        });

        cancellation.start();
        assertThat(cancellationReadActive.await(1, TimeUnit.SECONDS)).isTrue();

        runnerCompletion.onComplete();
        assertThat(durableAppend.hasObservers()).isTrue();
        durableAppend.onComplete();
        assertThat(reservations.commitStarted.await(1, TimeUnit.SECONDS)).isTrue();
        permitCancellationClaim.countDown();
        cancellation.join(1_000);

        assertThat(cancellation.isAlive()).isFalse();
        assertThat(cancellationFailure.get()).isNull();
        assertThat(reservations.commits).hasValue(1);
        assertThat(reservations.rollbacks).hasValue(0);
        assertThat(reservations.overlaps).hasValue(0);
        assertThat(coordinator.activeLeases).hasValue(1);
        assertThat(runner.resourceCloses).hasValue(1);
        assertThat(runner.context.get().cancellation().isCancelled()).isTrue();
        assertThat(subscriber.error.get()).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread-cancel-finalizing", "cancel-finalizing"));

        reservations.commit.onComplete();

        assertThat(reservations.commitSettled.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(coordinator.released.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(coordinator.activeLeases).hasValue(0);
        assertThat(reservations.commits).hasValue(1);
        assertThat(reservations.rollbacks).hasValue(0);
        assertThat(reservations.overlaps).hasValue(0);
        assertThat(subscriber.error.get()).isNull();
    }

    @Test
    void errorCallbackCanReenterWithoutObservingStaleGlobalAdmission() throws InterruptedException {
        AtomicInteger attempts = new AtomicInteger();
        OwnershipRunner runner = new OwnershipRunner(Flowable.defer(() -> attempts.getAndIncrement() == 0
                ? Flowable.error(new IllegalStateException("runner failed"))
                : Flowable.empty()));
        RecordingExecutionCoordinator coordinator = new RecordingExecutionCoordinator();
        GoogleAdkAgent agent = agent(runner, coordinator, Duration.ofSeconds(5), 1);
        AtomicReference<RecordingSubscriber> reentrant = new AtomicReference<>();
        AtomicInteger leasesVisibleAtTerminal = new AtomicInteger(-1);

        RecordingSubscriber owner = subscribe(
                agent.run(input("owner-error")),
                event -> {
                    if (event instanceof RunErrorEvent) {
                        leasesVisibleAtTerminal.set(coordinator.activeLeases.get());
                        reentrant.set(subscribe(agent.run(input("reentrant"))));
                    }
                });

        assertThat(owner.await()).isTrue();
        assertThat(owner.error.get()).isNull();
        assertThat(owner.events).startsWith(
                new RunStartedEvent("thread-owner-error", "owner-error"),
                new RunErrorEvent("runner failed", "EXECUTION_ERROR", null, null));
        assertSuccessfulReentry(reentrant, leasesVisibleAtTerminal);
        assertThat(runner.calls).hasValue(2);
    }

    private static void assertSuccessfulReentry(
            AtomicReference<RecordingSubscriber> reentrant,
            AtomicInteger leasesVisibleAtTerminal) throws InterruptedException {
        assertThat(reentrant.get()).isNotNull();
        assertThat(reentrant.get().await()).isTrue();
        assertThat(reentrant.get().error.get()).isNull();
        assertThat(reentrant.get().events).startsWith(
                new RunStartedEvent("thread-reentrant", "reentrant"),
                new RunFinishedEvent("thread-reentrant", "reentrant", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(leasesVisibleAtTerminal).hasValue(0);
    }

    private static void assertRunnerOwnership(
            OwnershipRunner runner,
            RecordingExecutionCoordinator coordinator,
            boolean cancelled) {
        AdkAgUiRunContext finalContext = runner.context.get();
        assertThat(finalContext).isNotNull();
        assertThat(coordinator.tokens).containsExactly(finalContext.cancellation());
        assertThat(finalContext.cancellation().isCancelled()).isEqualTo(cancelled);
        assertThat(runner.resourceCloses).hasValue(1);
    }

    private static GoogleAdkAgent agent(
            AdkRunnerClient runner,
            ExecutionCoordinator coordinator,
            Duration timeout,
            int globalConcurrencyLimit) {
        return agent(runner, coordinator, timeout, globalConcurrencyLimit, Completable.complete());
    }

    private static GoogleAdkAgent agent(
            AdkRunnerClient runner,
            ExecutionCoordinator coordinator,
            Duration timeout,
            int globalConcurrencyLimit,
            Completable durableAppend) {
        return agent(
                runner,
                coordinator,
                timeout,
                globalConcurrencyLimit,
                durableAppend,
                null,
                () -> { });
    }

    private static GoogleAdkAgent agent(
            AdkRunnerClient runner,
            ExecutionCoordinator coordinator,
            Duration timeout,
            int globalConcurrencyLimit,
            Completable durableAppend,
            MessageReservationStore reservations,
            Runnable beforeCancellationClaim) {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenAnswer(invocation -> {
            AdkAgUiRunContext context = invocation.getArgument(0);
            Session session = Session.builder(context.sessionId())
                    .appName(context.appName())
                    .userId(context.userId())
                    .state(Map.of())
                    .build();
            return Single.just(new ResolvedSession(session, new SessionMapping(
                    new SessionMappingKey(context.appName(), context.userId(), context.threadId()),
                    context.sessionId())));
        });
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(durableAppend);
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        GoogleAdkAgent.Builder builder = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .executionCoordinator(coordinator)
                .userIdExtractor(ignored -> "user")
                .configuredBackendToolNames(List.of())
                .options(new AdkAgUiOptions(false, timeout, globalConcurrencyLimit))
                .beforeReservationCancellationClaim(beforeCancellationClaim);
        if (reservations != null) {
            builder.messageReservationStore(reservations);
        }
        return builder.build();
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(1, TimeUnit.SECONDS)) {
                throw new AssertionError("Timed out waiting for test interleaving");
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError(error);
        }
    }

    private static RunAgentInput input(String runId) {
        return new RunAgentInput(
                "thread-" + runId,
                runId,
                Map.of(),
                List.of(new UserMessage("message-" + runId, "Hello")),
                List.of(),
                List.of(new Context("appName", "app")),
                Map.of());
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        return subscribe(publisher, ignored -> { });
    }

    private static RecordingSubscriber subscribe(
            Flow.Publisher<Event> publisher,
            Consumer<Event> onNext) {
        RecordingSubscriber subscriber = new RecordingSubscriber(onNext);
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static final class RecordingExecutionCoordinator implements ExecutionCoordinator {
        private final ExecutionCoordinator delegate = new InProcessExecutionCoordinator();
        private final List<CancellationToken> tokens = new ArrayList<>();
        private final AtomicInteger activeLeases = new AtomicInteger();
        private final CountDownLatch released = new CountDownLatch(1);

        @Override
        public Single<ExecutionLease> acquire(ExecutionKey key, CancellationToken cancellation) {
            tokens.add(cancellation);
            return delegate.acquire(key, cancellation).map(lease -> {
                activeLeases.incrementAndGet();
                AtomicInteger closed = new AtomicInteger();
                return () -> {
                    if (closed.compareAndSet(0, 1)) {
                        activeLeases.decrementAndGet();
                        try {
                            lease.close();
                        } finally {
                            released.countDown();
                        }
                    }
                };
            });
        }

        @Override
        public boolean isDistributed() {
            return delegate.isDistributed();
        }
    }

    private static final class OwnershipRunner implements AdkRunnerClient {
        private final Flowable<com.google.adk.events.Event> events;
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicInteger resourceCloses = new AtomicInteger();
        private final AtomicReference<AdkAgUiRunContext> context = new AtomicReference<>();
        private final CountDownLatch started = new CountDownLatch(1);

        private OwnershipRunner(Flowable<com.google.adk.events.Event> events) {
            this.events = events;
        }

        private static OwnershipRunner success() {
            return new OwnershipRunner(Flowable.empty());
        }

        private static OwnershipRunner failure(Throwable failure) {
            return new OwnershipRunner(Flowable.error(failure));
        }

        private static OwnershipRunner blocking() {
            return new OwnershipRunner(Flowable.never());
        }

        private static OwnershipRunner completingWith(Completable completion) {
            return new OwnershipRunner(completion.toFlowable());
        }

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId,
                String sessionId,
                Content content,
                RunConfig runConfig,
                Map<String, Object> stateDelta) {
            AdkAgUiRunContext finalContext = AdkAgUiRunContext.from(runConfig).orElseThrow();
            context.set(finalContext);
            finalContext.resources().register(resourceCloses::incrementAndGet);
            calls.incrementAndGet();
            started.countDown();
            return events;
        }
    }

    private static final class TrackingReservationStore implements MessageReservationStore {
        private final CompletableSubject commit = CompletableSubject.create();
        private final AtomicInteger commits = new AtomicInteger();
        private final AtomicInteger rollbacks = new AtomicInteger();
        private final AtomicInteger activeTerminalActions = new AtomicInteger();
        private final AtomicInteger overlaps = new AtomicInteger();
        private final CountDownLatch commitStarted = new CountDownLatch(1);
        private final CountDownLatch commitSettled = new CountDownLatch(1);

        @Override
        public Single<MessageReservation> reserve(
                ResolvedSession session,
                List<com.agui.community.core.message.Message> messages,
                String invocationId) {
            return Single.just(new MessageReservation(session, messages, invocationId));
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.defer(() -> {
                commits.incrementAndGet();
                beginTerminalAction();
                commitStarted.countDown();
                return commit.doFinally(() -> {
                    activeTerminalActions.decrementAndGet();
                    commitSettled.countDown();
                });
            });
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.fromAction(() -> {
                rollbacks.incrementAndGet();
                beginTerminalAction();
                activeTerminalActions.decrementAndGet();
            });
        }

        private void beginTerminalAction() {
            if (activeTerminalActions.incrementAndGet() != 1) {
                overlaps.incrementAndGet();
            }
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private final AtomicReference<Throwable> error = new AtomicReference<>();
        private final Consumer<Event> onNext;
        private Flow.Subscription subscription;

        private RecordingSubscriber(Consumer<Event> onNext) {
            this.onNext = onNext;
        }

        @Override
        public void onSubscribe(Flow.Subscription value) {
            subscription = value;
            value.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event event) {
            events.add(event);
            onNext.accept(event);
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

        private boolean await() throws InterruptedException {
            return terminal.await(1, TimeUnit.SECONDS);
        }

        private void cancel() {
            subscription.cancel();
        }
    }
}
