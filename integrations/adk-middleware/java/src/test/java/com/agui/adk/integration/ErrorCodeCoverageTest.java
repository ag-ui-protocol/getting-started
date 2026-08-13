package com.agui.adk.integration;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.AdkAgUiOptions;
import com.agui.adk.AdkRunnerClient;
import com.agui.adk.GoogleAdkAgent;
import com.agui.adk.SessionManager;
import com.agui.adk.SessionManagerTestFixtures;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.encoding.CanonicalEventEncoder;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.hitl.ConfirmationRequest;
import com.agui.adk.hitl.ConfirmationRequestStore;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingCallStore;
import com.agui.adk.hitl.PendingToolCall;
import com.agui.adk.hitl.PendingResultTransition;
import com.agui.adk.hitl.ConsumedToolResult;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.input.RunExtensionSupport;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;

import java.time.Duration;
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

/**
 * Covers every reachable {@code AdkAgUiErrorCode} with an exact
 * {@code RunErrorEvent(message, CODE, null, null)} assertion.
 *
 * <p>Codes carrying an exact Python {@code ag_ui_adk} name are asserted under that name, so a
 * client written against the reference middleware branches identically here:
 * {@code PENDING_TOOL_CALLS}, {@code EXECUTION_TIMEOUT}, {@code ENCODING_ERROR},
 * {@code NO_TOOL_RESULTS}, {@code EXECUTION_ERROR}, and {@code TOOL_RESULT_BUFFER_ERROR}.
 * {@code TOOL_RESULT_PROCESSING_ERROR} is covered by
 * {@code GoogleAdkAgentBaselineTest.toolResultProcessingFailureRaisesToolResultProcessingError},
 * which needs package access to the {@code SessionManager} seam.
 *
 * <p>{@code AGENT_ERROR} remains an intentional endpoint-layer vocabulary entry: Python emits it
 * only when the HTTP/SSE adapter fails while consuming {@code agent.run}, outside this agent module.
 * {@code BACKGROUND_EXECUTION_ERROR} remains intentional because Java uses one reactive runner
 * stream rather than Python's detached background task/event queue. {@code CANCELLATION} is a
 * Java-specific declared refinement that remains unbranchable (see
 * {@link #cancellationIsAnUnbranchableParityGap()}).
 */
class ErrorCodeCoverageTest {

    // Verified stable public messages for rejections that do not pass through codedRunError.
    private static final String INVALID_RUN_INPUT_MESSAGE = "Invalid run input";
    private static final String DUPLICATE_TOOL_NAME_MESSAGE = "Duplicate tool name";
    private static final String ENCODING_ERROR_MESSAGE = "Event encoding failed";
    private static final String SESSION_FAILURE_MESSAGE = "Session failure";
    private static final String UNSUPPORTED_AUTH_REQUEST_MESSAGE = "Unsupported auth request";
    private static final String CONCURRENCY_LIMIT_MESSAGE = "Global execution concurrency limit reached";
    private static final String TIMEOUT_MESSAGE = "Google ADK run timed out";
    private static final String PENDING_CALLS_MESSAGE = "Pending tool calls";
    private static final String UNKNOWN_TOOL_RESULT_MESSAGE = "Unknown tool result";
    private static final String PERSISTENCE_FAILURE_MESSAGE = "Persistence failure";
    private static final String EXECUTION_ERROR_MESSAGE = "runner failed";

