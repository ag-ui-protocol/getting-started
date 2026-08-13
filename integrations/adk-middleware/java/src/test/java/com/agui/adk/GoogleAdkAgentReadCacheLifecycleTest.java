package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;

/**
 * Audit finding M-12: the session read cache must be activated and closed by the agent lifecycle
 * on the public run path (Python creates one cache per execution and stops it in a finally).
 *
 * <p>These tests prove that {@link GoogleAdkAgent} starts a read cache around each chunk
 * execution, that repeated session reads inside the execution reuse the cached session instead of
 * hitting the service again, and that the cache is stopped when the execution settles.
 */
@ExtendWith(MockitoExtension.class)
class GoogleAdkAgentReadCacheLifecycleTest {

    @Test
    void runPathStartsAndStopsOneReadCachePerExecution() throws InterruptedException {
        CountingSessionService sessions = new CountingSessionService();
        SessionManager manager = spy(new SessionManager(
                sessions, mock(com.google.adk.memory.BaseMemoryService.class),
                new com.agui.adk.session.InMemoryThreadSessionMappingStore(),
                new AdkAgUiOptions(true)));
        EmptyRunner runner = new EmptyRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        // The cache is closed by the lifecycle right after the terminal event, so wait briefly
        // for that closure to become observable before verifying the lifecycle calls.
        waitUntilCacheClosed(sessions, manager);
        verify(manager).startSessionReadCache();
        verify(manager).stopSessionReadCache(any(SessionManager.ReadCacheToken.class));
    }

    @Test
    void repeatedSessionReadsInsideExecutionHitTheCacheInsteadOfTheService() throws InterruptedException {
        CountingSessionService sessions = new CountingSessionService();
        SessionManager manager = new SessionManager(
                sessions, mock(com.google.adk.memory.BaseMemoryService.class),
                new com.agui.adk.session.InMemoryThreadSessionMappingStore(),
                new AdkAgUiOptions(true));
        ReadingRunner runner = new ReadingRunner(manager, sessions);
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        // In addition to the three execution reads, normal completion performs one direct
        // authoritative state fetch. History is refreshed only when messages snapshots are enabled.
        assertThat(sessions.getSessionReads.get()).isEqualTo(4);
        assertThat(runner.runAsyncCalls.get()).isEqualTo(1);
        assertThat(runner.midRunSessionIds).containsExactly("thread-1", "thread-1");
        assertThat(runner.serviceReadsObservedAtMidRunReads).containsExactly(3, 3);
    }

    @Test
    void cacheIsClosedAfterTheExecutionSoLaterReadsHitTheServiceAgain() throws InterruptedException {
        CountingSessionService sessions = new CountingSessionService();
        SessionManager manager = new SessionManager(
                sessions, mock(com.google.adk.memory.BaseMemoryService.class),
                new com.agui.adk.session.InMemoryThreadSessionMappingStore(),
                new AdkAgUiOptions(true));
        ReadingRunner runner = new ReadingRunner(manager, sessions);
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(input()));
        assertThat(subscriber.await()).isTrue();
        // Three execution reads plus the authoritative state fetch.
        assertThat(sessions.getSessionReads.get()).isEqualTo(4);

        // After the run the cache is closed on the opening thread even though the execution
        // settles on a scheduler thread: a direct read now reaches the service again.
        waitUntilCacheClosed(sessions, manager);
        assertThat(sessions.getSessionReads.get()).isEqualTo(5);
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

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    /** Polls until a direct session read reaches the service again (i.e. the cache is closed). */
    private static void waitUntilCacheClosed(CountingSessionService sessions, SessionManager manager)
            throws InterruptedException {
        // The run itself performs four service reads including the authoritative final-state
        // fetch, so the fifth proves the execution cache is closed.
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (sessions.getSessionReads.get() < 5 && System.nanoTime() < deadline) {
            manager.getSession("test-app", "user", "thread-1").blockingGet();
            Thread.sleep(10);
        }
    }

    /** Session service counting direct reads; sessions are served from an in-memory map. */
    private static final class CountingSessionService implements com.google.adk.sessions.BaseSessionService {
        private final AtomicInteger getSessionReads = new AtomicInteger();
        private final Map<String, Session> sessions = new ConcurrentHashMap<>();

        @Override
        public Single<Session> createSession(
                String appName, String userId,
                java.util.concurrent.ConcurrentMap<String, Object> state, String sessionId) {
            Session session = Session.builder(sessionId).appName(appName).userId(userId).state(state).build();
            sessions.put(sessionId, session);
            return Single.just(session);
        }

        @Override
        public io.reactivex.rxjava3.core.Maybe<Session> getSession(
                String appName, String userId, String sessionId,
                java.util.Optional<com.google.adk.sessions.GetSessionConfig> config) {
            getSessionReads.incrementAndGet();
            Session session = sessions.get(sessionId);
            if (session == null) {
                Session created = Session.builder(sessionId).appName(appName).userId(userId)
                        .state(new ConcurrentHashMap<>()).build();
                sessions.put(sessionId, created);
                return io.reactivex.rxjava3.core.Maybe.just(created);
            }
            return io.reactivex.rxjava3.core.Maybe.just(session);
        }

        @Override
        public Single<com.google.adk.sessions.ListSessionsResponse> listSessions(
                String appName, String userId) {
            return Single.just(com.google.adk.sessions.ListSessionsResponse.builder()
                    .sessions(new ArrayList<>(sessions.values())).build());
        }

        @Override
        public Completable deleteSession(String appName, String userId, String sessionId) {
            sessions.remove(sessionId);
            return Completable.complete();
        }

        @Override
        public Single<com.google.adk.sessions.ListEventsResponse> listEvents(
                String appName, String userId, String sessionId) {
            return Single.just(com.google.adk.sessions.ListEventsResponse.builder().build());
        }
    }

    private static final class EmptyRunner implements AdkRunnerClient {
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

    /** Runner that reads the session twice through the manager while the execution is in flight. */
    private static final class ReadingRunner implements AdkRunnerClient {
        private final SessionManager manager;
        private final CountingSessionService service;
        private final AtomicInteger runAsyncCalls = new AtomicInteger();
        private final List<String> midRunSessionIds = new ArrayList<>();
        private final List<Integer> serviceReadsObservedAtMidRunReads = new ArrayList<>();

        private ReadingRunner(SessionManager manager, CountingSessionService service) {
            this.manager = manager;
            this.service = service;
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
            runAsyncCalls.incrementAndGet();
            midRunSessionIds.add(manager.getSession("test-app", "user", sessionId)
                    .blockingGet().id());
            serviceReadsObservedAtMidRunReads.add(service.getSessionReads.get());
            midRunSessionIds.add(manager.getSession("test-app", "user", sessionId)
                    .blockingGet().id());
            serviceReadsObservedAtMidRunReads.add(service.getSessionReads.get());
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
        public void onNext(Event item) {
            events.add(item);
        }

        @Override
        public void onError(Throwable throwable) {
            error = throwable;
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
            return error;
        }
    }
}
