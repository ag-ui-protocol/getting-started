package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.genai.types.Content;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Flowable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;

/**
 * Audit finding M-20: the agent must expose a public {@link AutoCloseable} {@code close()} that
 * cancels all in-flight runs, closes their request resources, and disposes the session manager
 * (Python {@code ADKAgent.close}).
 */
@ExtendWith(MockitoExtension.class)
class GoogleAdkAgentCloseTest {

    @Test
    void closeCancelsInFlightRunRequestsAndClosesTheirResources() throws Exception {
        CountDownLatch runnerStarted = new CountDownLatch(1);
        CountDownLatch cancelled = new CountDownLatch(1);
        CountDownLatch resourcesClosed = new CountDownLatch(1);
        BlockingRunner runner = new BlockingRunner(runnerStarted, cancelled, resourcesClosed);
        SessionManager manager = new SessionManager(
                new com.google.adk.sessions.InMemorySessionService(),
                mock(com.google.adk.memory.BaseMemoryService.class),
                new com.agui.adk.session.InMemoryThreadSessionMappingStore(),
                new AdkAgUiOptions(true));
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();

        ExecutorService executor = Executors.newSingleThreadExecutor();
        RecordingSubscriber subscriber = new RecordingSubscriber();
        try {
            executor.submit(() -> agent.run(input()).subscribe(subscriber));
            assertThat(runnerStarted.await(5, TimeUnit.SECONDS)).isTrue();

            agent.close();

            // The in-flight run's request cancellation token is cancelled and its request
            // resource registry is closed by the agent-owned close (Python ADKAgent.close).
            assertThat(cancelled.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(resourcesClosed.await(3, TimeUnit.SECONDS)).isTrue();
        } finally {
            subscriber.cancel();
            executor.shutdownNow();
        }
    }

    @Test
    void closeDisposesTheSessionManagerCleanupTaskAndCaches() {
        SessionManager manager = spy(new SessionManager(
                new com.google.adk.sessions.InMemorySessionService(),
                mock(com.google.adk.memory.BaseMemoryService.class),
                new com.agui.adk.session.InMemoryThreadSessionMappingStore(),
                new AdkAgUiOptions(true)));
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(new EmptyRunner())
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();

        agent.close();

        verify(manager).dispose();
    }

    @Test
    void closeClosesRunnerSessionAndMemoryResourcesExactlyOnce() {
        CloseableRunner runner = new CloseableRunner();
        CloseableSessionService sessions = new CloseableSessionService();
        CloseableMemoryService memory = new CloseableMemoryService();
        SessionManager manager = new SessionManager(sessions, memory);
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();

        agent.close();
        agent.close();

        assertThat(runner.closes).hasValue(1);
        assertThat(sessions.closes).hasValue(1);
        assertThat(memory.closes).hasValue(1);
    }

    @Test
    void closeIsIdempotentAndTheAgentRemainsUsableAfterwards() throws Exception {
        SessionManager manager = new SessionManager(
                new com.google.adk.sessions.InMemorySessionService(),
                mock(com.google.adk.memory.BaseMemoryService.class),
                new com.agui.adk.session.InMemoryThreadSessionMappingStore(),
                new AdkAgUiOptions(true));
        EmptyRunner runner = new EmptyRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();

        agent.close();
        agent.close();

        RecordingSubscriber subscriber = new RecordingSubscriber();
        agent.run(input()).subscribe(subscriber);
        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events).isNotEmpty();
    }

    private static RunAgentInput input() {
        return new RunAgentInput(
                "thread-1",
                "run-1",
                Map.of(),
                List.of(new UserMessage("message-1", "Hello")),
                List.of(),
                List.of(new Context("appName", "test-app")),
                Map.of());
    }

    /** Runner that blocks the run and exposes its request cancellation and resources. */
    private static final class BlockingRunner implements AdkRunnerClient {
        private final CountDownLatch runnerStarted;
        private final CountDownLatch cancelled;
        private final CountDownLatch resourcesClosed;

