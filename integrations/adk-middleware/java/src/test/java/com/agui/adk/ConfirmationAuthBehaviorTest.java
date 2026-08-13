package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.events.EventActions;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListEventsResponse;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import com.agui.adk.execution.InProcessExecutionCoordinator;
import com.agui.adk.hitl.ConfirmationRequestStore;
import com.agui.adk.session.SessionMappingKey;
import com.agui.adk.session.ThreadSessionMappingStore;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.agui.adk.auth.AdkAuthRequestAdapter;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.hitl.ConfirmationRequest;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.SessionConfirmationRequestStore;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.input.RunExtensionSupport;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.adk.translator.EventTranslator;
import com.agui.adk.translator.EventTranslatorFactory;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockingDetails;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ConfirmationAuthBehaviorTest {
    private static SessionManager mockSessionManager() {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        return sessions;
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void typedApproveAndRejectReachRunnerWithNativeCorrelations() throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        CapturingRunner runner = new CapturingRunner();
        SessionConfirmationRequestStore confirmations = confirmations(
                "invocation-approve", "adk-call-approve", "invocation-reject", "adk-call-reject");
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations);
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession("thread")));

        collect(agent.run(confirmationInput("invocation-approve", "adk-call-approve", true)));
        collect(agent.run(confirmationInput("invocation-reject", "adk-call-reject", false)));

        assertThat(runner.contents).hasSize(2);
        assertNativeConfirmation(runner.contents.get(0), "invocation-approve", "adk-call-approve", true);
        assertNativeConfirmation(runner.contents.get(1), "invocation-reject", "adk-call-reject", false);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void publicConfirmationSynchronousSessionLookupFailureCompletesWithStructuredSessionFailure()
            throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations("invocation", "call"));
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenThrow(new IllegalStateException("lookup unavailable"));

        EventCollector subscriber = subscribeEvents(agent.run(confirmationInput("invocation", "call", true)));
        subscriber.awaitTerminal();

        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Session failure", "SESSION_FAILURE", null, null));
        assertThat(runner.calls).hasValue(0);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void wireApproveAndRejectDecodeToTheSameNativeContinuation() throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        CapturingRunner runner = new CapturingRunner();
        SessionConfirmationRequestStore confirmations = confirmations(
                "invocation-approve", "adk-call-approve", "invocation-reject", "adk-call-reject");
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations);
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession("thread")));

        collect(agent.run(wireConfirmationInput("invocation-approve", "adk-call-approve", true)));
        collect(agent.run(wireConfirmationInput("invocation-reject", "adk-call-reject", false)));

        assertThat(runner.contents).hasSize(2);
        assertNativeConfirmation(runner.contents.get(0), "invocation-approve", "adk-call-approve", true);
        assertNativeConfirmation(runner.contents.get(1), "invocation-reject", "adk-call-reject", false);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void nativeConfirmationOutputIsCapturedBeforeMatchingApproveAndRejectContinue() throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        CapturingRunner runner = new CapturingRunner();
        SessionConfirmationRequestStore confirmations = new SessionConfirmationRequestStore();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations);
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession("thread")));
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession("thread")));
        when(sessions.markMessagesProcessedWithFingerprints(any(), any()))
                .thenReturn(io.reactivex.rxjava3.core.Completable.complete());
        runner.events.add(nativeConfirmationEvent("native-approve", "native-call-approve"));
        RunAgentInput userInput = new RunAgentInput("thread", "run", null,
                List.of(new UserMessage("prompt", "continue")), List.of(), List.of(), null);
        collectIgnoringError(agent.run(userInput));
        runner.events.add(nativeConfirmationEvent("native-reject", "native-call-reject"));
        collectIgnoringError(agent.run(userInput));
        collect(agent.run(confirmationInput("native-approve", "native-call-approve", true)));
        collect(agent.run(confirmationInput("native-reject", "native-call-reject", false)));

        assertThat(runner.contents).hasSize(4);
        assertNativeConfirmation(runner.contents.get(2), "native-approve", "native-call-approve", true);
        assertNativeConfirmation(runner.contents.get(3), "native-reject", "native-call-reject", false);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void synchronousConfirmationTranslatorConstructionFailureReleasesCapturedClaimForExactRetry()
            throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        CapturingRunner runner = new CapturingRunner();
        SessionConfirmationRequestStore confirmations = new SessionConfirmationRequestStore();
        AtomicInteger continuationTranslatorAttempts = new AtomicInteger();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations, (sessionId, runId, outputSchemaAgentNames) -> {
            if (runner.calls.get() == 1 && continuationTranslatorAttempts.getAndIncrement() == 0) {
                throw new IllegalStateException("translator construction failure");
            }
            return EventTranslatorFactory.INSTANCE.create(sessionId, runId, List.of(), outputSchemaAgentNames);
        });
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession("thread")));
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenReturn(Maybe.just(resolvedSession("thread")));
        when(sessions.markMessagesProcessedWithFingerprints(any(), any()))
                .thenReturn(Completable.complete());
        runner.events.add(nativeConfirmationEvent("captured-invocation", "captured-call"));

        collectIgnoringError(agent.run(new RunAgentInput("thread", "run", null,
                List.of(new UserMessage("prompt", "continue")), List.of(), List.of(), null)));
        collectIgnoringError(agent.run(confirmationInput("captured-invocation", "captured-call", true)));
        collect(agent.run(confirmationInput("captured-invocation", "captured-call", true)));
        List<Event> consumed = collect(agent.run(confirmationInput("captured-invocation", "captured-call", true)));

        assertThat(runner.calls).hasValue(2);
        assertThat(continuationTranslatorAttempts).hasValue(2);
        assertNativeConfirmation(runner.contents.get(1), "captured-invocation", "captured-call", true);
        assertThat(consumed).containsExactly(new RunErrorEvent("Unknown tool result", "UNKNOWN_TOOL_RESULT", null, null));
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void simultaneousIndependentAgentsClaimOneConfirmationOnlyOnce() throws Exception {
        SessionConfirmationRequestStore confirmations = confirmations("invocation", "call");
        BlockingRunner runner = new BlockingRunner();
        GoogleAdkAgent first = agent(existingSessions(), runner, null, confirmations);
        GoogleAdkAgent second = agent(existingSessions(), runner, null, confirmations);

        Thread owner = Thread.ofVirtual().start(() -> collectUnchecked(first.run(confirmationInput("invocation", "call", true))));
        assertThat(runner.started.await(5, TimeUnit.SECONDS)).isTrue();
        List<Event> loser = collect(second.run(confirmationInput("invocation", "call", true)));
        runner.finish.onComplete();
        owner.join();

        assertThat(runner.calls).hasValue(1);
        assertThat(loser).containsExactly(new RunErrorEvent("Unknown tool result", "UNKNOWN_TOOL_RESULT", null, null));
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void acceptedSameKeyConfirmationWaitsForAnOrdinaryExecutionLease() throws Exception {
        SessionManager sessions = mockSessionManager();
        OrdinalBlockingRunner runner = new OrdinalBlockingRunner();
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations("invocation", "call"),
                (sessionId, runId, outputSchemaAgentNames) ->
                        EventTranslatorFactory.INSTANCE.create(sessionId, runId, List.of(), outputSchemaAgentNames), coordinator);
        ResolvedSession session = resolvedSession("thread");
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(session));
        when(sessions.findExistingSession("test-app", "test-user", "thread")).thenReturn(Maybe.just(session));

        Thread ordinary = Thread.ofVirtual().start(() -> collectUnchecked(agent.run(new RunAgentInput("thread", "ordinary", null,
                List.of(new UserMessage("message", "prompt")), List.of(), List.of(), null))));
        assertThat(runner.ordinaryStarted.await(5, TimeUnit.SECONDS)).isTrue();

        Thread confirmation = Thread.ofVirtual().start(() -> collectUnchecked(agent.run(confirmationInput("invocation", "call", true))));
        assertThat(runner.confirmationStarted.await(200, TimeUnit.MILLISECONDS)).isFalse();
        assertThat(runner.calls).hasValue(1);

        runner.ordinaryFinish.onComplete();
        ordinary.join();
        assertThat(runner.confirmationStarted.await(5, TimeUnit.SECONDS)).isTrue();
        runner.confirmationFinish.onComplete();
        confirmation.join();

        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void acceptedDifferentKeyConfirmationDoesNotWaitForAnOrdinaryExecutionLease() throws Exception {
        SessionManager sessions = mockSessionManager();
        OrdinalBlockingRunner runner = new OrdinalBlockingRunner();
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        SessionConfirmationRequestStore confirmations = new SessionConfirmationRequestStore();
        confirmations.persist(new ConfirmationRequest(
                new PendingCallScope("test-app", "test-user", "other-thread"), "invocation", "call")).blockingAwait();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations,
                (sessionId, runId, outputSchemaAgentNames) ->
                        EventTranslatorFactory.INSTANCE.create(sessionId, runId, List.of(), outputSchemaAgentNames), coordinator);
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenAnswer(invocation -> Single.just(
                resolvedSession(invocation.getArgument(0, AdkAgUiRunContext.class).threadId())));
        when(sessions.findExistingSession("test-app", "test-user", "other-thread"))
                .thenReturn(Maybe.just(resolvedSession("other-thread")));

        Thread ordinary = Thread.ofVirtual().start(() -> collectUnchecked(agent.run(new RunAgentInput("thread", "ordinary", null,
                List.of(new UserMessage("message", "prompt")), List.of(), List.of(), null))));
        assertThat(runner.ordinaryStarted.await(5, TimeUnit.SECONDS)).isTrue();
        Thread confirmation = Thread.ofVirtual().start(() -> collectUnchecked(agent.run(confirmationInput(
                "other-thread", "invocation", "call", true))));
        assertThat(runner.confirmationStarted.await(5, TimeUnit.SECONDS)).isTrue();

        runner.confirmationFinish.onComplete();
        confirmation.join();
        runner.ordinaryFinish.onComplete();
        ordinary.join();
        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void acceptedDifferentKeyConfirmationRunsAndTerminatesWhileOrdinaryKeyIsOccupied() throws Exception {
        SessionManager sessions = mockSessionManager();
        OrdinalBlockingRunner runner = new OrdinalBlockingRunner();
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        SessionConfirmationRequestStore confirmations = new SessionConfirmationRequestStore();
        confirmations.persist(new ConfirmationRequest(
                new PendingCallScope("test-app", "test-user", "other-thread"), "invocation", "call")).blockingAwait();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations,
                (sessionId, runId, outputSchemaAgentNames) ->
                        EventTranslatorFactory.INSTANCE.create(sessionId, runId, List.of(), outputSchemaAgentNames), coordinator);
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenAnswer(invocation -> Single.just(
                resolvedSession(invocation.getArgument(0, AdkAgUiRunContext.class).threadId())));
        when(sessions.findExistingSession("test-app", "test-user", "other-thread"))
                .thenReturn(Maybe.just(resolvedSession("other-thread")));

        Thread ordinary = Thread.ofVirtual().start(() -> collectUnchecked(agent.run(new RunAgentInput("thread", "ordinary", null,
                List.of(new UserMessage("message", "prompt")), List.of(), List.of(), null))));
        assertThat(runner.ordinaryStarted.await(5, TimeUnit.SECONDS)).isTrue();

        EventCollector confirmation = subscribeEvents(agent.run(confirmationInput(
                "other-thread", "invocation", "call", true)));
        assertThat(runner.confirmationStarted.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.calls).hasValue(2);
        runner.confirmationFinish.onComplete();
        confirmation.awaitTerminal();
        assertThat(confirmation.events).startsWith(
                new RunStartedEvent("other-thread", "run"),
                // Every normally-completing run closes with a STATE_SNAPSHOT (Python parity).
                new RunFinishedEvent("other-thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));

        runner.ordinaryFinish.onComplete();
        ordinary.join();
        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void confirmationSessionLookupFailureUsesAcceptedCodedLifecycle() throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenReturn(Maybe.error(new IllegalStateException("session store unavailable")));
        EventCollector subscriber = subscribeEvents(agent(sessions, new CapturingRunner(), null,
                confirmations("invocation", "call")).run(confirmationInput("invocation", "call", true)));

        subscriber.awaitTerminal();

        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Session failure", "SESSION_FAILURE", null, null));
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void synchronousConfirmationSessionLookupFailureUsesAcceptedCodedLifecycle() throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenThrow(new IllegalStateException("session store unavailable"));
        EventCollector subscriber = subscribeEvents(agent(sessions, new CapturingRunner(), null,
                confirmations("invocation", "call")).run(confirmationInput("invocation", "call", true)));

        subscriber.awaitTerminal();

        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Session failure", "SESSION_FAILURE", null, null));
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void publicConfirmationSynchronousClaimFailureCompletesWithStructuredPersistenceFailure()
            throws InterruptedException {
        SessionManager sessions = existingSessions();
        ConfirmationRequestStore confirmations = mock(ConfirmationRequestStore.class);
        when(confirmations.claim(any())).thenThrow(new IllegalStateException("claim unavailable"));
        CapturingRunner runner = new CapturingRunner();

        EventCollector subscriber = subscribeEvents(agent(sessions, runner, null, confirmations)
                .run(confirmationInput("invocation", "call", true)));
        subscriber.awaitTerminal();

        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(runner.calls).hasValue(0);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void publicConfirmationReactiveClaimFailureCompletesWithStructuredPersistenceFailure()
            throws InterruptedException {
        SessionManager sessions = existingSessions();
        ConfirmationRequestStore confirmations = mock(ConfirmationRequestStore.class);
        when(confirmations.claim(any())).thenReturn(
                Single.error(new IllegalStateException("claim unavailable")));
        CapturingRunner runner = new CapturingRunner();

        EventCollector subscriber = subscribeEvents(agent(sessions, runner, null, confirmations)
                .run(confirmationInput("invocation", "call", true)));
        subscriber.awaitTerminal();

        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(runner.calls).hasValue(0);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void claimedConfirmationGlobalAdmissionFailureUsesLifecycleAndReleasesClaim() throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        OrdinalBlockingRunner runner = new OrdinalBlockingRunner();
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        SessionConfirmationRequestStore confirmations = new SessionConfirmationRequestStore();
        confirmations.persist(new ConfirmationRequest(
                new PendingCallScope("test-app", "test-user", "other-thread"), "invocation", "call")).blockingAwait();
        ResolvedSession session = resolvedSession("other-thread");
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession("thread")));
        when(sessions.findExistingSession("test-app", "test-user", "other-thread")).thenReturn(Maybe.just(session));
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations,
                (sessionId, runId, outputSchemaAgentNames) ->
                        EventTranslatorFactory.INSTANCE.create(sessionId, runId, List.of(), outputSchemaAgentNames), coordinator,
                new AdkAgUiOptions(false, java.time.Duration.ofMinutes(1), 1));

        EventCollector ordinary = subscribeEvents(agent.run(new RunAgentInput("thread", "ordinary", null,
                List.of(new UserMessage("message", "prompt")), List.of(), List.of(), null)));
        assertThat(runner.ordinaryStarted.await(5, TimeUnit.SECONDS)).isTrue();
        EventCollector confirmation = subscribeEvents(agent.run(confirmationInput(
                "other-thread", "invocation", "call", true)));

        confirmation.awaitTerminal();

        assertThat(confirmation.error).isNull();
        assertThat(confirmation.events).startsWith(
                new RunStartedEvent("other-thread", "run"),
                new RunErrorEvent("Global execution concurrency limit reached", "CONCURRENCY_LIMIT", null, null));
        ConfirmationRequest request = new ConfirmationRequest(
                new PendingCallScope("test-app", "test-user", "other-thread"), "invocation", "call");
        assertThat(confirmations.claim(request).blockingGet()).isTrue();
        confirmations.release(request).blockingAwait();
        runner.ordinaryFinish.onComplete();
        ordinary.awaitTerminal();
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void acceptedConfirmationConvertsContinuationFailureIntoOneTerminalLifecycleError() throws InterruptedException {
        SessionConfirmationRequestStore confirmations = confirmations("invocation", "call");
        GoogleAdkAgent agent = agent(existingSessions(),
                new FailingThenSuccessfulRunner(FailureMode.ASYNC), null, confirmations);

        List<Event> events = collect(agent.run(confirmationInput("invocation", "call", true)));

        assertThat(events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("async failure", "ADK_EXECUTION_FAILURE", null, null));
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void publicSuccessfulConfirmationRetainsSameKeyUntilDurableCompleteSettles() throws Exception {
        SessionManager sessions = mockSessionManager();
        GatedCompleteConfirmations confirmations = new GatedCompleteConfirmations(
                confirmations("invocation", "call"));
        ConfirmationThenRetryRunner runner = new ConfirmationThenRetryRunner(false);
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations,
                (sessionId, runId, outputSchemaAgentNames) ->
                        EventTranslatorFactory.INSTANCE.create(sessionId, runId, List.of(), outputSchemaAgentNames), coordinator);
        ResolvedSession session = resolvedSession("thread");
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(session));
        when(sessions.findExistingSession("test-app", "test-user", "thread")).thenReturn(Maybe.just(session));
        when(sessions.markMessagesProcessedWithFingerprints(any(), any()))
                .thenReturn(Completable.complete());

        EventCollector confirmation = subscribeEvents(agent.run(confirmationInput("invocation", "call", true)));
        assertThat(confirmations.completeStarted.await(5, TimeUnit.SECONDS)).isTrue();

        EventCollector retry = subscribeEvents(agent.run(new RunAgentInput("thread", "retry", null,
                List.of(new UserMessage("message", "retry")), List.of(), List.of(), null)));
        assertThat(runner.retryStarted.await(200, TimeUnit.MILLISECONDS)).isFalse();
        assertThat(runner.calls).hasValue(1);

        confirmations.completeGate.onComplete();
        confirmation.awaitTerminal();
        retry.awaitTerminal();

        assertThat(confirmation.error).isNull();
        assertThat(confirmation.events).startsWith(
                new RunStartedEvent("thread", "run"),
                // Every normally-completing run closes with a STATE_SNAPSHOT (Python parity).
                new RunFinishedEvent("thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(retry.error).isNull();
        assertThat(retry.events).startsWith(
                new RunStartedEvent("thread", "retry"),
                // Every normally-completing run closes with a STATE_SNAPSHOT (Python parity).
                new RunFinishedEvent("thread", "retry", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(confirmations.completeCalls).hasValue(1);
        assertThat(confirmations.releaseCalls).hasValue(0);
        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void publicFailedConfirmationRetainsSameKeyUntilDurableReleaseSettles() throws Exception {
        SessionManager sessions = mockSessionManager();
        GatedReleaseConfirmations confirmations = new GatedReleaseConfirmations(
                confirmations("invocation", "call"));
        ConfirmationThenRetryRunner runner = new ConfirmationThenRetryRunner(true);
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations,
                (sessionId, runId, outputSchemaAgentNames) ->
                        EventTranslatorFactory.INSTANCE.create(sessionId, runId, List.of(), outputSchemaAgentNames), coordinator);
        ResolvedSession session = resolvedSession("thread");
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(session));
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenReturn(Maybe.just(session));
        when(sessions.markMessagesProcessedWithFingerprints(any(), any()))
                .thenReturn(Completable.complete());

        EventCollector confirmation = subscribeEvents(
                agent.run(confirmationInput("invocation", "call", true)));
        assertThat(confirmations.releaseStarted.await(
                5, TimeUnit.SECONDS)).isTrue();

        EventCollector retry = subscribeEvents(agent.run(
                new RunAgentInput(
                        "thread",
                        "retry",
                        null,
                        List.of(new UserMessage("message", "retry")),
                        List.of(),
                        List.of(),
                        null)));
        assertThat(runner.retryStarted.await(
                200, TimeUnit.MILLISECONDS)).isFalse();
        assertThat(runner.calls).hasValue(1);

        confirmations.releaseGate.onComplete();
        confirmation.awaitTerminal();
        retry.awaitTerminal();

        assertThat(confirmation.error).isNull();
        assertThat(confirmation.events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent(
                        "confirmation failure",
                        "ADK_EXECUTION_FAILURE",
                        null,
                        null));
        assertThat(retry.error).isNull();
        assertThat(retry.events).startsWith(
                new RunStartedEvent("thread", "retry"),
                // Every normally-completing run closes with a STATE_SNAPSHOT (Python parity).
                new RunFinishedEvent("thread", "retry", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(confirmations.releaseCalls).hasValue(1);
        assertThat(confirmations.completeCalls).hasValue(0);
        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void publicCancellationBeforeConfirmationContinuationReleasesClaimDurablyWithoutInvokingRunner()
            throws Exception {
        SessionManager sessions = mockSessionManager();
        ClaimedGatedReleaseConfirmations confirmations = new ClaimedGatedReleaseConfirmations(
                confirmations("invocation", "call"));
        QueuedCancellationRunner runner = new QueuedCancellationRunner();
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        GoogleAdkAgent agent = agent(
                sessions,
                runner,
                null,
                confirmations,
                (sessionId, runId, outputSchemaAgentNames) ->
                        EventTranslatorFactory.INSTANCE.create(sessionId, runId, List.of(), outputSchemaAgentNames),
                coordinator);
        ResolvedSession session = resolvedSession("thread");
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(session));
        when(sessions.findExistingSession(
                "test-app", "test-user", "thread"))
                .thenReturn(Maybe.just(session));

        Thread ordinary = Thread.ofVirtual().start(() -> collectUnchecked(
                agent.run(new RunAgentInput(
                        "thread",
                        "ordinary",
                        null,
                        List.of(new UserMessage("message", "prompt")),
                        List.of(),
                        List.of(),
                        null))));
        assertThat(runner.ordinaryStarted.await(5, TimeUnit.SECONDS)).isTrue();

        EventCollector cancelled = subscribeEvents(
                agent.run(confirmationInput("invocation", "call", true)));
        assertThat(confirmations.claimed.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(runner.confirmationStarted.await(
                200, TimeUnit.MILLISECONDS)).isFalse();
        CountDownLatch cancellationReturned = new CountDownLatch(1);
        Thread cancellation = Thread.ofVirtual().start(() -> {
            cancelled.cancel();
            cancellationReturned.countDown();
        });

        assertThat(confirmations.releaseStarted.await(
                5, TimeUnit.SECONDS)).isTrue();
        assertThat(cancellationReturned.await(
                200, TimeUnit.MILLISECONDS)).isTrue();
        assertThat(cancelled.error).isNull();
        assertThat(cancelled.events).startsWith(
                new RunStartedEvent("thread", "run"));
        assertThat(confirmations.releaseCalls).hasValue(1);
        assertThat(confirmations.completeCalls).hasValue(0);

        runner.ordinaryFinish.onComplete();
        ordinary.join();
        assertThat(runner.confirmationStarted.await(
                200, TimeUnit.MILLISECONDS)).isFalse();
        assertThat(runner.calls).hasValue(1);

        EventCollector blockedRetry = subscribeEvents(
                agent.run(confirmationInput("invocation", "call", true)));
        blockedRetry.awaitTerminal();
        assertThat(blockedRetry.error).isNull();
        assertThat(blockedRetry.events).containsExactly(
                new RunErrorEvent(
                        "Unknown tool result",
                        "UNKNOWN_TOOL_RESULT",
                        null,
                        null));
        assertThat(runner.calls).hasValue(1);

        confirmations.releaseGate.onComplete();
        assertThat(confirmations.releaseSettled.await(
                5, TimeUnit.SECONDS)).isTrue();
        cancellation.join();

        EventCollector retry = subscribeEvents(
                agent.run(confirmationInput("invocation", "call", true)));
        retry.awaitTerminal();
        assertThat(runner.confirmationStarted.await(
                5, TimeUnit.SECONDS)).isTrue();
        assertThat(retry.error).isNull();
        assertThat(retry.events).startsWith(
                new RunStartedEvent("thread", "run"),
                // Every normally-completing run closes with a STATE_SNAPSHOT (Python parity).
                new RunFinishedEvent("thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(confirmations.claimCalls).hasValue(3);
        assertThat(confirmations.releaseCalls).hasValue(1);
        assertThat(confirmations.completeCalls).hasValue(1);
        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void publicCancellationDuringConfirmationContinuationRetainsSameKeyUntilDurableReleaseSettles()
            throws Exception {
        SessionManager sessions = mockSessionManager();
        ClaimedGatedReleaseConfirmations confirmations = new ClaimedGatedReleaseConfirmations(
                confirmations("invocation", "call"));
        StartedCancellationRunner runner = new StartedCancellationRunner();
        InProcessExecutionCoordinator coordinator = new InProcessExecutionCoordinator();
        GoogleAdkAgent agent = agent(
                sessions,
                runner,
                null,
                confirmations,
                (sessionId, runId, outputSchemaAgentNames) ->
                        EventTranslatorFactory.INSTANCE.create(sessionId, runId, List.of(), outputSchemaAgentNames),
                coordinator);
        ResolvedSession session = resolvedSession("thread");
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(session));
        when(sessions.findExistingSession(
                "test-app", "test-user", "thread"))
                .thenReturn(Maybe.just(session));
        when(sessions.markMessagesProcessedWithFingerprints(
                any(), any()))
                .thenReturn(Completable.complete());

        EventCollector cancelled = subscribeEvents(
                agent.run(confirmationInput(
                        "invocation", "call", true)));
        assertThat(runner.confirmationStarted.await(
                5, TimeUnit.SECONDS)).isTrue();
        assertThat(confirmations.claimCalls).hasValue(1);

        CountDownLatch cancellationReturned =
                new CountDownLatch(1);
        Thread cancellation = Thread.ofVirtual().start(() -> {
            cancelled.cancel();
            cancellationReturned.countDown();
        });

        assertThat(confirmations.releaseStarted.await(
                5, TimeUnit.SECONDS)).isTrue();
        assertThat(cancellationReturned.await(
                200, TimeUnit.MILLISECONDS)).isTrue();
        assertThat(cancelled.error).isNull();
        assertThat(cancelled.events).startsWith(
                new RunStartedEvent("thread", "run"));
        assertThat(confirmations.releaseCalls).hasValue(1);
        assertThat(confirmations.completeCalls).hasValue(0);

        EventCollector retry = subscribeEvents(
                agent.run(new RunAgentInput(
                        "thread",
                        "retry",
                        null,
                        List.of(new UserMessage(
                                "message", "retry")),
                        List.of(),
                        List.of(),
                        null)));
        assertThat(runner.retryStarted.await(
                200, TimeUnit.MILLISECONDS)).isFalse();
        assertThat(runner.calls).hasValue(1);

        confirmations.releaseGate.onComplete();
        assertThat(confirmations.releaseSettled.await(
                5, TimeUnit.SECONDS)).isTrue();
        cancellation.join();
        assertThat(runner.retryStarted.await(
                5, TimeUnit.SECONDS)).isTrue();
        retry.awaitTerminal();

        assertThat(retry.error).isNull();
        assertThat(retry.events).startsWith(
                new RunStartedEvent("thread", "retry"),
                // Every normally-completing run closes with a STATE_SNAPSHOT (Python parity).
                new RunFinishedEvent("thread", "retry", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(confirmations.claimCalls).hasValue(1);
        assertThat(confirmations.releaseCalls).hasValue(1);
        assertThat(confirmations.completeCalls).hasValue(0);
        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void confirmationFailuresReleaseClaimForExactRetry() throws InterruptedException {
        for (FailureMode mode : List.of(FailureMode.SYNC, FailureMode.ASYNC)) {
            SessionConfirmationRequestStore confirmations = confirmations("invocation", "call");
            FailingThenSuccessfulRunner runner = new FailingThenSuccessfulRunner(mode);
            GoogleAdkAgent agent = agent(existingSessions(), runner, null, confirmations);

            collectIgnoringError(agent.run(confirmationInput("invocation", "call", true)));
            collect(agent.run(confirmationInput("invocation", "call", true)));

            assertThat(runner.calls).hasValue(2);
        }
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void cancellingActiveConfirmationReleasesClaimForExactRetry() throws Exception {
        SessionConfirmationRequestStore confirmations = confirmations("invocation", "call");
        BlockingRunner runner = new BlockingRunner();
        GoogleAdkAgent agent = agent(existingSessions(), runner, null, confirmations);
        CancellingSubscriber first = subscribe(agent.run(confirmationInput("invocation", "call", true)));
        assertThat(runner.started.await(5, TimeUnit.SECONDS)).isTrue();
        first.cancel();
        runner.finish.onComplete();

        collect(agent.run(confirmationInput("invocation", "call", true)));

        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void cancellationReturnsBeforeConfirmationReleaseSettlesAndRetryWaitsForOwnership() throws Exception {
        SessionConfirmationRequestStore delegate = confirmations("invocation", "call");
        BlockingReleaseConfirmations confirmations = new BlockingReleaseConfirmations(delegate);
        BlockingRunner runner = new BlockingRunner();
        GoogleAdkAgent agent = agent(existingSessions(), runner, null, confirmations);
        CancellingSubscriber first = subscribe(agent.run(confirmationInput("invocation", "call", true)));
        assertThat(runner.started.await(5, TimeUnit.SECONDS)).isTrue();

        CountDownLatch returned = new CountDownLatch(1);
        Thread cancellation = Thread.ofVirtual().start(() -> {
            first.cancel();
            returned.countDown();
        });
        assertThat(confirmations.releaseStarted.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(returned.await(100, TimeUnit.MILLISECONDS)).isTrue();
        assertThat(delegate.claim(new ConfirmationRequest(
                new PendingCallScope("test-app", "test-user", "thread"), "invocation", "call")).blockingGet()).isFalse();

        List<Event> blockedRetry = collect(agent.run(confirmationInput("invocation", "call", true)));
        assertThat(blockedRetry).containsExactly(new RunErrorEvent("Unknown tool result", "UNKNOWN_TOOL_RESULT", null, null));
        assertThat(runner.calls).hasValue(1);

        confirmations.releaseGate.onComplete();
        cancellation.join();
        runner.finish.onComplete();
        collect(agent.run(confirmationInput("invocation", "call", true)));

        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void synchronousConfirmationCompleteFactoryFailureReleasesClaimForExactRetry() throws InterruptedException {
        ThrowingCompleteConfirmations confirmations = new ThrowingCompleteConfirmations(confirmations("invocation", "call"));
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = agent(existingSessions(), runner, null, confirmations);

        collectIgnoringError(agent.run(confirmationInput("invocation", "call", true)));
        collect(agent.run(confirmationInput("invocation", "call", true)));

        assertThat(confirmations.releaseCalls).hasValue(1);
        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void synchronousConfirmationReleaseFactoryFailureRetriesOnceForExactRetry() throws InterruptedException {
        ThrowingReleaseOnceConfirmations confirmations = new ThrowingReleaseOnceConfirmations(confirmations("invocation", "call"));
        FailingThenSuccessfulRunner runner = new FailingThenSuccessfulRunner(FailureMode.SYNC);
        GoogleAdkAgent agent = agent(existingSessions(), runner, null, confirmations);

        collectIgnoringError(agent.run(confirmationInput("invocation", "call", true)));
        collect(agent.run(confirmationInput("invocation", "call", true)));

        assertThat(confirmations.releaseCalls).hasValue(2);
        assertThat(runner.calls).hasValue(2);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void publicCompletedConfirmationRejectsDuplicateWithoutLifecycleAllocationOrRunner()
            throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = agent(
                sessions,
                runner,
                null,
                confirmations("invocation", "call"));
        when(sessions.findExistingSession(
                "test-app", "test-user", "thread"))
                .thenReturn(Maybe.just(resolvedSession("thread")));

        EventCollector completed = subscribeEvents(
                agent.run(confirmationInput(
                        "invocation", "call", true)));
        completed.awaitTerminal();
        EventCollector duplicate = subscribeEvents(
                agent.run(confirmationInput(
                        "invocation", "call", true)));
        duplicate.awaitTerminal();

        assertThat(completed.error).isNull();
        assertThat(completed.events).startsWith(
                new RunStartedEvent("thread", "run"),
                // Every normally-completing run closes with a STATE_SNAPSHOT (Python parity).
                new RunFinishedEvent("thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(duplicate.error).isNull();
        assertThat(duplicate.events).containsExactly(
                new RunErrorEvent(
                        "Unknown tool result",
                        "UNKNOWN_TOOL_RESULT",
                        null,
                        null));
        assertThat(runner.calls).hasValue(1);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void mismatchedOrUnknownConfirmationDoesNotReachRunner() throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations("invocation", "expected-call"));
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession("thread")));

        List<Event> mismatched = collect(agent.run(confirmationInput("invocation", "other-call", true)));
        List<Event> unknown = collect(agent.run(confirmationInput("unknown", "expected-call", true)));

        assertThat(mismatched).anySatisfy(event -> assertThat(event)
                .isEqualTo(new RunErrorEvent("Unknown tool result", "UNKNOWN_TOOL_RESULT", null, null)));
        assertThat(unknown).anySatisfy(event -> assertThat(event)
                .isEqualTo(new RunErrorEvent("Unknown tool result", "UNKNOWN_TOOL_RESULT", null, null)));
        assertThat(runner.calls).hasValue(0);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void confirmationFromAnotherPrincipalOrThreadDoesNotReachRunner() throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        CapturingRunner runner = new CapturingRunner();
        SessionConfirmationRequestStore confirmations = new SessionConfirmationRequestStore();
        confirmations.persist(new ConfirmationRequest(
                new PendingCallScope("test-app", "another-user", "other-thread"), "invocation", "call")).blockingAwait();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations);
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession("thread")));

        List<Event> events = collect(agent.run(confirmationInput("invocation", "call", true)));

        assertThat(events).anySatisfy(event -> assertThat(event)
                .isEqualTo(new RunErrorEvent("Unknown tool result", "UNKNOWN_TOOL_RESULT", null, null)));
        assertThat(runner.calls).hasValue(0);
    }

    @org.junit.jupiter.api.Disabled("Replaced by official Interrupt/Resume coverage")
    @Test
    void publicInvalidConfirmationCorrelationsCompleteWithDirectUnknownToolResultWithoutAllocationOrRunner()
            throws InterruptedException {
        for (boolean directIds : List.of(false, true)) {
            for (BoundaryCase boundaryCase : BoundaryCase.values()) {
                assertInvalidConfirmationIsReadOnly(directIds, boundaryCase);
            }
        }
    }

    private static void assertInvalidConfirmationIsReadOnly(boolean directIds, BoundaryCase boundaryCase)
            throws InterruptedException {
        String threadId = "thread";
        String sessionId = directIds ? threadId : "generated-session";
        RecordingSessionService sessionService = new RecordingSessionService();
        RecordingMappingStore mappings = new RecordingMappingStore();
        RecordingConfirmationStore confirmations = new RecordingConfirmationStore();
        SessionManager sessions = new SessionManager(sessionService, mock(BaseMemoryService.class), mappings,
                new AdkAgUiOptions(directIds));
        SessionMappingKey attackerKey = new SessionMappingKey("test-app", "test-user", threadId);
        if (boundaryCase != BoundaryCase.MISSING_SESSION) {
            seedSession(mappings, sessionService, attackerKey, sessionId, directIds);
        }
        if (boundaryCase == BoundaryCase.UNKNOWN_INVOCATION || boundaryCase == BoundaryCase.MISMATCHED_CALL) {
            confirmations.persist(new ConfirmationRequest(
                    new PendingCallScope("test-app", "test-user", sessionId), "invocation", "call")).blockingAwait();
        } else if (boundaryCase == BoundaryCase.ANOTHER_USER) {
            confirmations.persist(new ConfirmationRequest(
                    new PendingCallScope("test-app", "another-user", sessionId), "invocation", "call")).blockingAwait();
        } else if (boundaryCase == BoundaryCase.ANOTHER_THREAD) {
            String otherThread = "other-thread";
            String otherSessionId = directIds ? otherThread : "other-generated-session";
            SessionMappingKey otherKey = new SessionMappingKey("test-app", "test-user", otherThread);
            seedSession(mappings, sessionService, otherKey, otherSessionId, directIds);
            confirmations.persist(new ConfirmationRequest(
                    new PendingCallScope("test-app", "test-user", otherSessionId), "invocation", "call")).blockingAwait();
        }
        mappings.resetCounts();
        sessionService.resetCounts();
        confirmations.resetMutationCount();
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = agent(sessions, runner, null, confirmations);

        String invocationId = boundaryCase == BoundaryCase.UNKNOWN_INVOCATION ? "unknown" : "invocation";
        String toolCallId = boundaryCase == BoundaryCase.MISMATCHED_CALL ? "other-call" : "call";
        EventCollector subscriber = subscribeEvents(
                agent.run(confirmationInput(invocationId, toolCallId, true)));
        subscriber.awaitTerminal();

        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).containsExactly(
                new RunErrorEvent("Unknown tool result", "UNKNOWN_TOOL_RESULT", null, null));
        assertThat(runner.calls).hasValue(0);
        assertThat(mappings.getOrCreateCalls()).isZero();
        assertThat(mappings.mutations()).isZero();
        assertThat(sessionService.createdSessions()).isZero();
        assertThat(confirmations.mutations()).isZero();
        assertThat(confirmations.mutationsFor(new PendingCallScope("test-app", "test-user", sessionId))).isZero();
    }

    private static void seedSession(
            RecordingMappingStore mappings,
            RecordingSessionService sessionService,
            SessionMappingKey key,
            String sessionId,
            boolean directIds) {
        sessionService.seed(Session.builder(sessionId).appName(key.appName()).userId(key.userId())
                .state(new ConcurrentHashMap<>()).build());
        if (!directIds) {
            mappings.seed(new SessionMapping(key, sessionId));
        }
    }

    private enum BoundaryCase {
        UNKNOWN_INVOCATION,
        MISMATCHED_CALL,
        ANOTHER_USER,
        ANOTHER_THREAD,
        MISSING_SESSION
    }

    @Test
    void malformedActionsFailBeforeSessionOrRunner() throws InterruptedException {
        for (Map<String, ?> action : List.of(
                Map.of("kind", "unknown"),
                Map.of("kind", "confirmation", "invocationId", " ", "toolCallId", "call", "approved", true),
                Map.of("kind", "confirmation", "invocationId", "invocation", "toolCallId", " ", "approved", true),
                Map.of("kind", "confirmation", "invocationId", "invocation", "toolCallId", "call", "approved", "yes"),
                Map.of("kind", "auth", "requestId", "request", "input", List.of("not-a-map")))) {
            SessionManager sessions = mockSessionManager();
            CapturingRunner runner = new CapturingRunner();
            List<Event> events = collect(agent(sessions, runner, null).run(wireActionInput(action)));

            assertThat(events).startsWith(
                    new RunStartedEvent("thread", "run"),
                    new RunErrorEvent("Invalid run input", "INVALID_RUN_INPUT", null, null));
            verifyNoInteractions(sessions);
            assertThat(runner.contents).isEmpty();
        }
    }

    @Test
    void authWithoutAdapterReturnsExactErrorAndDoesNotTouchSessionOrRunner() throws InterruptedException {
        SessionManager sessions = mockSessionManager();
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = agent(sessions, runner, null);

        List<Event> events = collect(agent.run(authInput("request-1", Map.of("tenant", "one"))));

        assertThat(events).startsWith(
                new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Unsupported auth request", "UNSUPPORTED_AUTH_REQUEST", null, null));
        verifyNoInteractions(sessions);
        assertThat(runner.contents).isEmpty();
    }

    @Test
    void authAdapterDelegatesParallelRequestsWithoutSharedState() throws Exception {
        SessionManager sessions = mockSessionManager();
        CapturingRunner runner = new CapturingRunner();
        List<AdkAuthRequestAdapter.Request> requests = java.util.Collections.synchronizedList(new ArrayList<>());
        CountDownLatch entered = new CountDownLatch(2);
        AdkAuthRequestAdapter adapter = request -> {
            requests.add(request);
            entered.countDown();
            return Flowable.fromCallable(() -> {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                return new RunErrorEvent("AUTH_DELEGATED");
            });
        };
        GoogleAdkAgent agent = agent(sessions, runner, adapter);

        Thread first = Thread.ofVirtual().start(() -> collectUnchecked(agent.run(authInput("request-a", Map.of("tenant", "a")))));
        Thread second = Thread.ofVirtual().start(() -> collectUnchecked(agent.run(authInput("request-b", Map.of("tenant", "b")))));
        first.join();
        second.join();

        assertThat(requests).extracting(AdkAuthRequestAdapter.Request::requestId)
                .containsExactlyInAnyOrder("request-a", "request-b");
        assertThat(requests).extracting(AdkAuthRequestAdapter.Request::input)
                .containsExactlyInAnyOrder(Map.of("tenant", "a"), Map.of("tenant", "b"));
        verifyNoInteractions(sessions);
        assertThat(runner.contents).isEmpty();
    }

    private static GoogleAdkAgent agent(
            SessionManager sessions, AdkRunnerClient runner, AdkAuthRequestAdapter adapter) {
        return agent(sessions, runner, adapter, new SessionConfirmationRequestStore());
    }

    private static GoogleAdkAgent agent(
            SessionManager sessions,
            AdkRunnerClient runner,
            AdkAuthRequestAdapter adapter,
            ConfirmationRequestStore confirmations) {
        return agent(sessions, runner, adapter, confirmations, (sessionId, runId, outputSchemaAgentNames) ->
                        EventTranslatorFactory.INSTANCE.create(sessionId, runId, List.of(), outputSchemaAgentNames));
    }

    private static GoogleAdkAgent agent(
            SessionManager sessions,
            AdkRunnerClient runner,
            AdkAuthRequestAdapter adapter,
            ConfirmationRequestStore confirmations,
            com.agui.adk.translator.EventTranslatorFactoryFn eventTranslatorFactory) {
        return agent(sessions, runner, adapter, confirmations, eventTranslatorFactory, null);
    }

    private static GoogleAdkAgent agent(
            SessionManager sessions,
            AdkRunnerClient runner,
            AdkAuthRequestAdapter adapter,
            ConfirmationRequestStore confirmations,
            com.agui.adk.translator.EventTranslatorFactoryFn eventTranslatorFactory,
            InProcessExecutionCoordinator coordinator) {
        return agent(sessions, runner, adapter, confirmations, eventTranslatorFactory, coordinator,
                AdkAgUiOptions.defaults());
    }

    private static GoogleAdkAgent agent(
            SessionManager sessions,
            AdkRunnerClient runner,
            AdkAuthRequestAdapter adapter,
            ConfirmationRequestStore confirmations,
            com.agui.adk.translator.EventTranslatorFactoryFn eventTranslatorFactory,
            InProcessExecutionCoordinator coordinator,
            AdkAgUiOptions options) {
        GoogleAdkAgent.Builder builder = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .confirmationRequestStore(confirmations)
                .eventTranslatorFactory(eventTranslatorFactory)
                .options(options)
                .userIdExtractor(input -> "test-user")
                .configuredBackendToolNames(List.of());
        if (adapter != null) {
            builder.authRequestAdapter(adapter);
        }
        if (coordinator != null) {
            builder.executionCoordinator(coordinator);
        }
        GoogleAdkAgent created = builder.build();
        if (mockingDetails(sessions).isMock()) {
            clearInvocations(sessions);
        }
        return created;
    }

    private static SessionManager existingSessions() {
        SessionManager sessions = mockSessionManager();
        when(sessions.findExistingSession("test-app", "test-user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession("thread")));
        return sessions;
    }

    private static SessionConfirmationRequestStore confirmations(String... ids) {
        SessionConfirmationRequestStore confirmations = new SessionConfirmationRequestStore();
        for (int index = 0; index < ids.length; index += 2) {
            confirmations.persist(new ConfirmationRequest(
                    new PendingCallScope("test-app", "test-user", "thread"), ids[index], ids[index + 1]))
                    .blockingAwait();
        }
        return confirmations;
    }

    private static RunAgentInput confirmationInput(String invocationId, String toolCallId, boolean approved) {
        return confirmationInput("thread", invocationId, toolCallId, approved);
    }

    private static RunAgentInput confirmationInput(
            String threadId, String invocationId, String toolCallId, boolean approved) {
        return RunExtensionSupport.attach(new RunAgentInput(threadId, "run", null, List.of(), List.of(), List.of(), null),
                new AdkRunExtensions(null, List.of()));
    }

    private static RunAgentInput wireConfirmationInput(String invocationId, String toolCallId, boolean approved) {
        return wireActionInput(Map.of(
                "kind", "confirmation",
                "invocationId", invocationId,
                "toolCallId", toolCallId,
                "approved", approved));
    }

    private static RunAgentInput authInput(String requestId, Map<String, Object> input) {
        return RunExtensionSupport.attach(emptyInput(), new AdkRunExtensions(
                null, List.of(), new AdkRunExtensions.AuthAction(requestId, input)));
    }

    private static RunAgentInput wireActionInput(Map<String, ?> action) {
        Map<String, Object> copiedAction = new java.util.LinkedHashMap<>();
        action.forEach(copiedAction::put);
        return new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), Map.of(
                AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of("action", copiedAction)));
    }

    private static RunAgentInput emptyInput() {
        return new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null);
    }

    private static ResolvedSession resolvedSession(String sessionId) {
        return new ResolvedSession(Session.builder(sessionId)
                .appName("test-app")
                .userId("test-user")
                .build(), new SessionMapping(
                new SessionMappingKey("test-app", "test-user", "thread"), sessionId));
    }

    private static com.google.adk.events.Event nativeConfirmationEvent(String invocationId, String toolCallId) {
        FunctionCall original = FunctionCall.builder().id(toolCallId).name("native-tool").build();
        FunctionCall request = FunctionCall.builder()
                .id(invocationId)
                .name("adk_request_confirmation")
                .args(Map.of("originalFunctionCall", original))
                .build();
        return com.google.adk.events.Event.builder().content(Content.builder()
                .parts(List.of(Part.builder().functionCall(request).build()))
                .build()).build();
    }

    private static void assertNativeConfirmation(
            Content content, String invocationId, String toolCallId, boolean approved) {
        FunctionResponse response = content.parts().orElseThrow().getFirst().functionResponse().orElseThrow();
        assertThat(content.role()).hasValue("user");
        assertThat(response.id()).hasValue(invocationId);
        assertThat(response.name()).hasValue("adk_request_confirmation");
        assertThat(response.response()).hasValue(Map.of(
                "hint", "",
                "confirmed", approved,
                "payload", Map.of("toolCallId", toolCallId)));
    }

    private static List<Event> collect(Flow.Publisher<Event> publisher) throws InterruptedException {
        List<Event> events = new ArrayList<>();
        CountDownLatch terminal = new CountDownLatch(1);
        publisher.subscribe(new Flow.Subscriber<>() {
            @Override
            public void onSubscribe(Flow.Subscription subscription) {
                subscription.request(Long.MAX_VALUE);
            }

            @Override
            public void onNext(Event item) {
                events.add(item);
            }

            @Override
            public void onError(Throwable error) {
                throw new AssertionError(error);
            }

            @Override
            public void onComplete() {
                terminal.countDown();
            }
        });
        assertThat(terminal.await(5, TimeUnit.SECONDS)).isTrue();
        return events;
    }

    private static void collectIgnoringError(Flow.Publisher<Event> publisher) throws InterruptedException {
        CountDownLatch terminal = new CountDownLatch(1);
        publisher.subscribe(new Flow.Subscriber<>() {
            @Override public void onSubscribe(Flow.Subscription subscription) { subscription.request(Long.MAX_VALUE); }
            @Override public void onNext(Event ignored) { }
            @Override public void onError(Throwable ignored) { terminal.countDown(); }
            @Override public void onComplete() { terminal.countDown(); }
        });
        assertThat(terminal.await(5, TimeUnit.SECONDS)).isTrue();
    }

    private static void collectUnchecked(Flow.Publisher<Event> publisher) {
        try {
            collect(publisher);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new AssertionError(exception);
        }
    }

    private static CancellingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        CancellingSubscriber subscriber = new CancellingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static EventCollector subscribeEvents(Flow.Publisher<Event> publisher) {
        EventCollector subscriber = new EventCollector();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private enum FailureMode { SYNC, ASYNC }

    private static final class EventCollector implements Flow.Subscriber<Event> {
        private final List<Event> events = java.util.Collections.synchronizedList(new ArrayList<>());
        private final CountDownLatch terminal = new CountDownLatch(1);
        private Throwable error;
        private Flow.Subscription subscription;

        @Override public void onSubscribe(Flow.Subscription value) {
            subscription = value;
            value.request(Long.MAX_VALUE);
        }
        @Override public void onNext(Event event) { events.add(event); }
        @Override public void onError(Throwable failure) { error = failure; terminal.countDown(); }
        @Override public void onComplete() { terminal.countDown(); }
        private void awaitTerminal() throws InterruptedException {
            assertThat(terminal.await(5, TimeUnit.SECONDS)).isTrue();
        }
        private void cancel() { subscription.cancel(); }
    }

    private static final class CancellingSubscriber implements Flow.Subscriber<Event> {
        private Flow.Subscription subscription;

        @Override public void onSubscribe(Flow.Subscription value) {
            subscription = value;
            value.request(Long.MAX_VALUE);
        }
        @Override public void onNext(Event ignored) { }
        @Override public void onError(Throwable ignored) { }
        @Override public void onComplete() { }
        private void cancel() { subscription.cancel(); }
    }

    private static final class BlockingRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final CountDownLatch started = new CountDownLatch(1);
        private final CompletableSubject finish = CompletableSubject.create();

        @Override public String appName() { return "test-app"; }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            calls.incrementAndGet();
            started.countDown();
            return finish.andThen(Flowable.empty());
        }
    }

    private static final class OrdinalBlockingRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final CountDownLatch ordinaryStarted = new CountDownLatch(1);
        private final CountDownLatch confirmationStarted = new CountDownLatch(1);
        private final CompletableSubject ordinaryFinish = CompletableSubject.create();
        private final CompletableSubject confirmationFinish = CompletableSubject.create();

        @Override public String appName() { return "test-app"; }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            if (calls.incrementAndGet() == 1) {
                ordinaryStarted.countDown();
                return ordinaryFinish.andThen(Flowable.empty());
            }
            confirmationStarted.countDown();
            return confirmationFinish.andThen(Flowable.empty());
        }
    }

    private static final class QueuedCancellationRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final CountDownLatch ordinaryStarted = new CountDownLatch(1);
        private final CountDownLatch confirmationStarted = new CountDownLatch(1);
        private final CompletableSubject ordinaryFinish = CompletableSubject.create();

        @Override public String appName() { return "test-app"; }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            if (calls.incrementAndGet() == 1) {
                ordinaryStarted.countDown();
                return ordinaryFinish.andThen(Flowable.empty());
            }
            confirmationStarted.countDown();
            return Flowable.empty();
        }
    }

    private static final class StartedCancellationRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final CountDownLatch confirmationStarted = new CountDownLatch(1);
        private final CountDownLatch retryStarted = new CountDownLatch(1);

        @Override public String appName() { return "test-app"; }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            if (calls.incrementAndGet() == 1) {
                confirmationStarted.countDown();
                return Flowable.never();
            }
            retryStarted.countDown();
            return Flowable.empty();
        }
    }

    private static final class FailingThenSuccessfulRunner implements AdkRunnerClient {
        private final FailureMode mode;
        private final AtomicInteger calls = new AtomicInteger();

        private FailingThenSuccessfulRunner(FailureMode mode) { this.mode = mode; }
        @Override public String appName() { return "test-app"; }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            if (calls.incrementAndGet() == 1) {
                if (mode == FailureMode.SYNC) {
                    throw new IllegalStateException("sync failure");
                }
                return Flowable.error(new IllegalStateException("async failure"));
            }
            return Flowable.empty();
        }
    }

    private static final class RecordingMappingStore implements ThreadSessionMappingStore {
        private final ConcurrentMap<SessionMappingKey, SessionMapping> mappings = new ConcurrentHashMap<>();
        private final AtomicInteger getOrCreateCalls = new AtomicInteger();
        private final AtomicInteger mutations = new AtomicInteger();

        @Override
        public Single<SessionMapping> getOrCreateMapping(
                SessionMappingKey key, java.util.function.Supplier<Single<SessionMapping>> factory) {
            getOrCreateCalls.incrementAndGet();
            SessionMapping existing = mappings.get(key);
            if (existing != null) {
                return Single.just(existing);
            }
            return Single.defer(factory::get).doOnSuccess(created -> {
                mappings.put(key, created);
                mutations.incrementAndGet();
            });
        }

        @Override
        public Maybe<SessionMapping> findMapping(SessionMappingKey key) {
            return Maybe.fromCallable(() -> mappings.get(key));
        }

        @Override
        public Completable invalidate(SessionMappingKey key) {
            return Completable.fromAction(() -> {
                if (mappings.remove(key) != null) {
                    mutations.incrementAndGet();
                }
            });
        }

        @Override public boolean isDistributedAtomic() { return true; }
        private void seed(SessionMapping mapping) { mappings.put(mapping.key(), mapping); }
        private void resetCounts() { getOrCreateCalls.set(0); mutations.set(0); }
        private int getOrCreateCalls() { return getOrCreateCalls.get(); }
        private int mutations() { return mutations.get(); }
    }

    private static final class RecordingSessionService implements BaseSessionService {
        private final ConcurrentMap<String, Session> sessions = new ConcurrentHashMap<>();
        private final AtomicInteger createdSessions = new AtomicInteger();

        @Override
        public Single<Session> createSession(
                String appName, String userId, ConcurrentMap<String, Object> state, String requestedId) {
            createdSessions.incrementAndGet();
            String id = requestedId == null ? "created-" + createdSessions.get() : requestedId;
            Session session = Session.builder(id).appName(appName).userId(userId)
                    .state(state == null ? new ConcurrentHashMap<>() : state).build();
            sessions.put(key(appName, userId, id), session);
            return Single.just(session);
        }

        @Override
        public Maybe<Session> getSession(
                String appName,
                String userId,
                String sessionId,
                Optional<com.google.adk.sessions.GetSessionConfig> ignored) {
            return Maybe.fromCallable(() -> sessions.get(key(appName, userId, sessionId)));
        }

        @Override
        public Single<ListSessionsResponse> listSessions(String appName, String userId) {
            return Single.just(ListSessionsResponse.builder().sessions(sessions.values().stream()
                    .filter(session -> session.appName().equals(appName) && session.userId().equals(userId))
                    .toList()).build());
        }

        @Override public Completable deleteSession(String sessionId, String appName, String userId) {
            return Completable.fromAction(() -> sessions.remove(key(appName, userId, sessionId)));
        }
        @Override public Single<ListEventsResponse> listEvents(String appName, String userId, String sessionId) {
            return Single.just(ListEventsResponse.builder().events(List.of()).build());
        }
        @Override public Single<com.google.adk.events.Event> appendEvent(
                Session session, com.google.adk.events.Event event) {
            return Single.just(event);
        }

        private void seed(Session session) { sessions.put(key(session.appName(), session.userId(), session.id()), session); }
        private void resetCounts() { createdSessions.set(0); }
        private int createdSessions() { return createdSessions.get(); }
        private static String key(String appName, String userId, String sessionId) {
            return appName + Character.toString(0) + userId + Character.toString(0) + sessionId;
        }
    }

    private static final class RecordingConfirmationStore implements ConfirmationRequestStore {
        private final SessionConfirmationRequestStore delegate = new SessionConfirmationRequestStore();
        private final AtomicInteger mutations = new AtomicInteger();
        private final ConcurrentMap<PendingCallScope, AtomicInteger> scopedMutations = new ConcurrentHashMap<>();

        @Override
        public Completable persist(ConfirmationRequest request) {
            return delegate.persist(request).doOnComplete(() -> recordMutation(request.scope()));
        }

        @Override
        public Single<Boolean> claim(ConfirmationRequest request) {
            return delegate.claim(request).doOnSuccess(claimed -> {
                if (claimed) {
                    recordMutation(request.scope());
                }
            });
        }

        @Override
        public Completable release(ConfirmationRequest request) {
            return delegate.release(request).doOnComplete(() -> recordMutation(request.scope()));
        }

        @Override
        public Completable complete(ConfirmationRequest request) {
            return delegate.complete(request).doOnComplete(() -> recordMutation(request.scope()));
        }

        private void recordMutation(PendingCallScope scope) {
            mutations.incrementAndGet();
            scopedMutations.computeIfAbsent(scope, ignored -> new AtomicInteger()).incrementAndGet();
        }
        private void resetMutationCount() { mutations.set(0); scopedMutations.clear(); }
        private int mutations() { return mutations.get(); }
        private int mutationsFor(PendingCallScope scope) {
            AtomicInteger count = scopedMutations.get(scope);
            return count == null ? 0 : count.get();
        }
    }

    private static final class ConfirmationThenRetryRunner implements AdkRunnerClient {
        private final boolean failConfirmation;
        private final AtomicInteger calls = new AtomicInteger();
        private final CountDownLatch retryStarted = new CountDownLatch(1);

        private ConfirmationThenRetryRunner(boolean failConfirmation) { this.failConfirmation = failConfirmation; }
        @Override public String appName() { return "test-app"; }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content, RunConfig runConfig, Map<String, Object> stateDelta) {
            if (calls.incrementAndGet() == 1) {
                return failConfirmation
                        ? Flowable.error(new IllegalStateException("confirmation failure"))
                        : Flowable.empty();
            }
            retryStarted.countDown();
            return Flowable.empty();
        }
    }

    private static final class GatedCompleteConfirmations implements ConfirmationRequestStore {
        private final ConfirmationRequestStore delegate;
        private final AtomicInteger completeCalls = new AtomicInteger();
        private final AtomicInteger releaseCalls = new AtomicInteger();
        private final CountDownLatch completeStarted = new CountDownLatch(1);
        private final CompletableSubject completeGate = CompletableSubject.create();

        private GatedCompleteConfirmations(ConfirmationRequestStore delegate) { this.delegate = delegate; }
        @Override public Completable persist(ConfirmationRequest request) { return delegate.persist(request); }
        @Override public Single<Boolean> claim(ConfirmationRequest request) { return delegate.claim(request); }
        @Override public Completable release(ConfirmationRequest request) {
            return Completable.defer(() -> {
                releaseCalls.incrementAndGet();
                return delegate.release(request);
            });
        }
        @Override public Completable complete(ConfirmationRequest request) {
            return Completable.defer(() -> {
                completeCalls.incrementAndGet();
                completeStarted.countDown();
                return completeGate.andThen(delegate.complete(request));
            });
        }
    }

    private static final class GatedReleaseConfirmations implements ConfirmationRequestStore {
        private final ConfirmationRequestStore delegate;
        private final AtomicInteger completeCalls = new AtomicInteger();
        private final AtomicInteger releaseCalls = new AtomicInteger();
        private final CountDownLatch releaseStarted = new CountDownLatch(1);
        private final CompletableSubject releaseGate = CompletableSubject.create();

        private GatedReleaseConfirmations(ConfirmationRequestStore delegate) { this.delegate = delegate; }
        @Override public Completable persist(ConfirmationRequest request) { return delegate.persist(request); }
        @Override public Single<Boolean> claim(ConfirmationRequest request) { return delegate.claim(request); }
        @Override public Completable release(ConfirmationRequest request) {
            return Completable.defer(() -> {
                releaseCalls.incrementAndGet();
                releaseStarted.countDown();
                return releaseGate.andThen(delegate.release(request));
            });
        }
        @Override public Completable complete(ConfirmationRequest request) {
            return Completable.defer(() -> {
                completeCalls.incrementAndGet();
                return delegate.complete(request);
            });
        }
    }

    private static final class ClaimedGatedReleaseConfirmations implements ConfirmationRequestStore {
        private final ConfirmationRequestStore delegate;
        private final AtomicInteger claimCalls = new AtomicInteger();
        private final AtomicInteger releaseCalls = new AtomicInteger();
        private final AtomicInteger completeCalls = new AtomicInteger();
        private final CountDownLatch claimed = new CountDownLatch(1);
        private final CountDownLatch releaseStarted = new CountDownLatch(1);
        private final CountDownLatch releaseSettled = new CountDownLatch(1);
        private final CompletableSubject releaseGate = CompletableSubject.create();

        private ClaimedGatedReleaseConfirmations(ConfirmationRequestStore delegate) { this.delegate = delegate; }
        @Override public Completable persist(ConfirmationRequest request) { return delegate.persist(request); }
        @Override public Single<Boolean> claim(ConfirmationRequest request) {
            return Single.defer(() -> {
                claimCalls.incrementAndGet();
                return delegate.claim(request);
            }).doOnSuccess(value -> {
                if (value) {
                    claimed.countDown();
                }
            });
        }
        @Override public Completable release(ConfirmationRequest request) {
            return Completable.defer(() -> {
                releaseCalls.incrementAndGet();
                releaseStarted.countDown();
                return releaseGate.andThen(delegate.release(request))
                        .doOnComplete(releaseSettled::countDown);
            });
        }
        @Override public Completable complete(ConfirmationRequest request) {
            return Completable.defer(() -> {
                completeCalls.incrementAndGet();
                return delegate.complete(request);
            });
        }
    }

    private static final class BlockingReleaseConfirmations implements ConfirmationRequestStore {
        private final ConfirmationRequestStore delegate;
        private final CountDownLatch releaseStarted = new CountDownLatch(1);
        private final CompletableSubject releaseGate = CompletableSubject.create();

        private BlockingReleaseConfirmations(ConfirmationRequestStore delegate) { this.delegate = delegate; }
        @Override public Completable persist(ConfirmationRequest request) { return delegate.persist(request); }
        @Override public Single<Boolean> claim(ConfirmationRequest request) { return delegate.claim(request); }
        @Override public Completable release(ConfirmationRequest request) {
            return Completable.defer(() -> {
                releaseStarted.countDown();
                return releaseGate.andThen(delegate.release(request));
            });
        }
        @Override public Completable complete(ConfirmationRequest request) { return delegate.complete(request); }
    }

    private static final class ThrowingCompleteConfirmations implements ConfirmationRequestStore {
        private final ConfirmationRequestStore delegate;
        private final AtomicInteger completeCalls = new AtomicInteger();
        private final AtomicInteger releaseCalls = new AtomicInteger();

        private ThrowingCompleteConfirmations(ConfirmationRequestStore delegate) { this.delegate = delegate; }
        @Override public Completable persist(ConfirmationRequest request) { return delegate.persist(request); }
        @Override public Single<Boolean> claim(ConfirmationRequest request) { return delegate.claim(request); }
        @Override public Completable release(ConfirmationRequest request) {
            return delegate.release(request).doOnComplete(releaseCalls::incrementAndGet);
        }
        @Override public Completable complete(ConfirmationRequest request) {
            if (completeCalls.incrementAndGet() == 1) {
                throw new IllegalStateException("synchronous complete factory failure");
            }
            return delegate.complete(request);
        }
    }

    private static final class ThrowingReleaseOnceConfirmations implements ConfirmationRequestStore {
        private final ConfirmationRequestStore delegate;
        private final AtomicInteger releaseCalls = new AtomicInteger();

        private ThrowingReleaseOnceConfirmations(ConfirmationRequestStore delegate) { this.delegate = delegate; }
        @Override public Completable persist(ConfirmationRequest request) { return delegate.persist(request); }
        @Override public Single<Boolean> claim(ConfirmationRequest request) { return delegate.claim(request); }
        @Override public Completable release(ConfirmationRequest request) {
            if (releaseCalls.incrementAndGet() == 1) {
                throw new IllegalStateException("synchronous release factory failure");
            }
            return delegate.release(request);
        }
        @Override public Completable complete(ConfirmationRequest request) { return delegate.complete(request); }
    }

    private static final class CapturingRunner implements AdkRunnerClient {
        private final AtomicInteger calls = new AtomicInteger();
        private final List<Content> contents = java.util.Collections.synchronizedList(new ArrayList<>());
        private final List<com.google.adk.events.Event> events = java.util.Collections.synchronizedList(new ArrayList<>());

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
            calls.incrementAndGet();
            contents.add(content);
            List<com.google.adk.events.Event> emitted = List.copyOf(events);
            events.clear();
            return Flowable.fromIterable(emitted);
        }
    }
}