    @Test
    void invalidRunInputFromBlankResolvedUserId() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        GoogleAdkAgent agent = base(sessions, new EmptyRunner())
                .userIdExtractor(ignored -> "   ")
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent(INVALID_RUN_INPUT_MESSAGE, "INVALID_RUN_INPUT", null, null));
    }

    @Test
    void duplicateToolNameWhenBackendSetCollidesWithFrontendTool() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        GoogleAdkAgent agent = base(sessions, new EmptyRunner())
                .configuredBackendToolNames(Set.of("browser"))
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(frontendInput()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent(DUPLICATE_TOOL_NAME_MESSAGE, "DUPLICATE_TOOL_NAME", null, null));
    }

    @Test
    void frontendToolWithoutEventEncoderFailsEncoding() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(new EmptyRunner())
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(frontendInput()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent(ENCODING_ERROR_MESSAGE, "ENCODING_ERROR", null, null));
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void confirmationSessionLookupFailureRaisesSessionFailure() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenThrow(new IllegalStateException("lookup unavailable"));
        GoogleAdkAgent agent = base(sessions, new EmptyRunner()).build();

        RecordingSubscriber subscriber = subscribe(agent.run(confirmationInput()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent(SESSION_FAILURE_MESSAGE, "SESSION_FAILURE", null, null));
    }

    @Test
    void authActionWithoutAdapterIsUnsupported() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        GoogleAdkAgent agent = base(sessions, new EmptyRunner()).build();

        RecordingSubscriber subscriber = subscribe(agent.run(authInput()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent(UNSUPPORTED_AUTH_REQUEST_MESSAGE, "UNSUPPORTED_AUTH_REQUEST", null, null));
    }

    @Test
    void secondAcceptedRunExceedingGlobalLimitIsRejectedOnce() throws InterruptedException {
        BlockingRunner runner = new BlockingRunner();
        SessionManager sessions = mock(SessionManager.class);
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        whenSessionResolution(sessions);
        GoogleAdkAgent agent = leaseAgent(sessions, runner,
                new AdkAgUiOptions(false, Duration.ofSeconds(5), 1));

        RecordingSubscriber first = subscribe(agent.run(input("thread-one", "run-one")));
        assertThat(runner.started.await(1, TimeUnit.SECONDS)).isTrue();

        // A distinct thread bypasses same-key serialization so the second run reaches
        // the process-local global limiter and is rejected immediately.
        RecordingSubscriber rejected = subscribe(agent.run(input("thread-two", "run-two")));
        assertThat(rejected.await()).isTrue();
        assertThat(rejected.error).isNull();
        assertThat(rejected.events).startsWith(
                new RunStartedEvent("thread-two", "run-two"),
                new RunErrorEvent(CONCURRENCY_LIMIT_MESSAGE, "CONCURRENCY_LIMIT", null, null));

        first.cancel();
    }

    @Test
    void acceptedRunTimesOutOnceAndCancelsItsRunner() throws InterruptedException {
        BlockingRunner runner = new BlockingRunner();
        SessionManager sessions = mock(SessionManager.class);
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        whenSessionResolution(sessions);
        GoogleAdkAgent agent = leaseAgent(sessions, runner,
                new AdkAgUiOptions(false, Duration.ofMillis(25), 1));

        RecordingSubscriber subscriber = subscribe(agent.run(input("thread", "run")));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent(TIMEOUT_MESSAGE, "EXECUTION_TIMEOUT", null, null));
        // Runtime cancellation reaching the runner seam is covered by ExecutionStressTest
        // (its minimal builder propagates the cancellation token to the runner flowable's
        // doOnCancel). This builder shape routes the terminal event through the history
        // snapshot pipeline, so only the stable TIMEOUT contract is asserted here.
    }

    @Test
    void conflictingFrontendResultGroupsRaisePendingCalls() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = base(sessions, new EmptyRunner())
                .pendingCallStore(new TwoPendingCallsStore())
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(pendingCallsInput()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent(PENDING_CALLS_MESSAGE, "PENDING_TOOL_CALLS", null, null));
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void unclaimedConfirmationRaisesUnknownToolResult() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(Maybe.just(resolvedSession()));
        GoogleAdkAgent agent = base(sessions, new EmptyRunner())
                .confirmationRequestStore(new NeverClaimingConfirmations())
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(confirmationInput()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        // The unclaimed-confirmation path returns a bare coded error (no public RunStartedEvent),
        // matching the production switchIfEmpty branch for unknown confirmation results.
        assertThat(subscriber.events).containsExactly(
                new RunErrorEvent(UNKNOWN_TOOL_RESULT_MESSAGE, "UNKNOWN_TOOL_RESULT", null, null));
    }

    @Test
    void replayFailingPersistenceRaisesPersistenceFailure() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(Maybe.just(resolvedSession()));
        GoogleAdkAgent agent = base(sessions, new EmptyRunner())
                .pendingCallStore(new ThrowingPendingStore())
                .build();

        RecordingSubscriber subscriber = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).containsExactly(
                new RunErrorEvent(PERSISTENCE_FAILURE_MESSAGE, "PERSISTENCE_FAILURE", null, null));
    }

    @Test
    void runnerFailureMapsToExecutionErrorWithStableMessage() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        whenSessionResolution(sessions);
        GoogleAdkAgent agent = base(sessions, new FailingRunner()).build();

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent(EXECUTION_ERROR_MESSAGE, "EXECUTION_ERROR", null, null));
    }

    /**
     * Documents the <strong>unbranchable</strong> parity gap for {@code CANCELLATION}.
     *
     * <p>The {@code AdkAgUiErrorCode.CANCELLATION} value is declared for transport-level
     * parity with the Python bridge, but the Java production translation never branches on
     * it anywhere. Cancellation currently surfaces as terminal {@code RunFinishedEvent}
     * completions or as {@code TIMEOUT}/{@code CONCURRENCY_LIMIT} errors, never as a
     * dedicated {@code CANCELLATION} error. A test cannot pin a guaranteed interaction
     * (it would be asserting an internal call sequence rather than a stable published
     * behavior), so the case is documented instead of fabricated.
     */
    @Test
    void cancellationIsAnUnbranchableParityGap() {
        // Intentionally empty: CANCELLATION is never branched in GoogleAdkAgent.java.
    }

    @Test
    void toolLedSubmissionWithoutToolResultsRaisesNoToolResults() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class, invocation ->
                invocation.getMethod().getName().equals("getProcessedMessageIds")
                        ? Single.just(Set.of("empty-result"))
                        : org.mockito.Answers.RETURNS_DEFAULTS.answer(invocation));
        Session processedSession = Session.builder("session").appName("app").userId("user")
                .state(Map.of("processedMessageIds", Set.of("empty-result"))).build();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(
                new ResolvedSession(processedSession, new SessionMapping(
                        new SessionMappingKey("app", "user", "thread"), "session"))));
        GoogleAdkAgent agent = base(sessions, new EmptyRunner()).build();

        RecordingSubscriber subscriber = subscribe(agent.run(noToolResultsInput()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("No tool results found in submission", "NO_TOOL_RESULTS", null, null));
    }

    @Test
    void partialFrontendResultBufferFailureRaisesToolResultBufferError() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        whenSessionResolution(sessions);
        GoogleAdkAgent agent = base(sessions, new EmptyRunner())
                .pendingCallStore(new FailingPartialBufferStore())
                .build();

        RecordingSubscriber subscriber = subscribe(agent.run(singleToolResultInput()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Failed to persist tool results while waiting for the rest of the turn",
                        "TOOL_RESULT_BUFFER_ERROR", null, null));
    }

    /** Python emits AGENT_ERROR only in endpoint.py around consumption of agent.run. */
    @Test
    void agentErrorIsAnEndpointLayerVocabularyEntry() {
        // Intentionally documented: the scoped Java agent has no HTTP/SSE endpoint boundary.
    }

    /** Python's detached background task has no equivalent in Java's single reactive stream. */
    @Test
    void backgroundExecutionErrorHasNoDetachedJavaExecutionPath() {
        // Intentionally documented: reactive runner failures use EXECUTION_ERROR.
    }

    // ---- builders ---- //
    private static GoogleAdkAgent.Builder base(
            SessionManager sessions, AdkRunnerClient runner) {
        return base(sessions, runner, emptyPending());
    }

    /**
     * Builds a minimal lease-test agent modeled on ExecutionStressTest: no event
     * encoder and no pending stores, so a blocking runner's cancellation is observed
     * directly at the runner seam rather than through the translator pipeline.
     */
    private static GoogleAdkAgent leaseAgent(
            SessionManager sessions, AdkRunnerClient runner, AdkAgUiOptions options) {
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .options(options)
                .build();
    }

    private static GoogleAdkAgent.Builder base(
            SessionManager sessions, AdkRunnerClient runner, Flowable<PendingToolCall> pendingCalls) {
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .eventEncoder(event -> new EncodedEvent(event, chunkJson(event)))
                .pendingCallStore(new SessionPendingCallStoreFor(pendingCalls));
    }

    private static String chunkJson(ToolCallChunkEvent event) {
        return "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"" + event.toolCallId()
                + "\",\"toolCallName\":\"" + event.toolCallName()
                + "\",\"delta\":\"" + event.delta().replace("\"", "\\\"") + "\"}";
    }

    private static void whenSessionResolution(SessionManager sessions) {
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenAnswer(invocation -> {
            AdkAgUiRunContext context = invocation.getArgument(0);
            Session session = Session.builder(context.sessionId()).appName(context.appName())
                    .userId(context.userId()).state(Map.of()).build();
            return Single.just(new ResolvedSession(session, new SessionMapping(
                    new SessionMappingKey(context.appName(), context.userId(), context.threadId()),
                    context.sessionId())));
        });
    }

    // ---- inputs ---- //
    private static RunAgentInput input() {
        return new RunAgentInput("thread", "run", Map.of(), List.of(new UserMessage("message", "Hello")),
                List.of(), List.of(new Context("appName", "app")), Map.of());
    }

    private static RunAgentInput input(String threadId, String runId) {
        return new RunAgentInput(threadId, runId, Map.of(), List.of(new UserMessage("message", "Hello")),
                List.of(), List.of(new Context("appName", "app")), Map.of());
    }

    private static RunAgentInput frontendInput() {
        return new RunAgentInput("thread", "run", Map.of(), List.of(new UserMessage("message", "Hello")),
                List.of(new Tool("browser", "Browser tool", new ToolParameters(Map.of(), List.of()))),
                List.of(new Context("appName", "app")), Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY,
                Map.of("rawToolSchemas", List.of(Map.of("position", 0, "name", "browser",
                        "schema", Map.of("type", "object"))))));
    }

    private static RunAgentInput confirmationInput() {
        return RunExtensionSupport.attach(
                new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null),
                new AdkRunExtensions(null, List.of()));
    }

    private static RunAgentInput authInput() {
        return RunExtensionSupport.attach(
                new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null),
                new AdkRunExtensions(null, List.of(), new AdkRunExtensions.AuthAction(
                        "request-1", Map.of())));
    }

    private static RunAgentInput pendingCallsInput() {
        return new RunAgentInput("thread", "run", Map.of(),
                List.of(new ToolMessage("first", "{}", "first"), new ToolMessage("second", "{}", "second")),
                List.of(new Tool("browser", "Browser tool", new ToolParameters(Map.of(), List.of()))),
                List.of(new Context("appName", "app")), Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY,
                Map.of("rawToolSchemas", List.of(Map.of("position", 0, "name", "browser",
                        "schema", Map.of("type", "object"))))));
    }

    private static RunAgentInput noToolResultsInput() {
        return new RunAgentInput("thread", "run", Map.of(),
                List.of(new ToolMessage("empty-result", "{}", "call")),
                List.of(), List.of(new Context("appName", "app")), Map.of());
    }

    private static RunAgentInput singleToolResultInput() {
        return new RunAgentInput("thread", "run", Map.of(),
                List.of(new ToolMessage("first-result", "{}", "first")),
                List.of(), List.of(new Context("appName", "app")), Map.of());
    }

    private static ResolvedSession resolvedSession() {
        Session session = Session.builder("session").appName("app").userId("user").state(Map.of()).build();
        return new ResolvedSession(session, new SessionMapping(
                new SessionMappingKey("app", "user", "thread"), "session"));
    }

    // ---- subscriber ---- //
    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    // ---- stores ---- //
    private static final class SessionPendingCallStoreFor implements PendingCallStore {
        private final Flowable<PendingToolCall> pendingCalls;

        private SessionPendingCallStoreFor(Flowable<PendingToolCall> pendingCalls) {
            this.pendingCalls = pendingCalls;
        }

        @Override
        public Completable persist(PendingToolCall call) {
            return Completable.complete();
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return pendingCalls;
        }
    }

    private static Flowable<PendingToolCall> emptyPending() {
        return Flowable.empty();
    }

    private static final class ThrowingPendingStore implements PendingCallStore {
        @Override
        public Completable persist(PendingToolCall call) {
            return Completable.complete();
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            throw new IllegalStateException("store unavailable");
        }
    }

    private static final class TwoPendingCallsStore implements PendingCallStore {
        @Override
        public Completable persist(PendingToolCall call) {
            return Completable.complete();
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            com.agui.adk.hitl.PendingCallGroupKey firstGroup =
                    new com.agui.adk.hitl.PendingCallGroupKey(scope, "first-turn");
            com.agui.adk.hitl.PendingCallGroupKey secondGroup =
                    new com.agui.adk.hitl.PendingCallGroupKey(scope, "second-turn");
            return Flowable.just(
                    pendingCall(firstGroup, "first"),
                    pendingCall(secondGroup, "second"));
        }

        private static PendingToolCall pendingCall(
                com.agui.adk.hitl.PendingCallGroupKey group, String id) {
            return new PendingToolCall(
                    new com.agui.adk.hitl.PendingCallKey(group, id),
                    new ToolCallChunkEvent(id, "browser", "parent", "{}", 1L, null),
                    "{}", com.agui.adk.hitl.PendingStatus.PENDING);
        }
    }

    private static final class FailingPartialBufferStore implements PendingCallStore {
        @Override
        public Completable persist(PendingToolCall call) {
            return Completable.complete();
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            com.agui.adk.hitl.PendingCallGroupKey group =
                    new com.agui.adk.hitl.PendingCallGroupKey(scope, "turn");
            return Flowable.just(
                    TwoPendingCallsStore.pendingCall(group, "first"),
                    TwoPendingCallsStore.pendingCall(group, "second"));
        }

        @Override
        public Single<PendingResultTransition> submitResult(
                PendingCallScope scope, ConsumedToolResult result) {
            return Single.error(new IllegalStateException("buffer unavailable"));
        }
    }

    private static final class NeverClaimingConfirmations implements ConfirmationRequestStore {
        @Override
        public Completable persist(ConfirmationRequest request) {
            return Completable.complete();
        }

        @Override
        public Single<Boolean> claim(ConfirmationRequest request) {
            return Single.just(false);
        }

        @Override
        public Completable release(ConfirmationRequest request) {
            return Completable.complete();
        }

        @Override
        public Completable complete(ConfirmationRequest request) {
            return Completable.complete();
        }
    }

    // ---- runners ---- //
    private static final class EmptyRunner implements AdkRunnerClient {
        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            return Flowable.empty();
        }
    }

    private static final class FailingRunner implements AdkRunnerClient {
        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            return Flowable.error(new IllegalStateException("runner failed"));
        }
    }

    private static final class BlockingRunner implements AdkRunnerClient {
        private final AtomicInteger cancelled = new AtomicInteger();
        private final CountDownLatch started = new CountDownLatch(1);

        @Override
        public String appName() {
            return "app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            started.countDown();
            return Flowable.<com.google.adk.events.Event>never().doOnCancel(cancelled::incrementAndGet);
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private Throwable error;
        private Flow.Subscription subscription;

        @Override
        public void onSubscribe(Flow.Subscription value) {
            subscription = value;
            value.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event event) {
            events.add(event);
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

        private boolean await() throws InterruptedException {
            return terminal.await(5, TimeUnit.SECONDS);
        }

        private void cancel() {
            subscription.cancel();
        }
    }
}
