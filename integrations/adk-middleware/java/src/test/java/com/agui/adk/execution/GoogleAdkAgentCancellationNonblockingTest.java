package com.agui.adk;

import com.agui.adk.execution.CancellationToken;
import com.agui.adk.execution.ExecutionKey;
import com.agui.adk.execution.ExecutionLease;
import com.agui.adk.execution.InProcessExecutionCoordinator;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;
import java.util.Map;
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

class GoogleAdkAgentCancellationNonblockingTest {

    @Test
    void cancellingQueuedPublicRunReturnsWhileEarlierPromotionDeliveryIsBlocked() throws Exception {
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        ExecutionKey key = new ExecutionKey("app", "user", "thread");
        ExecutionLease active = coordinator.acquire(key, new CancellationToken()).blockingGet();
        CountDownLatch promotionDeliveryStarted = new CountDownLatch(1);
        CountDownLatch releasePromotionDelivery = new CountDownLatch(1);
        CountDownLatch cancellationReturned = new CountDownLatch(1);
        CountDownLatch publicGuardClosed = new CountDownLatch(1);
        AtomicReference<Throwable> rawError = new AtomicReference<>();
        AtomicReference<Flow.Subscription> publicSubscription = new AtomicReference<>();
        AtomicInteger runnerCalls = new AtomicInteger();

        coordinator.acquire(key, new CancellationToken()).subscribe(lease -> {
            promotionDeliveryStarted.countDown();
            try {
                assertThat(releasePromotionDelivery.await(1, TimeUnit.SECONDS)).isTrue();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new AssertionError(error);
            }
            lease.close();
        });

        GoogleAdkAgent agent = agent(coordinator, publicGuardClosed, runnerCalls);
        agent.run(input("queued")).subscribe(new Flow.Subscriber<>() {
            @Override
            public void onSubscribe(Flow.Subscription subscription) {
                publicSubscription.set(subscription);
                subscription.request(Long.MAX_VALUE);
            }

            @Override
            public void onNext(Event event) {
                // The queued run has not reached its runner before cancellation.
            }

            @Override
            public void onError(Throwable error) {
                rawError.set(error);
            }

            @Override
            public void onComplete() {
                // Cancellation is not a public terminal event.
            }
        });
        assertThat(publicSubscription).hasValueSatisfying(value -> assertThat(value).isNotNull());

        Thread releaseActive = new Thread(active::close);
        releaseActive.start();
        assertThat(promotionDeliveryStarted.await(1, TimeUnit.SECONDS)).isTrue();

        Thread cancellation = new Thread(() -> {
            publicSubscription.get().cancel();
            cancellationReturned.countDown();
        });
        cancellation.start();
        try {
            assertThat(cancellationReturned.await(250, TimeUnit.MILLISECONDS)).isTrue();
        } finally {
            releasePromotionDelivery.countDown();
            assertThat(joined(releaseActive)).isTrue();
            assertThat(joined(cancellation)).isTrue();
        }

        assertThat(publicGuardClosed.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(rawError.get()).isNull();
        assertThat(runnerCalls).hasValue(0);

        RecordingSubscriber later = subscribe(agent.run(input("later")));
        assertThat(later.terminal.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(later.error.get()).isNull();
        assertThat(runnerCalls).hasValue(1);
    }

    private static boolean joined(Thread thread) throws InterruptedException {
        thread.join(TimeUnit.SECONDS.toMillis(1));
        return !thread.isAlive();
    }

    private static GoogleAdkAgent agent(
            InProcessExecutionCoordinator coordinator,
            CountDownLatch publicGuardClosed,
            AtomicInteger runnerCalls) {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenAnswer(invocation -> {
            AdkAgUiRunContext context = invocation.getArgument(0);
            Session session = Session.builder(context.sessionId()).appName(context.appName())
                    .userId(context.userId()).state(Map.of()).build();
            return Single.just(new ResolvedSession(session, new SessionMapping(
                    new SessionMappingKey(context.appName(), context.userId(), context.threadId()), context.sessionId())));
        });
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.fromCallable(() ->
                () -> publicGuardClosed.countDown()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        return GoogleAdkAgent.builder()
                .runner(new EmptyRunner(runnerCalls))
                .sessionManager(sessions)
                .executionCoordinator(coordinator)
                .userIdExtractor(ignored -> "user")
                .configuredBackendToolNames(List.of())
                .options(new AdkAgUiOptions(false, Duration.ofSeconds(5), 1))
                .build();
    }

    private static RunAgentInput input(String runId) {
        return new RunAgentInput("thread", runId, Map.of(), List.of(new UserMessage(runId, "Hello")),
                List.of(), List.of(new Context("appName", "app")), Map.of());
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static final class EmptyRunner implements AdkRunnerClient {
        private final AtomicInteger calls;

        private EmptyRunner(AtomicInteger calls) {
            this.calls = calls;
        }

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            calls.incrementAndGet();
            return Flowable.empty();
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final CountDownLatch terminal = new CountDownLatch(1);
        private final AtomicReference<Throwable> error = new AtomicReference<>();

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event event) {
            // Only terminal completion and raw error containment matter for recovery.
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
    }
}
