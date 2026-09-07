package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.events.Event;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.session.InMemoryThreadSessionMappingStore;
import com.agui.adk.session.SessionCleanupPolicy;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Audit finding M-10 — the background cleanup loop starts lazily on every session get/create,
 * including for a manager injected into an agent (Python {@code SessionManager.get_or_create_session}
 * starts the scheduler unconditionally; previously only the process-wide default singleton started
 * it automatically).
 */
@ExtendWith(MockitoExtension.class)
class SessionManagerAutoCleanupStartTest {

    @Mock
    private BaseSessionService sessionService;
    @Mock
    private BaseMemoryService memoryService;

    private SessionManager manager(AdkAgUiOptions options) {
        return new SessionManager(sessionService, memoryService,
                new InMemoryThreadSessionMappingStore(), options);
    }

    @Test
    void injectedManagerAutoStartsCleanupOnFirstPublicGetOrCreate() {
        SessionManager manager = manager(new AdkAgUiOptions(true));
        assertThat(manager.cleanupTaskRunning()).isFalse();
        Session created = Session.builder("thread-1").appName("app").userId("user")
                .state(new ConcurrentHashMap<>()).build();
        when(sessionService.getSession(eq("app"), eq("user"), eq("thread-1"), any()))
                .thenReturn(Maybe.empty());
        when(sessionService.createSession(any(), any(), any(), eq("thread-1")))
                .thenReturn(Single.just(created));
        try {
            manager.getOrCreateSession("app", "user", "thread-1", null, false).blockingGet();
            assertThat(manager.cleanupTaskRunning()).isTrue();
        } finally {
            manager.dispose();
        }
    }

    @Test
    void injectedManagerAutoStartsCleanupOnPublicAgentRun() {
        SessionManager manager = manager(new AdkAgUiOptions(true));
        assertThat(manager.cleanupTaskRunning()).isFalse();
        Session existing = Session.builder("thread-1").appName("app").userId("user")
                .state(new ConcurrentHashMap<>()).build();
        when(sessionService.getSession(eq("app"), eq("user"), eq("thread-1"), any()))
                .thenReturn(Maybe.just(existing));
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        CountingRunner runner = new CountingRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();
        RunAgentInput input = new RunAgentInput(
                "thread-1", "run-1", Map.of(), List.of(new UserMessage("message-1", "hello")), List.of(),
                List.of(new Context("appName", "app")), Map.of());
        try {
            RecordingSubscriber subscriber = subscribe(agent.run(input));
            assertThat(subscriber.await()).isTrue();
            assertThat(manager.cleanupTaskRunning()).isTrue();
        } finally {
            agent.close();
        }
    }

