package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.events.Event;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import com.agui.adk.history.MessageHistoryProvider;
import com.agui.adk.session.InMemoryThreadSessionMappingStore;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.MessagesSnapshotEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.StateSnapshotEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Audit finding M-04 (dedicated): the {@code MESSAGES_SNAPSHOT} event is emitted at the END of the
 * run — after the current turn's translated events and before {@code RUN_FINISHED} — and its
 * content is built from the session refreshed after the run, matching the Python
 * {@code emit_messages_snapshot} contract.
 */
class GoogleAdkAgentMessagesSnapshotTest {

    @Test
    void snapshotIsAppendedAfterCurrentTurnEventsAndBeforeRunFinished() throws Exception {
        List<Event> refreshedEvents = List.of(
                adkEvent("user", "Earlier question"),
                adkEvent("model", "Earlier answer"),
                adkEvent("model", "Current answer"));
        RefreshingSessionService sessions = new RefreshingSessionService(refreshedEvents);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        SessionManager manager = new SessionManager(
                sessions, memory, new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
        EmittingRunner runner = new EmittingRunner(adkEvent("model", "Current answer"));
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(List.of())
                .userIdExtractor(ignored -> "user")
                .options(new AdkAgUiOptions(true, java.time.Duration.ofMinutes(5), 100, null, true))
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.terminalError.get()).isNull();
        List<com.agui.community.core.event.Event> events = subscriber.events;
        // The current turn's text arrives first, then the snapshot, then the terminal.
        assertThat(events).first().isInstanceOf(RunStartedEvent.class);
        assertThat(events).last().isInstanceOf(RunFinishedEvent.class);
        int textIndex = indexOf(events, TextMessageContentEvent.class);
        int stateIndex = indexOf(events, StateSnapshotEvent.class);
        int snapshotIndex = indexOf(events, MessagesSnapshotEvent.class);
        assertThat(stateIndex).isGreaterThan(textIndex);
        assertThat(snapshotIndex).isGreaterThan(stateIndex);
        assertThat(snapshotIndex).isLessThan(events.size() - 1);
        // The snapshot content reflects the refreshed session including the current turn.
        MessagesSnapshotEvent snapshot = (MessagesSnapshotEvent) events.get(snapshotIndex);
        assertThat(snapshot.messages()).extracting(com.agui.community.core.message.Message::content)
                .containsExactly("Earlier question", "Earlier answer", "Current answer");
    }

    @Test
    void snapshotBypassesExecutionCacheWhenCompletedSessionIsANewObject() throws Exception {
        ReplacingSessionService sessions = new ReplacingSessionService();
        BaseMemoryService memory = mock(BaseMemoryService.class);
        SessionManager manager = new SessionManager(
                sessions, memory, new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(new CachePrimingCompletingRunner(manager, sessions))
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(List.of())
                .userIdExtractor(ignored -> "user")
                .options(new AdkAgUiOptions(true, java.time.Duration.ofMinutes(5), 100, null, true))
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.terminalError.get()).isNull();
        MessagesSnapshotEvent snapshot = subscriber.events.stream()
                .filter(MessagesSnapshotEvent.class::isInstance)
                .map(MessagesSnapshotEvent.class::cast)
                .findFirst()
                .orElseThrow();
        assertThat(snapshot.messages()).extracting(com.agui.community.core.message.Message::content)
                .containsExactly("Current question", "Just-finished answer");
        assertThat(sessions.reads).hasValue(5);
    }

