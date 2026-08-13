package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.events.Event;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.execution.CancellationToken;
import com.agui.adk.execution.ExecutionKey;
import com.agui.adk.execution.ExecutionLease;
import com.agui.adk.execution.InProcessExecutionCoordinator;
import com.agui.adk.history.MessageHistoryProvider;
import com.agui.adk.session.InMemoryThreadSessionMappingStore;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.disposables.Disposable;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GoogleAdkAgentHistoryOwnershipTest {

    @Test
    void recoveredHistoryFailureReleasesTheRealSessionGuardAndSameKeyCoordinatorLease() throws Exception {
        Fixture fixture = fixture();
        RecordingSubscriber failed = subscribe(fixture.agent.run(input("same", "failed", "failed-message")));

        assertSuccessfulTerminal(failed);

        ExecutionLease guardProbe = acquireGuard(fixture.manager, fixture.session("same"));
        try {
            guardProbe.close();

            RecordingSubscriber later = subscribe(fixture.agent.run(input("same", "later", "later-message")));
            assertSuccessfulTerminal(later);
            // The optional snapshot failure is recovered after the first runner completes; the
            // second run still executes normally after ownership is released.
            assertThat(fixture.runner.calls).hasValue(2);
        } finally {
            guardProbe.close();
        }
    }

    @Test
    void recoveredHistoryFailureReleasesTheGlobalSlotForAnUnrelatedKey() throws Exception {
        Fixture fixture = fixture();
        RecordingSubscriber failed = subscribe(fixture.agent.run(input("first", "failed", "failed-message")));

        assertSuccessfulTerminal(failed);

        RecordingSubscriber unrelated = subscribe(fixture.agent.run(input("second", "later", "later-message")));
        assertSuccessfulTerminal(unrelated);
        // The optional snapshot failure is recovered; both accepted runs execute the runner.
        assertThat(fixture.runner.calls).hasValue(2);
    }

    @Test
    void cancelledQueuedOrdinaryRunReleasesItsDeliveredRealSessionGuard() throws Exception {
        Fixture fixture = fixture(false, Duration.ofSeconds(5));
        Session session = fixture.session("same");
        ExecutionKey key = new ExecutionKey("app", "user", "same");
        ExecutionLease heldExecution = acquireExecutionLease(fixture.coordinator, key);
        try {
            RecordingSubscriber cancelled = subscribe(fixture.agent.run(input("same", "cancelled", "cancelled-message")));
            assertThatThrownBy(() -> acquireGuard(fixture.manager, session))
                    .isInstanceOf(AssertionError.class)
                    .hasMessageContaining("Expecting value to be true but was false");

            cancelled.cancel();
        } finally {
            heldExecution.close();
        }

        ExecutionLease laterGuard = acquireGuard(fixture.manager, session);
        try {
            laterGuard.close();
            RecordingSubscriber later = subscribe(fixture.agent.run(input("same", "later", "later-message")));
            assertSuccessfulTerminal(later);
            assertThat(fixture.runner.calls).hasValue(1);
        } finally {
            laterGuard.close();
        }
    }

    @Test
    void timedOutQueuedGuardProbeIsCancelledBeforeTheHeldGuardIsReleased() throws Exception {
        Fixture fixture = fixture();
        Session session = fixture.session("same");
        ExecutionLease heldGuard = acquireGuard(fixture.manager, session);
        try {
            assertThatThrownBy(() -> acquireGuard(fixture.manager, session))
                    .isInstanceOf(AssertionError.class)
                    .hasMessageContaining("Expecting value to be true but was false");
        } finally {
            heldGuard.close();
        }

        ExecutionLease laterGuard = acquireGuard(fixture.manager, session);
        try {
            assertThat(laterGuard).isNotNull();
        } finally {
            laterGuard.close();
        }
    }

    private static Fixture fixture() {
        return fixture(true, Duration.ofSeconds(1));
    }

    private static Fixture fixture(boolean failFirstHistoryRead, Duration runTimeout) {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        when(sessions.getSession(any(), any(), any(), any())).thenAnswer(invocation -> {
            String appName = invocation.getArgument(0, String.class);
            String userId = invocation.getArgument(1, String.class);
            String sessionId = invocation.getArgument(2, String.class);
            return Single.just(Session.builder(sessionId).appName(appName).userId(userId)
                    .state(new java.util.concurrent.ConcurrentHashMap<>()).build()).toMaybe();
        });
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        SessionManager manager = new SessionManager(sessions, memory, new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
        AtomicBoolean throwFirstHistoryRead = new AtomicBoolean(failFirstHistoryRead);
        MessageHistoryProvider history = session -> {
            if (throwFirstHistoryRead.getAndSet(false)) {
                throw new IllegalStateException("history failed");
            }
            return Single.just(MessageHistoryProvider.Result.unavailable());
        };
        CountingRunner runner = new CountingRunner();
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(List.of())
                .userIdExtractor(ignored -> "user")
                .executionCoordinator(coordinator)
                .messageHistoryProvider(history)
                // Emit the optional end-of-run MESSAGES_SNAPSHOT. Python recovers refresh/provider
                // failures locally, while the public path must still release all execution ownership.
                .options(new AdkAgUiOptions(true, runTimeout, 1, null, true))
                .build();
        return new Fixture(agent, manager, coordinator, runner);
    }

    private static RunAgentInput input(String threadId, String runId, String messageId) {
        return new RunAgentInput(threadId, runId, Map.of(), List.of(new UserMessage(messageId, "hello")),
                List.of(), List.of(new Context("appName", "app")), Map.of());
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<com.agui.community.core.event.Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static ExecutionLease acquireGuard(SessionManager manager, Session session) throws InterruptedException {
        AtomicReference<Object> outcome = new AtomicReference<>(GuardProbeOutcome.PENDING);
        AtomicReference<Throwable> error = new AtomicReference<>();
        AtomicReference<Disposable> admission = new AtomicReference<>();
        CountDownLatch terminal = new CountDownLatch(1);
        boolean transferred = false;
        try {
            Disposable subscription = manager.acquireExecutionMutationGuard(session).subscribe(acquired -> {
                if (outcome.compareAndSet(GuardProbeOutcome.PENDING, acquired)) {
                    terminal.countDown();
                } else {
                    acquired.close();
                }
            }, failure -> {
                if (outcome.compareAndSet(GuardProbeOutcome.PENDING, GuardProbeOutcome.FAILED)) {
                    error.set(failure);
                    terminal.countDown();
                }
            });
            admission.set(subscription);

            assertThat(terminal.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(error.get()).isNull();
            Object acquired = outcome.get();
            assertThat(acquired).isInstanceOf(ExecutionLease.class);
            assertThat(outcome.compareAndSet(acquired, GuardProbeOutcome.TRANSFERRED)).isTrue();
            transferred = true;
            return (ExecutionLease) acquired;
        } finally {
            if (!transferred) {
                Object abandoned = outcome.getAndSet(GuardProbeOutcome.ABANDONED);
                Disposable subscription = admission.get();
                if (subscription != null) {
                    subscription.dispose();
                }
                if (abandoned instanceof ExecutionLease lease) {
                    lease.close();
                }
            }
        }
    }

    private static ExecutionLease acquireExecutionLease(
            InProcessExecutionCoordinator coordinator, ExecutionKey key) throws InterruptedException {
        AtomicReference<ExecutionLease> acquired = new AtomicReference<>();
        AtomicReference<Throwable> error = new AtomicReference<>();
        CountDownLatch terminal = new CountDownLatch(1);
        Disposable subscription = coordinator.acquire(key, new CancellationToken()).subscribe(lease -> {
            acquired.set(lease);
            terminal.countDown();
        }, failure -> {
            error.set(failure);
            terminal.countDown();
        });
        boolean transferred = false;
        try {
            assertThat(terminal.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(error.get()).isNull();
            assertThat(acquired.get()).isNotNull();
            transferred = true;
            return acquired.get();
        } finally {
            if (!transferred) {
                subscription.dispose();
                ExecutionLease lease = acquired.get();
                if (lease != null) {
                    lease.close();
                }
            }
        }
    }

    private enum GuardProbeOutcome {
        PENDING,
        FAILED,
        TRANSFERRED,
        ABANDONED
    }

    private static void assertTerminalError(RecordingSubscriber subscriber, String message) throws InterruptedException {
        assertThat(subscriber.await()).isTrue();
        subscriber.assertNoUpstreamError();
        assertThat(subscriber.events).hasSize(2);
        assertThat(subscriber.events.getFirst()).isEqualTo(new RunStartedEvent(subscriber.threadId(), subscriber.runId()));
        assertThat(subscriber.events.get(1)).isInstanceOfSatisfying(
                RunErrorEvent.class, error -> assertThat(error.message()).isEqualTo(message));
    }

    private static void assertSuccessfulTerminal(RecordingSubscriber subscriber) throws InterruptedException {
        assertThat(subscriber.await()).isTrue();
        subscriber.assertNoUpstreamError();
        assertThat(subscriber.events).containsExactly(
                new RunStartedEvent(subscriber.threadId(), subscriber.runId()),
                new RunFinishedEvent(subscriber.threadId(), subscriber.runId(), new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(subscriber.events).noneMatch(RunErrorEvent.class::isInstance);
    }

    private record Fixture(
            GoogleAdkAgent agent,
            SessionManager manager,
            InProcessExecutionCoordinator coordinator,
            CountingRunner runner) {
        private Session session(String threadId) {
            return Session.builder(threadId).appName("app").userId("user")
                    .state(new java.util.concurrent.ConcurrentHashMap<>()).build();
        }
    }

    private static final class CountingRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            calls.incrementAndGet();
            return Flowable.empty();
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<com.agui.community.core.event.Event> {
        private final List<com.agui.community.core.event.Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private final AtomicReference<Throwable> upstreamError = new AtomicReference<>();
        private Flow.Subscription subscription;
        private String threadId;
        private String runId;

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(com.agui.community.core.event.Event event) {
            events.add(event);
            if (event instanceof RunStartedEvent started) {
                threadId = started.threadId();
                runId = started.runId();
            }
        }

        @Override
        public void onError(Throwable error) {
            upstreamError.compareAndSet(null, error);
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

        private void assertNoUpstreamError() {
            assertThat(upstreamError.get()).isNull();
        }

        private String threadId() {
            return threadId;
        }

        private String runId() {
            return runId;
        }
    }
}