        private BlockingRunner(
                CountDownLatch runnerStarted, CountDownLatch cancelled, CountDownLatch resourcesClosed) {
            this.runnerStarted = runnerStarted;
            this.cancelled = cancelled;
            this.resourcesClosed = resourcesClosed;
        }

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId,
                String sessionId,
                Content content,
                RunConfig runConfig,
                Map<String, Object> stateDelta) {
            Object metadata = runConfig.customMetadata().get(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY);
            assertThat(metadata).isInstanceOf(AdkAgUiRunContext.class);
            AdkAgUiRunContext context = (AdkAgUiRunContext) metadata;
            context.cancellation().onCancel(cancelled::countDown);
            context.resources().register((AutoCloseable) resourcesClosed::countDown);
            runnerStarted.countDown();
            return Flowable.never();
        }
    }

    private static final class CloseableRunner extends EmptyRunner {
        private final java.util.concurrent.atomic.AtomicInteger closes = new java.util.concurrent.atomic.AtomicInteger();

        @Override
        public void close() {
            closes.incrementAndGet();
        }
    }

    private static final class CloseableSessionService
            implements com.google.adk.sessions.BaseSessionService, AutoCloseable {
        private final com.google.adk.sessions.InMemorySessionService delegate =
                new com.google.adk.sessions.InMemorySessionService();
        private final java.util.concurrent.atomic.AtomicInteger closes = new java.util.concurrent.atomic.AtomicInteger();

        @Override
        public io.reactivex.rxjava3.core.Single<com.google.adk.sessions.Session> createSession(
                String appName, String userId, java.util.concurrent.ConcurrentMap<String, Object> state,
                String sessionId) {
            return delegate.createSession(appName, userId, state, sessionId);
        }

        @Override
        public io.reactivex.rxjava3.core.Maybe<com.google.adk.sessions.Session> getSession(
                String appName, String userId, String sessionId,
                java.util.Optional<com.google.adk.sessions.GetSessionConfig> config) {
            return delegate.getSession(appName, userId, sessionId, config);
        }

        @Override
        public io.reactivex.rxjava3.core.Single<com.google.adk.sessions.ListSessionsResponse> listSessions(
                String appName, String userId) {
            return delegate.listSessions(appName, userId);
        }

        @Override
        public io.reactivex.rxjava3.core.Completable deleteSession(
                String appName, String userId, String sessionId) {
            return delegate.deleteSession(appName, userId, sessionId);
        }

        @Override
        public io.reactivex.rxjava3.core.Single<com.google.adk.sessions.ListEventsResponse> listEvents(
                String appName, String userId, String sessionId) {
            return delegate.listEvents(appName, userId, sessionId);
        }

        @Override
        public io.reactivex.rxjava3.core.Single<com.google.adk.events.Event> appendEvent(
                com.google.adk.sessions.Session session, com.google.adk.events.Event event) {
            return delegate.appendEvent(session, event);
        }

        @Override
        public void close() {
            closes.incrementAndGet();
        }
    }

    private static final class CloseableMemoryService
            implements com.google.adk.memory.BaseMemoryService, AutoCloseable {
        private final java.util.concurrent.atomic.AtomicInteger closes = new java.util.concurrent.atomic.AtomicInteger();

        @Override
        public io.reactivex.rxjava3.core.Completable addSessionToMemory(com.google.adk.sessions.Session session) {
            return io.reactivex.rxjava3.core.Completable.complete();
        }

        @Override
        public io.reactivex.rxjava3.core.Single<com.google.adk.memory.SearchMemoryResponse> searchMemory(
                String appName, String userId, String query) {
            return io.reactivex.rxjava3.core.Single.error(new UnsupportedOperationException());
        }

        @Override
        public void close() {
            closes.incrementAndGet();
        }
    }

    private static class EmptyRunner implements AdkRunnerClient {
        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId,
                String sessionId,
                Content content,
                RunConfig runConfig,
                Map<String, Object> stateDelta) {
            return Flowable.empty();
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private final AtomicReference<Throwable> error = new AtomicReference<>();
        private volatile Flow.Subscription subscription;

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event item) {
            events.add(item);
        }

        @Override
        public void onError(Throwable throwable) {
            error.set(throwable);
            terminal.countDown();
        }

        @Override
        public void onComplete() {
            terminal.countDown();
        }

        boolean await() throws InterruptedException {
            return terminal.await(5, TimeUnit.SECONDS);
        }

        Throwable error() {
            return error.get();
        }

        void cancel() {
            Flow.Subscription current = subscription;
            if (current != null) {
                current.cancel();
            }
        }
    }
}
