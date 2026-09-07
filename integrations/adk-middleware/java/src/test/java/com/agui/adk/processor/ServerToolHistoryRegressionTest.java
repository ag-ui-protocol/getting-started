package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.hitl.ConsumedToolResult;
import com.agui.adk.hitl.PendingCallGroupKey;
import com.agui.adk.hitl.PendingCallKey;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingStatus;
import com.agui.adk.hitl.PendingToolCall;
import com.agui.adk.hitl.ResumeClaim;
import com.agui.adk.hitl.SessionPendingCallStore;
import com.agui.adk.hitl.ToolResultNormalizer;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ServerToolHistoryRegressionTest {

    @Test
    void replayedConsumedFrontendResultIsHistoryAndDoesNotSwallowFollowingUserMessage() {
        SessionManager sessionManager = mock(SessionManager.class);
        when(sessionManager.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        Session session = Session.builder("session-1")
                .appName("app")
                .userId("user")
                .state(Map.of())
                .build();
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(
                new ResolvedSession(session, new SessionMapping(
                        new SessionMappingKey("app", "user", "thread"), "session-1"))));
        when(sessionManager.processToolResults(any(), any(), any())).thenReturn(Flowable.empty());
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), any()))
                .thenReturn(io.reactivex.rxjava3.core.Completable.complete());
        SessionPendingCallStore calls = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "user", "session-1");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        calls.persist(new PendingToolCall(new PendingCallKey(group, "frontend-call"),
                new ToolCallChunkEvent("frontend-call", "frontend", "{}"), "{}", PendingStatus.PENDING)).blockingAwait();
        ToolMessage replay = new ToolMessage("frontend-result", "{\"ok\":true}", "frontend-call");
        ResumeClaim claim = (ResumeClaim) calls.submitResult(scope,
                ConsumedToolResult.from(replay, new ToolResultNormalizer())).blockingGet();
        calls.complete(claim).blockingAwait();
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(input -> "user")
                .pendingCallStore(calls)
                .build();
        RunAgentInput payload = new RunAgentInput(
                "thread", "run-2", Map.of(),
                List.of(replay, new UserMessage("next-user", "Continue from the result.")),
                List.of(), List.of(new Context("appName", "app")), Map.of());

        RecordingSubscriber subscriber = new RecordingSubscriber();
        agent.run(payload).subscribe(subscriber);

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).noneMatch(RunErrorEvent.class::isInstance);
        assertThat(runner.content.parts().orElseThrow()).singleElement()
                .extracting(part -> part.text().orElse(null))
                .isEqualTo("Continue from the result.");
        ArgumentCaptor<List<Message>> processed = ArgumentCaptor.forClass(List.class);
        verify(sessionManager).markMessagesProcessedWithFingerprints(any(), processed.capture());
        assertThat(processed.getValue()).extracting(Message::id).containsExactly("next-user");
    }

    @Test
    void historicalUnmatchedServerToolResultDoesNotSwallowFollowingUserMessage() {
        SessionManager sessionManager = mock(SessionManager.class);
        when(sessionManager.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        Session session = Session.builder("session-1")
                .appName("app")
                .userId("user")
                .state(Map.of())
                .build();
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(
                new ResolvedSession(session, new SessionMapping(
                        new SessionMappingKey("app", "user", "thread"), "session-1"))));
        when(sessionManager.processToolResults(any(), any(), any())).thenReturn(Flowable.empty());
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), any()))
                .thenReturn(io.reactivex.rxjava3.core.Completable.complete());
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(input -> "user")
                .build();
        RunAgentInput capturedRegressionPayload = new RunAgentInput(
                "thread",
                "run-2",
                Map.of(),
                List.of(
                        new ToolMessage("server-tool-result", "{\"status\":\"done\"}", "server-call"),
                        new UserMessage("second-user-message", "What should happen next?")),
                List.of(),
                List.of(new Context("appName", "app")),
                Map.of());

        RecordingSubscriber subscriber = new RecordingSubscriber();
        agent.run(capturedRegressionPayload).subscribe(subscriber);

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).noneMatch(RunErrorEvent.class::isInstance);
        assertThat(runner.content).isNotNull();
        assertThat(runner.content.parts().orElseThrow())
                .singleElement()
                .extracting(part -> part.text().orElse(null))
                .isEqualTo("What should happen next?");
        ArgumentCaptor<List<Message>> processed = ArgumentCaptor.forClass(List.class);
        verify(sessionManager).markMessagesProcessedWithFingerprints(any(), processed.capture());
        assertThat(processed.getValue()).extracting(Message::id)
                .containsExactly("second-user-message");
    }

    private static final class CapturingRunner implements AdkRunnerClient {
        private volatile Content content;

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId,
                String sessionId,
                Content value,
                RunConfig runConfig,
                Map<String, Object> stateDelta) {
            content = value;
            return Flowable.empty();
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new CopyOnWriteArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private volatile Throwable error;

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event item) {
            events.add(item);
        }

        @Override
        public void onError(Throwable terminalError) {
            error = terminalError;
            terminal.countDown();
        }

        @Override
        public void onComplete() {
            terminal.countDown();
        }

        private boolean await() {
            try {
                return terminal.await(1, TimeUnit.SECONDS);
            } catch (InterruptedException interruption) {
                Thread.currentThread().interrupt();
                throw new AssertionError(interruption);
            }
        }
    }
}
