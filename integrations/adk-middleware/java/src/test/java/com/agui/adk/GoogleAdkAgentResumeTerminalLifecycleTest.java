package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.encoding.CanonicalEventEncoder;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.hitl.PendingCallGroupKey;
import com.agui.adk.hitl.PendingCallKey;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingStatus;
import com.agui.adk.hitl.PendingToolCall;
import com.agui.adk.hitl.ResumeClaim;
import com.agui.adk.hitl.SessionPendingCallStore;
import com.agui.adk.input.AdkRunExtensions;
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
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallResultEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GoogleAdkAgentResumeTerminalLifecycleTest {
    @Test
    void resumedEncoderFailureWaitsForRollbackAndClaimReleaseBeforeStableTerminalError() throws InterruptedException {
        ResumeFixture fixture = fixture(event -> {
            throw new IllegalArgumentException("cannot encode");
        }, false);

        assertResumeTerminalFailure(fixture, "Event encoding failed", "ENCODING_ERROR");
    }

    @Test
    void resumedPersistenceFailureWaitsForRollbackAndClaimReleaseBeforeStableTerminalError() throws InterruptedException {
        ResumeFixture fixture = fixture(event -> new EncodedEvent(event, encodedJson(event)), true);

        assertResumeTerminalFailure(fixture, "Persistence failure", "PERSISTENCE_FAILURE");
    }

    private static void assertResumeTerminalFailure(ResumeFixture fixture, String message, String code) throws InterruptedException {
        RecordingSubscriber first = subscribe(fixture.agent.run(input()));
        if (fixture.calls.failPersistence) {
            assertThat(fixture.calls.awaitPersistence()).isTrue();
            fixture.calls.failPersistence();
        }

        assertThat(fixture.reservations.awaitRollback()).isTrue();
        assertThat(first.events).containsExactly(new RunStartedEvent("thread", "run"));
        assertThat(first.terminal()).isFalse();
        assertThat(fixture.reservations.commits).hasValue(0);
        assertThat(fixture.reservations.rollbacks).hasValue(1);
        assertThat(fixture.calls.releases).hasValue(0);

        RecordingSubscriber blockedRetry = subscribe(fixture.agent.run(input()));
        assertThat(blockedRetry.terminal()).isFalse();
        assertThat(fixture.runner.calls).hasValue(1);

        fixture.reservations.completeRollback();
        assertThat(fixture.calls.awaitRelease()).isTrue();
        assertThat(first.terminal()).isFalse();
        assertThat(first.events).containsExactly(new RunStartedEvent("thread", "run"));
        assertThat(fixture.calls.releases).hasValue(1);

        fixture.calls.completeRelease();

        assertThat(first.await()).isTrue();
        assertThat(first.error).isNull();
        assertThat(first.events).startsWith(
                new RunStartedEvent("thread", "run"), new RunErrorEvent(message, code, null, null));
        assertThat(first.events).anySatisfy(event -> assertThat(event).isInstanceOf(RunFinishedEvent.class));
        assertThat(first.events).noneMatch(event -> event instanceof ToolCallChunkEvent
                || event instanceof ToolCallStartEvent
                || event instanceof ToolCallArgsEvent
                || event instanceof ToolCallEndEvent
                || event instanceof ToolCallResultEvent);
        assertThat(fixture.reservations.commits).hasValue(0);
        assertThat(fixture.reservations.rollbacks).hasValue(1);
        assertThat(fixture.calls.releases).hasValue(1);
        assertThat(blockedRetry.terminal()).isFalse();
        assertThat(fixture.runner.calls).hasValue(2);
    }

    private static ResumeFixture fixture(CanonicalEventEncoder encoder, boolean failPersistence) {
        SessionPendingCallStore delegate = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "principal", "session");
        delegate.persist(new PendingToolCall(
                new PendingCallKey(new PendingCallGroupKey(scope, "turn"), "call"),
                new ToolCallChunkEvent("call", "browser", "{}"), "{}", PendingStatus.PENDING)).blockingAwait();
        GatedCalls calls = new GatedCalls(delegate, failPersistence);
        BlockingReservations reservations = new BlockingReservations();
        ResumingRunner runner = new ResumingRunner();
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .eventEncoder(encoder)
                .pendingCallStore(calls)
                .messageReservationStore(reservations)
                .build();
        return new ResumeFixture(agent, runner, reservations, calls);
    }

    private static RunAgentInput input() {
        return new RunAgentInput("thread", "run", Map.of(),
                List.of(new ToolMessage("browser-result", "{\"ok\":true}", "call")),
                List.of(new Tool("browser", "Browser tool", new ToolParameters(Map.of(), List.of()))),
                List.of(new Context("appName", "app")), Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of(
                        "rawToolSchemas", List.of(Map.of("position", 0, "name", "browser", "schema", Map.of("type", "object"))))));
    }

    private static String encodedJson(ToolCallChunkEvent event) {
        return "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"" + event.toolCallId()
                + "\",\"toolCallName\":\"" + event.toolCallName() + "\",\"delta\":\"{}\"}";
    }

    private static ResolvedSession resolvedSession() {
        return new ResolvedSession(Session.builder("session").appName("app").userId("principal").state(Map.of()).build(),
                new SessionMapping(new SessionMappingKey("app", "principal", "thread"), "session"));
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private record ResumeFixture(GoogleAdkAgent agent, ResumingRunner runner, BlockingReservations reservations, GatedCalls calls) {
    }

    private static final class GatedCalls implements com.agui.adk.hitl.PendingCallStore {
        private final SessionPendingCallStore delegate;
        private final boolean failPersistence;
        private final CompletableSubject persistence = CompletableSubject.create();
        private final CompletableSubject release = CompletableSubject.create();
        private final CountDownLatch persistenceStarted = new CountDownLatch(1);
        private final CountDownLatch releaseStarted = new CountDownLatch(1);
        private final AtomicInteger releases = new AtomicInteger();

        private GatedCalls(SessionPendingCallStore delegate, boolean failPersistence) {
            this.delegate = delegate;
            this.failPersistence = failPersistence;
        }

        @Override public Completable persist(PendingToolCall call) {
            return failPersistence ? persistence.doOnSubscribe(ignored -> persistenceStarted.countDown())
                    : delegate.persist(call);
        }
        @Override public Flowable<PendingToolCall> pending(PendingCallScope scope) { return delegate.pending(scope); }
        @Override public Map<String, com.agui.adk.hitl.ConsumedToolResult> consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }
        @Override public Single<com.agui.adk.hitl.PendingResultTransition> submitResult(
                PendingCallScope scope, com.agui.adk.hitl.ConsumedToolResult result) {
            return delegate.submitResult(scope, result);
        }
        @Override public Completable release(ResumeClaim claim) {
            return Completable.defer(() -> {
                releases.incrementAndGet();
                releaseStarted.countDown();
                return release.andThen(delegate.release(claim));
            });
        }
        @Override public Completable markFinalizationPending(ResumeClaim claim) { return delegate.markFinalizationPending(claim); }
        @Override public Single<Boolean> finalizationPending(ResumeClaim claim) { return delegate.finalizationPending(claim); }
        @Override public Completable complete(ResumeClaim claim) { return delegate.complete(claim); }
        private boolean awaitPersistence() throws InterruptedException { return persistenceStarted.await(1, TimeUnit.SECONDS); }
        private void failPersistence() { persistence.onError(new IllegalStateException("store unavailable")); }
        private boolean awaitRelease() throws InterruptedException { return releaseStarted.await(1, TimeUnit.SECONDS); }
        private void completeRelease() { release.onComplete(); }
    }

    private static final class BlockingReservations implements MessageReservationStore {
        private final CompletableSubject rollback = CompletableSubject.create();
        private final CountDownLatch rollbackStarted = new CountDownLatch(1);
        private final AtomicInteger commits = new AtomicInteger();
        private final AtomicInteger rollbacks = new AtomicInteger();

        @Override public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            return Single.just(new MessageReservation(session, messages, invocationId));
        }
        @Override public Completable commit(MessageReservation reservation) {
            return Completable.fromAction(commits::incrementAndGet);
        }
        @Override public Completable rollback(MessageReservation reservation) {
            return Completable.defer(() -> {
                rollbacks.incrementAndGet();
                rollbackStarted.countDown();
                return rollback;
            });
        }
        private boolean awaitRollback() throws InterruptedException { return rollbackStarted.await(1, TimeUnit.SECONDS); }
        private void completeRollback() { rollback.onComplete(); }
    }

    private static final class ResumingRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        @Override public String appName() { return "app"; }
        @Override public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig config, Map<String, Object> stateDelta) {
            return calls.getAndIncrement() == 0 ? Flowable.just(frontendCall()) : Flowable.never();
        }
        private static com.google.adk.events.Event frontendCall() {
            return com.google.adk.events.Event.builder().author("model").content(Content.builder().role("model")
                    .parts(Part.builder().functionCall(FunctionCall.builder().id("new-call").name("browser").args(Map.of()).build())
                            .build()).build()).build();
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private Throwable error;
        @Override public void onSubscribe(Flow.Subscription subscription) { subscription.request(Long.MAX_VALUE); }
        @Override public void onNext(Event event) { events.add(event); }
        @Override public void onError(Throwable failure) { error = failure; terminal.countDown(); }
        @Override public void onComplete() { terminal.countDown(); }
        private boolean await() throws InterruptedException { return terminal.await(1, TimeUnit.SECONDS); }
        private boolean terminal() { return terminal.getCount() == 0; }
    }
}
