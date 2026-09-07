package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.events.Event;
import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.sessions.InMemorySessionService;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.session.InMemoryThreadSessionMappingStore;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Flowable;
import org.junit.jupiter.api.Test;

import static org.mockito.ArgumentMatchers.any;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Audit finding M-11 — persisted pending tool-call markers are verified on first local access of a
 * session (Python {@code ADKAgent._verify_pending_tool_calls}): stale markers left by a crashed
 * middleware are cleared when no active execution on this instance can fulfill them, preserved when
 * a local execution is still running, and the verification runs exactly once per (app, user,
 * thread) per instance.
 */
class GoogleAdkAgentPendingCallVerificationTest {

    private static final String APP = "app";
    private static final String USER = "user";
    private static final String THREAD = "thread-1";

    private static SessionManager manager(InMemorySessionService sessions) {
        return new SessionManager(sessions, new InMemoryMemoryService(),
                new InMemoryThreadSessionMappingStore(), new AdkAgUiOptions(true));
    }

    private static Session sessionWithPending(String id, List<String> pending) {
        ConcurrentHashMap<String, Object> state = new ConcurrentHashMap<>();
        state.put("pendingToolCallIds", new java.util.ArrayList<>(pending));
        return Session.builder(id).appName(APP).userId(USER).state(state).build();
    }

    @Test
    void stalePendingToolCallsAreClearedOnFirstAccessThroughPublicRun() {
        InMemorySessionService real = new InMemorySessionService();
        real.createSession(APP, USER, new ConcurrentHashMap<>(Map.of(
                "pendingToolCallIds", new java.util.ArrayList<>(List.of("orphan-1")))), THREAD)
                .blockingGet();
        InMemorySessionService sessions = org.mockito.Mockito.spy(real);
        SessionManager manager = manager(sessions);
        GoogleAdkAgent agent = agent(manager, new CountingRunner());

        RunAgentInput input = new RunAgentInput(
                THREAD, "run-1", Map.of(), List.of(new UserMessage("message-1", "hello")), List.of(),
                List.of(new Context("appName", APP)), Map.of());
        RecordingSubscriber subscriber = subscribe(agent.run(input));
        assertThat(subscriber.await()).isTrue();

        // The run path appended a clearing delta for the stale markers (Python
        // _verify_pending_tool_calls). The stock in-memory service stores whole session objects on
        // appendEvent, so the observable proof of the wired verification is the appended state
        // delta rather than the final store contents.
        org.mockito.ArgumentCaptor<Event> captor = org.mockito.ArgumentCaptor.forClass(Event.class);
        org.mockito.Mockito.verify(sessions, org.mockito.Mockito.atLeastOnce())
                .appendEvent(any(), captor.capture());
        boolean clearingDeltaAppended = captor.getAllValues().stream()
                .filter(event -> event.actions() != null && event.actions().stateDelta() != null)
                .anyMatch(event -> {
                    Object value = event.actions().stateDelta().get("pendingToolCallIds");
                    return value instanceof Collection<?> collection && collection.isEmpty();
                });
        assertThat(clearingDeltaAppended).isTrue();
        agent.close();
    }

    @Test
    void verificationRunsOncePerThreadPerInstance() {
        InMemorySessionService sessions = new InMemorySessionService();
        sessions.createSession(APP, USER, new ConcurrentHashMap<>(Map.of(
                "pendingToolCallIds", new java.util.ArrayList<>(List.of("orphan-1")))), THREAD)
                .blockingGet();
        SessionManager manager = manager(sessions);
        GoogleAdkAgent agent = agent(manager, new CountingRunner());
        RunAgentInput input = new RunAgentInput(
                THREAD, "run-1", Map.of(), List.of(new UserMessage("message-1", "hello")), List.of(),
                List.of(new Context("appName", APP)), Map.of());

        RecordingSubscriber first = subscribe(agent.run(input));
        assertThat(first.await()).isTrue();

        // A new pending marker appears after the first access (e.g. persisted by a later HITL
        // turn). The second access must NOT clear it: verification ran once for this thread.
        Session before = manager.getSession(APP, USER, THREAD).blockingGet();
        manager.updateSessionState(before, Map.of(
                "pendingToolCallIds", new java.util.ArrayList<>(List.of("call-2")))).blockingAwait();
        RecordingSubscriber second = subscribe(agent.run(input));
        assertThat(second.await()).isTrue();

        Session after = manager.getSession(APP, USER, THREAD).blockingGet();
        Object pending = after.state().get("pendingToolCallIds");
        assertThat(pending).isInstanceOf(Collection.class);
        assertThat(new java.util.ArrayList<Object>((Collection<?>) pending)).containsExactly("call-2");
        agent.close();
    }

    @Test
    void pendingToolCallsPreservedWhileAnActiveExecutionExists() {
        InMemorySessionService sessions = new InMemorySessionService();
        Session held = sessionWithPending("s1", List.of("call-1"));
        sessions.createSession(APP, USER, new ConcurrentHashMap<>(held.state()), "s1").blockingGet();
        SessionManager manager = manager(sessions);

        // Active execution on this instance for the thread -> markers preserved.
        manager.verifyPendingToolCalls(APP, USER, "s1", THREAD, () -> true).blockingAwait();
        assertThat(manager.getSession(APP, USER, "s1").blockingGet().state()
                .get("pendingToolCallIds")).asList().containsExactly("call-1");
    }

    @Test
    void stalePendingToolCallsClearedWhenNoActiveExecutionExists() {
        InMemorySessionService sessions = new InMemorySessionService();
        sessions.createSession(APP, USER, new ConcurrentHashMap<>(Map.of(
                "pendingToolCallIds", new java.util.ArrayList<>(List.of("call-1")))), "s1")
                .blockingGet();
        SessionManager manager = manager(sessions);

        manager.verifyPendingToolCalls(APP, USER, "s1", THREAD, () -> false).blockingAwait();
        assertThat((Collection<?>) manager.getSession(APP, USER, "s1").blockingGet().state()
                .get("pendingToolCallIds")).isEmpty();
    }

    private static GoogleAdkAgent agent(SessionManager manager, AdkRunnerClient runner) {
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(manager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> USER)
                .build();
    }

    private static final class CountingRunner implements AdkRunnerClient {
        private int runs;

        @Override
        public String appName() {
            return APP;
        }

        @Override
        public Flowable<Event> runAsync(
                String userId, String sessionId, Content content, RunConfig config, Map<String, Object> stateDelta) {
            runs++;
            return Flowable.empty();
        }
    }

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
