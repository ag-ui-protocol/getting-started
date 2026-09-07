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
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
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
 * Audit finding M-04: {@code MESSAGES_SNAPSHOT} emission must be an opt-in option emitted at the
 * end of the run (not an unconditional prefix) and built from the refreshed session.
 *
 * <p>These tests verify the option gate, the end-of-run timing, the refreshed-session content
 * source, and that the {@code completeMessageHistory} capability remains driven by the provider.
 */
class GoogleAdkAgentHistorySnapshotTest {

    @Test
    void snapshotIsOmittedByDefaultEvenForCompleteHistoryProviders() throws Exception {
        List<Message> historyMessages = List.of(
                new UserMessage("history-user", "Earlier question"),
                new AssistantMessage("history-assistant", "Earlier answer"));
        Fixture fixture = fixture(historyMessages, true, true,
                new AdkAgUiOptions(true, java.time.Duration.ofMinutes(5), 100, null, false));

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.terminalError.get()).isNull();
        assertThat(subscriber.events).containsExactly(
                new RunStartedEvent("thread", "run"),
                new RunFinishedEvent("thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(subscriber.events).noneMatch(MessagesSnapshotEvent.class::isInstance);
        // The capability advertisement is a hosting-side declaration (M-06) and no longer
        // synthesizes bridge diagnostics; the snapshot behavior itself is what this test proves.
        assertThat(fixture.provider.calls).hasValue(0);
        assertThat(fixture.runner.calls).hasValue(1);
    }

    @Test
    void completeHistoryProviderEmitsOneOfficialSnapshotAtTheEndWhenOptionEnabled() throws Exception {
        List<Message> historyMessages = List.of(
                new UserMessage("history-user", "Earlier question"),
                new AssistantMessage("history-assistant", "Earlier answer"));
        Fixture fixture = fixture(historyMessages, true, true, snapshotEnabled());

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.terminalError.get()).isNull();
        // Python order: STATE_SNAPSHOT, then MESSAGES_SNAPSHOT, then RUN_FINISHED.
        assertThat(subscriber.events).containsExactly(
                new RunStartedEvent("thread", "run"),
                new MessagesSnapshotEvent(historyMessages),
                new RunFinishedEvent("thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(subscriber.events).filteredOn(MessagesSnapshotEvent.class::isInstance).hasSize(1);
        // The provider is consulted exactly once, at the end-of-run refresh.
        assertThat(fixture.provider.calls).hasValue(1);
        assertThat(fixture.runner.calls).hasValue(1);
    }


    @Test
    void completeEmptyHistoryEmitsNoSnapshot() throws Exception {
        Fixture fixture = fixture(List.of(), true, true, snapshotEnabled());

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.terminalError.get()).isNull();
        assertThat(subscriber.events).containsExactly(
                new RunStartedEvent("thread", "run"),
                new RunFinishedEvent("thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(subscriber.events).noneMatch(MessagesSnapshotEvent.class::isInstance);
    }

    @Test
    void historyProviderFailureDoesNotAbortRunFinished() throws Exception {
        Fixture fixture = fixture(List.of(), true, true, snapshotEnabled());
        fixture.provider.failure = new IllegalStateException("history refresh failed");

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.terminalError.get()).isNull();
        assertThat(subscriber.events).containsExactly(
                new RunStartedEvent("thread", "run"),
                new RunFinishedEvent("thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(subscriber.events).noneMatch(MessagesSnapshotEvent.class::isInstance);
    }

    @Test
    void incompleteNonEmptyHistoryProviderEmitsNoSnapshot() throws Exception {
        List<Message> partialMessages = List.of(new UserMessage("partial-user", "Partial history"));
        Fixture fixture = fixture(partialMessages, false, false, snapshotEnabled());

        RecordingSubscriber subscriber = subscribe(fixture.agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.terminalError.get()).isNull();
        assertThat(subscriber.events).containsExactly(
                new RunStartedEvent("thread", "run"),
                new RunFinishedEvent("thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(subscriber.events).noneMatch(MessagesSnapshotEvent.class::isInstance);
        assertThat(fixture.provider.calls).hasValue(1);
        assertThat(fixture.runner.calls).hasValue(1);
    }

    /**
     * Row 1.3 — the default {@link AdkSessionMessageHistoryProvider} replays the full history
     * from the session's own event memory (like Python), so with the option enabled the end-of-run
     * snapshot is built from the refreshed session's events.
     */
    @Test
    void defaultProviderReplaysRefreshedSessionEventsAndEmitsOfficialSnapshot() throws Exception {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        when(sessions.getSession(any(), any(), any(), any())).thenAnswer(invocation -> {
            String sessionId = invocation.getArgument(2, String.class);
            List<Event> events = List.of(
                    Event.builder().author("user")
                            .content(Content.builder().role("user")
                                    .parts(List.of(Part.builder().text("Earlier question").build())).build())
                            .build(),
                    Event.builder().author("model")
                            .content(Content.builder().role("model")
                                    .parts(List.of(Part.builder().text("Earlier answer").build())).build())
                            .build());
            Session session = Session.builder(sessionId)
                    .appName("app").userId("user")
                    .state(new ConcurrentHashMap<>())
                    .events(events)
                    .build();
            return Single.just(session).toMaybe();
        });
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        SessionManager manager = new SessionManager(
                sessions, memory, new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
        CountingRunner runner = new CountingRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(List.of())
                .userIdExtractor(ignored -> "user")
                // No caller-supplied messageHistoryProvider -> the default replay provider.
                .options(snapshotEnabled())
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(input()));
        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.terminalError.get()).isNull();
        List<Message> snapshotMessages = subscriber.events.stream()
                .filter(MessagesSnapshotEvent.class::isInstance)
                .map(MessagesSnapshotEvent.class::cast)
                .flatMap(snapshot -> snapshot.messages().stream())
                .toList();
        assertThat(snapshotMessages).hasSize(2);
        assertThat(snapshotMessages.get(0).content()).isEqualTo("Earlier question");
        assertThat(snapshotMessages.get(1).content()).isEqualTo("Earlier answer");
    }

    private static AdkAgUiOptions snapshotEnabled() {
        return new AdkAgUiOptions(true, java.time.Duration.ofMinutes(5), 100, null, true);
    }

    private static Fixture fixture(
            List<Message> historyMessages,
            boolean resultComplete,
            boolean guaranteesCompleteHistory,
            AdkAgUiOptions options) {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        when(sessions.getSession(any(), any(), any(), any())).thenAnswer(invocation -> {
            String appName = invocation.getArgument(0, String.class);
            String userId = invocation.getArgument(1, String.class);
            String sessionId = invocation.getArgument(2, String.class);
            Session session = Session.builder(sessionId)
                    .appName(appName)
                    .userId(userId)
                    .state(new ConcurrentHashMap<>())
                    .build();
            return Single.just(session).toMaybe();
        });
        when(sessions.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));

        SessionManager manager = new SessionManager(
                sessions, memory, new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
        RecordingHistoryProvider provider = new RecordingHistoryProvider(
                new MessageHistoryProvider.Result(historyMessages, resultComplete), guaranteesCompleteHistory);
        CountingRunner runner = new CountingRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(List.of())
                .userIdExtractor(ignored -> "user")
                .messageHistoryProvider(provider)
                .options(options)
                .build();
        return new Fixture(agent, provider, runner);
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

    private static RecordingSubscriber subscribe(
            Flow.Publisher<com.agui.community.core.event.Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private record Fixture(
            GoogleAdkAgent agent, RecordingHistoryProvider provider, CountingRunner runner) {
    }

    private static final class RecordingHistoryProvider implements MessageHistoryProvider {
        private final Result result;
        private final boolean guaranteesCompleteHistory;
        private final AtomicInteger calls = new AtomicInteger();
        private RuntimeException failure;

        private RecordingHistoryProvider(Result result, boolean guaranteesCompleteHistory) {
            this.result = result;
            this.guaranteesCompleteHistory = guaranteesCompleteHistory;
        }

        @Override
        public Single<Result> history(Session session) {
            calls.incrementAndGet();
            return failure == null ? Single.just(result) : Single.error(failure);
        }

        @Override
        public boolean providesCompleteHistory() {
            return guaranteesCompleteHistory;
        }
    }

    private static final class CountingRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private RuntimeException failure;

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<Event> runAsync(
                String userId,
                String sessionId,
                Content content,
                RunConfig runConfig,
                Map<String, Object> stateDelta) {
            calls.incrementAndGet();
            return Flowable.empty();
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
            return terminal.await(1, TimeUnit.SECONDS);
        }
    }
}