    @Test
    void snapshotReadsTheSessionFromTheServiceAfterTheRun() throws Exception {
        List<Event> refreshedEvents = List.of(adkEvent("model", "Only answer"));
        RefreshingSessionService sessions = new RefreshingSessionService(refreshedEvents);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        SessionManager manager = new SessionManager(
                sessions, memory, new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
        RecordingHistoryProvider provider = new RecordingHistoryProvider();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(new EmittingRunner())
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(List.of())
                .userIdExtractor(ignored -> "user")
                .messageHistoryProvider(provider)
                .options(new AdkAgUiOptions(true, java.time.Duration.ofMinutes(5), 100, null, true))
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        // The history provider was fed the session returned by the end-of-run refresh.
        assertThat(provider.seenSession.get()).isNotNull();
        assertThat(provider.seenSession.get().id()).isEqualTo("thread");
        assertThat(provider.seenSession.get().events()).hasSize(1);
        assertThat(subscriber.events).filteredOn(MessagesSnapshotEvent.class::isInstance).hasSize(1);
    }

    private static com.google.adk.events.Event adkEvent(String author, String text) {
        return Event.builder()
                .author(author)
                .content(Content.builder().role("model")
                        .parts(List.of(Part.builder().text(text).build()))
                        .build())
                .build();
    }

    private static RunAgentInput input() {
        return new RunAgentInput(
                "thread",
                "run",
                Map.of(),
                List.of(new UserMessage("current-user", "Current question")),
                List.of(),
                List.of(new Context("appName", "app")),
                Map.of());
    }

    private static int indexOf(List<com.agui.community.core.event.Event> events, Class<?> type) {
        for (int i = 0; i < events.size(); i++) {
            if (type.isInstance(events.get(i))) {
                return i;
            }
        }
        return -1;
    }

    private static RecordingSubscriber subscribe(
            Flow.Publisher<com.agui.community.core.event.Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    /**
     * Returns an unchanged pre-run object until the runner completes, then replaces it with a new
     * object containing the just-finished turn.
     */
    private static final class ReplacingSessionService implements BaseSessionService {
        private final AtomicInteger reads = new AtomicInteger();
        private final java.util.concurrent.atomic.AtomicBoolean completed =
                new java.util.concurrent.atomic.AtomicBoolean();
        private final Session preRun = session(List.of());
        private final Session completedRun = session(List.of(
                adkEvent("user", "Current question"),
                adkEvent("model", "Just-finished answer")));

        @Override
        public Single<Session> createSession(
                String appName, String userId,
                java.util.concurrent.ConcurrentMap<String, Object> state, String sessionId) {
            return Single.just(preRun);
        }

        @Override
        public io.reactivex.rxjava3.core.Maybe<Session> getSession(
                String appName, String userId, String sessionId,
                java.util.Optional<com.google.adk.sessions.GetSessionConfig> config) {
            reads.incrementAndGet();
            return io.reactivex.rxjava3.core.Maybe.just(completed.get() ? completedRun : preRun);
        }

        @Override
        public Single<com.google.adk.sessions.ListSessionsResponse> listSessions(String appName, String userId) {
            return Single.just(com.google.adk.sessions.ListSessionsResponse.builder().build());
        }

        @Override
        public io.reactivex.rxjava3.core.Completable deleteSession(
                String appName, String userId, String sessionId) {
            return io.reactivex.rxjava3.core.Completable.complete();
        }

        @Override
        public Single<com.google.adk.sessions.ListEventsResponse> listEvents(
                String appName, String userId, String sessionId) {
            return Single.just(com.google.adk.sessions.ListEventsResponse.builder().build());
        }

        private static Session session(List<Event> events) {
            return Session.builder("thread")
                    .appName("app").userId("user")
                    .state(new ConcurrentHashMap<>())
                    .events(events)
                    .build();
        }
    }

    /** Primes the active read cache with the pre-run object before replacing the backend object. */
    private static final class CachePrimingCompletingRunner implements AdkRunnerClient {
        private final SessionManager manager;
        private final ReplacingSessionService sessions;

        private CachePrimingCompletingRunner(SessionManager manager, ReplacingSessionService sessions) {
            this.manager = manager;
            this.sessions = sessions;
        }

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig,
                Map<String, Object> stateDelta) {
            manager.getSession("app", userId, sessionId).blockingGet();
            sessions.completed.set(true);
            return Flowable.empty();
        }
    }

    /** Session service returning a session whose events include the current turn (post-run state). */
    private static final class RefreshingSessionService implements BaseSessionService {
        private final List<Event> events;

        private RefreshingSessionService(List<Event> events) {
            this.events = events;
        }

        @Override
        public io.reactivex.rxjava3.core.Single<Session> createSession(
                String appName, String userId,
                java.util.concurrent.ConcurrentMap<String, Object> state, String sessionId) {
            return io.reactivex.rxjava3.core.Single.just(Session.builder(sessionId)
                    .appName(appName).userId(userId).state(state).build());
        }

        @Override
        public io.reactivex.rxjava3.core.Maybe<Session> getSession(
                String appName, String userId, String sessionId,
                java.util.Optional<com.google.adk.sessions.GetSessionConfig> config) {
            return io.reactivex.rxjava3.core.Maybe.just(Session.builder(sessionId)
                    .appName(appName).userId(userId)
                    .state(new ConcurrentHashMap<>(Map.of("status", "done")))
                    .events(this.events)
                    .build());
        }

        @Override
        public io.reactivex.rxjava3.core.Single<com.google.adk.sessions.ListSessionsResponse> listSessions(
                String appName, String userId) {
            return io.reactivex.rxjava3.core.Single.just(
                    com.google.adk.sessions.ListSessionsResponse.builder().build());
        }

        @Override
        public io.reactivex.rxjava3.core.Completable deleteSession(String appName, String userId, String sessionId) {
            return io.reactivex.rxjava3.core.Completable.complete();
        }

        @Override
        public io.reactivex.rxjava3.core.Single<com.google.adk.sessions.ListEventsResponse> listEvents(
                String appName, String userId, String sessionId) {
            return io.reactivex.rxjava3.core.Single.just(
                    com.google.adk.sessions.ListEventsResponse.builder().build());
        }
    }

    private static final class RecordingHistoryProvider implements MessageHistoryProvider {
        private final AtomicReference<Session> seenSession = new AtomicReference<>();

        @Override
        public Single<Result> history(Session session) {
            seenSession.set(session);
            return Single.just(Result.complete(
                    com.agui.adk.history.AdkEventsToMessages.convert(
                            session.events() == null ? List.of() : session.events())));
        }
    }

    /** Runner emitting a translated assistant text event for the current turn. */
    private static final class EmittingRunner implements AdkRunnerClient {
        private final com.google.adk.events.Event event;

        private EmittingRunner() {
            this(null);
        }

        private EmittingRunner(com.google.adk.events.Event event) {
            this.event = event;
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
            return event == null ? Flowable.empty() : Flowable.just(event);
        }
    }

    private static final class RecordingSubscriber
            implements Flow.Subscriber<com.agui.community.core.event.Event> {
        private final List<com.agui.community.core.event.Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private final AtomicReference<Throwable> terminalError = new AtomicReference<>();

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(com.agui.community.core.event.Event event) {
            events.add(event);
        }

        @Override
        public void onError(Throwable error) {
            terminalError.set(error);
            terminal.countDown();
        }

        @Override
        public void onComplete() {
            terminal.countDown();
        }

        private boolean await() throws InterruptedException {
            return terminal.await(5, TimeUnit.SECONDS);
        }
    }
}