    @Test
    void autoStartedLoopCleansExpiredSessionsOfInjectedManager() throws InterruptedException {
        Session expired = Session.builder("sess-expired").appName("app").userId("user")
                .state(new ConcurrentHashMap<>())
                .lastUpdateTime(Instant.now().minus(Duration.ofSeconds(60)))
                .build();
        when(sessionService.getSession(eq("app"), eq("user"), eq("thread-1"), any()))
                .thenReturn(Maybe.empty());
        when(sessionService.getSession(eq("app"), eq("user"), eq("sess-expired"), any()))
                .thenReturn(Maybe.just(expired));
        when(sessionService.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(expired)).build()));
        when(memoryService.addSessionToMemory(any())).thenReturn(Completable.complete());
        CountDownLatch deleted = new CountDownLatch(1);
        when(sessionService.deleteSession("app", "user", "sess-expired"))
                .thenReturn(Completable.fromAction(deleted::countDown));
        SessionManager manager = manager(new AdkAgUiOptions(true));
        // Configure the loop before it auto-starts: 50 ms expiry / 50 ms interval.
        manager.configureCleanupPolicy(new SessionCleanupPolicy(
                Duration.ofMillis(50), Duration.ofMillis(50), null));
        Session created = Session.builder("thread-1").appName("app").userId("user")
                .state(new ConcurrentHashMap<>()).build();
        when(sessionService.createSession(any(), any(), any(), eq("thread-1")))
                .thenReturn(Single.just(created));
        try {
            manager.getOrCreateSession("app", "user", "thread-1", null, false).blockingGet();
            assertThat(deleted.await(3, TimeUnit.SECONDS)).isTrue();
            verify(memoryService).addSessionToMemory(expired);
        } finally {
            manager.dispose();
        }
    }

    @Test
    void cleanupPolicyIsPermanentlyImmutableAfterCleanupStarts() {
        SessionManager manager = manager(new AdkAgUiOptions(true));
        SessionCleanupPolicy original = new SessionCleanupPolicy(
                Duration.ofMinutes(1), Duration.ofHours(1), null);
        SessionCleanupPolicy replacement = new SessionCleanupPolicy(
                Duration.ofHours(1), Duration.ofHours(1), null);
        try {
            manager.configureCleanupPolicy(original);
            manager.startCleanupTask();
            manager.configureCleanupPolicy(original);
            assertThat(org.assertj.core.api.Assertions.catchThrowable(
                    () -> manager.configureCleanupPolicy(replacement)))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("immutable after cleanup starts");
            manager.stopCleanupTask();
            assertThat(org.assertj.core.api.Assertions.catchThrowable(
                    () -> manager.configureCleanupPolicy(replacement)))
                    .isInstanceOf(IllegalStateException.class);
        } finally {
            manager.dispose();
        }
    }

    @Test
    void pausedOldPolicyCycleCannotBecomeObsoleteThroughReconfiguration() throws InterruptedException {
        Session expired = Session.builder("expired").appName("app").userId("user")
                .state(new ConcurrentHashMap<>())
                .lastUpdateTime(Instant.now().minus(Duration.ofHours(2))).build();
        CountDownLatch listed = new CountDownLatch(1);
        CountDownLatch releaseListing = new CountDownLatch(1);
        CountDownLatch deleted = new CountDownLatch(1);
        when(sessionService.getSession(eq("app"), eq("user"), eq("thread-1"), any()))
                .thenReturn(Maybe.empty());
        when(sessionService.createSession(any(), any(), any(), eq("thread-1")))
                .thenReturn(Single.just(Session.builder("thread-1").appName("app").userId("user")
                        .state(new ConcurrentHashMap<>()).build()));
        when(sessionService.listSessions("app", "user")).thenReturn(Single.fromCallable(() -> {
            listed.countDown();
            if (!releaseListing.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("listing was not released");
            }
            return ListSessionsResponse.builder().sessions(List.of(expired)).build();
        }));
        when(sessionService.getSession(eq("app"), eq("user"), eq("expired"), any()))
                .thenReturn(Maybe.just(expired));
        when(memoryService.addSessionToMemory(any())).thenReturn(Completable.complete());
        when(sessionService.deleteSession("app", "user", "expired"))
                .thenReturn(Completable.fromAction(deleted::countDown));
        SessionCleanupPolicy oldPolicy = new SessionCleanupPolicy(
                Duration.ofMinutes(1), Duration.ofMillis(20), null);
        SessionCleanupPolicy replacement = new SessionCleanupPolicy(
                Duration.ofHours(4), Duration.ofMillis(20), null);
        SessionManager manager = manager(new AdkAgUiOptions(true));
        manager.configureCleanupPolicy(oldPolicy);
        try {
            manager.getOrCreateSession("app", "user", "thread-1", null, false).blockingGet();
            assertThat(listed.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(org.assertj.core.api.Assertions.catchThrowable(
                    () -> manager.configureCleanupPolicy(replacement)))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(deleted.getCount()).isEqualTo(1);
            releaseListing.countDown();
            assertThat(deleted.await(3, TimeUnit.SECONDS)).isTrue();
        } finally {
            releaseListing.countDown();
            manager.dispose();
        }
    }

    @Test
    void sharedAgentCannotReconfigureManagerAfterPublicRunStartedCleanup() {
        SessionManager manager = manager(new AdkAgUiOptions(true));
        SessionCleanupPolicy original = new SessionCleanupPolicy(
                Duration.ofMinutes(1), Duration.ofHours(1), null);
        SessionCleanupPolicy replacement = new SessionCleanupPolicy(
                Duration.ofHours(1), Duration.ofHours(1), null);
        Session existing = Session.builder("thread-1").appName("app").userId("user")
                .state(new ConcurrentHashMap<>()).build();
        when(sessionService.getSession(eq("app"), eq("user"), eq("thread-1"), any()))
                .thenReturn(Maybe.just(existing));
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        GoogleAdkAgent first = GoogleAdkAgent.builder()
                .runner(new CountingRunner()).sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build()).configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user").sessionCleanupPolicy(original).build();
        RunAgentInput input = new RunAgentInput(
                "thread-1", "run-1", Map.of(), List.of(new UserMessage("message-1", "hello")), List.of(),
                List.of(new Context("appName", "app")), Map.of());
        try {
            assertThat(subscribe(first.run(input)).await()).isTrue();
            assertThat(org.assertj.core.api.Assertions.catchThrowable(() -> GoogleAdkAgent.builder()
                    .runner(new CountingRunner()).sessionManager(manager)
                    .baseRunConfig(RunConfig.builder().build()).configuredBackendToolNames(Set.of())
                    .userIdExtractor(ignored -> "user").sessionCleanupPolicy(replacement).build()))
                    .isInstanceOf(IllegalStateException.class);
        } finally {
            first.close();
        }
    }

    /** Minimal runner fake used by the agent-level wiring test. */
    private static final class CountingRunner implements AdkRunnerClient {
        private int runs;

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<Event> runAsync(
                String userId, String sessionId, Content content, RunConfig config, Map<String, Object> stateDelta) {
            runs++;
            return Flowable.empty();
        }
    }

    /** Collects public events until the stream terminates. */
    private static final class RecordingSubscriber
            implements java.util.concurrent.Flow.Subscriber<com.agui.community.core.event.Event> {
        private final CountDownLatch terminal = new CountDownLatch(1);

        @Override
        public void onSubscribe(java.util.concurrent.Flow.Subscription subscription) {
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(com.agui.community.core.event.Event event) {
            // ignored: terminal state is what the wiring test observes
        }

        @Override
        public void onError(Throwable throwable) {
            terminal.countDown();
        }

        @Override
        public void onComplete() {
            terminal.countDown();
        }

        private boolean await() {
            try {
                return terminal.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new AssertionError(error);
            }
        }
    }

    private static RecordingSubscriber subscribe(
            java.util.concurrent.Flow.Publisher<com.agui.community.core.event.Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }
}
