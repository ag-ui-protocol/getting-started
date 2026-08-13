package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.message.MessageReservation;
import com.agui.adk.message.MessageReservationStore;
import com.agui.adk.processor.ToolResult;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.CustomEvent;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import com.agui.community.core.interrupt.SuccessOutcome;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class GoogleAdkAgentBaselineTest {

    private static final String TEST_USER_ID = "test-user";

    @Mock
    private SessionManager sessionManager;

    private FakeAdkRunnerClient fakeRunner;
    private GoogleAdkAgent agent;

    @BeforeEach
    void setUp() {
        fakeRunner = new FakeAdkRunnerClient();
        agent = createAgent(input -> TEST_USER_ID);
    }

    @Test
    void implementsOfficialAgentAndCompletesSuccessfulRun() throws InterruptedException {
        UserMessage userMessage = createUserMessage("1");
        RunAgentInput input = createAgentInput(userMessage);
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());

        Agent officialAgent = agent;
        RecordingSubscriber subscriber = subscribe(officialAgent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events()).anyMatch(RunStartedEvent.class::isInstance);
        assertThat(subscriber.events()).anyMatch(RunFinishedEvent.class::isInstance);
        assertThat(fakeRunner.lastUserId()).isEqualTo(TEST_USER_ID);
        assertThat(fakeRunner.lastSessionId()).isEqualTo(input.threadId());
        assertThat(fakeRunner.lastContent()).isNotNull();
    }

    @Test
    void officialResumeIsRejectedBeforeLegacyMessageAndSessionRouting() throws InterruptedException {
        RunAgentInput input = new RunAgentInput(
                "thread-1",
                "run-resume",
                Map.of(),
                List.of(new com.agui.community.core.message.ToolMessage(
                        "message-1", "legacy", "tool-call")),
                List.of(),
                List.of(),
                Map.of(),
                List.of(new Resume("interrupt-1", ResumeStatus.RESOLVED, Map.of("approved", true))));

        Flow.Publisher<Event> publisher = agent.run(input);
        assertThat(fakeRunner.runCount()).isZero();
        verifyNoInteractions(sessionManager);

        RecordingSubscriber subscriber = subscribe(publisher);

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).anySatisfy(event -> {
            assertThat(event).isInstanceOf(RunErrorEvent.class);
            assertThat(((RunErrorEvent) event).code()).isEqualTo("INVALID_RESUME");
        });
        assertThat(fakeRunner.runCount()).isZero();
        verifyNoInteractions(sessionManager);
    }

    @Test
    void invalidStateIsRejectedBeforeSessionMutation() throws InterruptedException {
        RunAgentInput input = new RunAgentInput(
                "thread-1", "run-invalid-state", List.of("not", "an", "object"),
                List.of(createUserMessage("invalid-state")), List.of(), List.of(), Map.of());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).anySatisfy(event -> {
            assertThat(event).isInstanceOf(RunErrorEvent.class);
            assertThat(((RunErrorEvent) event).code()).isEqualTo("INVALID_RUN_INPUT");
        });
        assertThat(fakeRunner.runCount()).isZero();
        verifyNoInteractions(sessionManager);
    }

    @Test
    void requestStateAddsDefaultsWithoutOverwritingTheResolvedSession() throws InterruptedException {
        RunAgentInput input = new RunAgentInput(
                "thread-1", "run-state", Map.of("client", "default", "server", "ignored"),
                List.of(createUserMessage("state")), List.of(), List.of(), Map.of());
        ResolvedSession resolved = resolvedSession(input, Set.of());
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolved));
        stubNoOpMutationGuard();
        when(sessionManager.initializeSessionState(
                resolved.session(), Map.of("client", "default", "server", "ignored"), false))
                .thenReturn(Completable.complete());
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        verify(sessionManager).initializeSessionState(
                resolved.session(), Map.of("client", "default", "server", "ignored"), false);
        assertThat(fakeRunner.runCount()).isOne();
    }

    @Test
    void eachSubscriptionToTheOfficialColdPublisherReentersTheRunWhileMessageIdempotencePreventsReplay()
            throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("cold"));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());
        Flow.Publisher<Event> publisher = agent.run(input);

        assertThat(fakeRunner.runCount()).isZero();
        RecordingSubscriber first = subscribe(publisher);
        RecordingSubscriber second = subscribe(publisher);

        assertThat(first.await()).isTrue();
        assertThat(second.await()).isTrue();
        verify(sessionManager, times(2)).resolveSession(any(AdkAgUiRunContext.class));
        assertThat(fakeRunner.runCount()).isOne();
    }

    @Test
    void persistsAcceptedMessagesOnlyAfterTheRunnerCompletes() throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        AtomicBoolean runnerCompletedBeforePersistence = new AtomicBoolean();
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.fromAction(() ->
                        runnerCompletedBeforePersistence.set(fakeRunner.runCount() == 1)));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(runnerCompletedBeforePersistence).isTrue();
    }

    @Test
    void runnerFailureRollsBackReservationSoTheSameMessageCanRetry() throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());
        fakeRunner.failWith(new IllegalStateException("runner failed"));

        RecordingSubscriber failed = subscribe(agent.run(input));

        assertThat(failed.await()).isTrue();
        assertThat(failed.events()).anyMatch(RunErrorEvent.class::isInstance);
        fakeRunner.clearFailure();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());

        RecordingSubscriber retried = subscribe(agent.run(input));

        assertThat(retried.await()).isTrue();
        assertThat(retried.events()).noneMatch(RunErrorEvent.class::isInstance);
        assertThat(fakeRunner.runCount()).isEqualTo(2);
    }

    @Test
    void resumableRunnerFailureUsesBackgroundExecutionErrorCode() throws InterruptedException {
        agent = GoogleAdkAgent.builder().runner(fakeRunner).sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build()).configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> TEST_USER_ID).eventEncoder(event -> new EncodedEvent(event, "{}"))
                .adkResumable(true).build();
        RunAgentInput input = createAgentInput(createUserMessage("background-failure"));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        fakeRunner.failWith(new IllegalStateException("background runner failed"));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).anySatisfy(event -> {
            assertThat(event).isInstanceOf(RunErrorEvent.class);
            assertThat(((RunErrorEvent) event).code()).isEqualTo("BACKGROUND_EXECUTION_ERROR");
            assertThat(((RunErrorEvent) event).message()).isEqualTo("background runner failed");
        });
        assertThat(subscriber.events()).anySatisfy(event -> {
            assertThat(event).isInstanceOf(RunFinishedEvent.class);
            assertThat(((RunFinishedEvent) event).outcome()).isEqualTo(new SuccessOutcome());
        });
    }

    @Test
    void cancellationDuringDurableAppendKeepsReservationAndLeaseUntilCommitSettles() throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        CompletableSubject append = CompletableSubject.create();
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(append);

        RecordingSubscriber first = subscribe(agent.run(input));
        assertThat(fakeRunner.runCount()).isOne();
        assertThat(append.hasObservers()).isTrue();

        first.cancel();
        RecordingSubscriber retry = subscribe(agent.run(input));

        assertThat(fakeRunner.runCount()).isOne();
        append.onComplete();
        assertThat(retry.await()).isTrue();
        assertThat(fakeRunner.runCount()).isOne();

        RecordingSubscriber afterCommit = subscribe(agent.run(input));
        assertThat(afterCommit.await()).isTrue();
        assertThat(fakeRunner.runCount()).isOne();
    }

    @Test
    void appendFailureAfterCancellationRollsBackBeforeRetryEntersRunner() throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        CompletableSubject append = CompletableSubject.create();
        CompletableSubject rollback = CompletableSubject.create();
        ControllableReservationStore reservations = new ControllableReservationStore(rollback);
        agent = createAgent(ignored -> TEST_USER_ID, RunConfig.builder().build(), reservations);
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(append, Completable.complete());

        RecordingSubscriber first = subscribe(agent.run(input));
        assertThat(fakeRunner.runCount()).isOne();
        first.cancel();
        append.onError(new IllegalStateException("append failed"));
        RecordingSubscriber retry = subscribe(agent.run(input));

        assertThat(fakeRunner.runCount()).isOne();
        rollback.onComplete();
        assertThat(retry.await()).isTrue();
        assertThat(fakeRunner.runCount()).isEqualTo(2);
    }

    @Test
    void cancellationReturnsPromptlyWhileRollbackIsPending() throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        CompletableSubject rollback = CompletableSubject.create();
        ControllableReservationStore reservations = new ControllableReservationStore(rollback);
        agent = createAgent(ignored -> TEST_USER_ID, RunConfig.builder().build(), reservations);
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());
        fakeRunner.neverComplete();

        RecordingSubscriber cancelled = subscribe(agent.run(input));
        assertThat(fakeRunner.awaitFirstRun()).isTrue();
        assertThat(fakeRunner.runCount()).isOne();
        long startedAt = System.nanoTime();
        cancelled.cancel();
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt);
        RecordingSubscriber retry = subscribe(agent.run(input));

        assertThat(elapsedMillis).isLessThan(100L);
        assertThat(fakeRunner.runCount()).isOne();
        fakeRunner.completeNormally();
        rollback.onComplete();
        assertThat(retry.await()).isTrue();
        assertThat(fakeRunner.runCount()).isEqualTo(2);
    }

    @Test
    void downstreamCancellationRollsBackReservationSoTheSameMessageCanRetry() throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());
        fakeRunner.neverComplete();

        RecordingSubscriber cancelled = subscribe(agent.run(input));

        assertThat(fakeRunner.runCount()).isOne();
        cancelled.cancel();
        fakeRunner.completeNormally();

        RecordingSubscriber retried = subscribe(agent.run(input));

        assertThat(retried.await()).isTrue();
        assertThat(fakeRunner.runCount()).isEqualTo(2);
    }

    @Test
    void emitsErrorEventWhenSessionManagerFails() throws InterruptedException {
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.error(new RuntimeException("Session service down")));

        RecordingSubscriber subscriber = subscribe(agent.run(createAgentInput(createUserMessage("1"))));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events()).hasSize(3);
        assertThat(subscriber.events().get(0)).isInstanceOf(RunStartedEvent.class);
        assertThat(subscriber.events().get(1)).isInstanceOf(RunErrorEvent.class);
        assertThat(subscriber.events().get(2)).isInstanceOf(RunFinishedEvent.class);
    }

    @Test
    void emitsStableRunErrorWhenSessionFailureHasNullMessage() throws InterruptedException {
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.error(new RuntimeException()));

        RecordingSubscriber subscriber = subscribe(agent.run(createAgentInput(createUserMessage("1"))));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events().stream().filter(RunErrorEvent.class::isInstance))
                .singleElement()
                .extracting(RunErrorEvent.class::cast)
                .extracting(RunErrorEvent::message)
                .isEqualTo("Google ADK run failed");
    }

    @Test
    void emitsStableRunErrorWhenRunnerFailureHasNullMessage() throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        fakeRunner.failWith(new RuntimeException());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events().stream().filter(RunErrorEvent.class::isInstance))
                .singleElement()
                .extracting(RunErrorEvent.class::cast)
                .extracting(RunErrorEvent::message)
                .isEqualTo("Google ADK run failed");
    }

    @Test
    void emitsNoSessionSnapshotWithoutStateOrUnseenMessages() throws InterruptedException {
        String messageId = "msg-already-processed";
        RunAgentInput input = createAgentInput(createUserMessage(messageId));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of(messageId))));
        stubNoOpMutationGuard();

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).hasSize(2);
        assertThat(subscriber.events().get(0)).isInstanceOf(RunStartedEvent.class);
        assertThat(subscriber.events().get(1)).isInstanceOf(RunFinishedEvent.class);
        assertThat(fakeRunner.runCount()).isZero();
    }



    @Test
    void publicRunAcquiresOneFreshLeaseForEachExecutableChunkAndRunsSequentially()
            throws InterruptedException {
        UserMessage first = new UserMessage("user-1", "first");
        ToolCall call = new ToolCall("call-1",
                new com.agui.community.core.message.FunctionCall("backend", "{}"));
        AssistantMessage assistant = new AssistantMessage("assistant-call", null, null, List.of(call));
        ToolMessage result = new ToolMessage("tool-result", "{\"ok\":true}", "call-1");
        UserMessage second = new UserMessage("user-2", "after tool");
        RunAgentInput input = createAgentInput(List.of(first, assistant, result, second), List.of(), Map.of());
        ResolvedSession resolved = resolvedSession(input, Set.of());
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolved));
        when(sessionManager.getProcessedMessageIds(resolved.session())).thenReturn(Single.just(Set.of()));
        when(sessionManager.processToolResults(any(), anyList(), any()))
                .thenReturn(Flowable.just(new ToolResult("backend", result)));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).noneMatch(RunErrorEvent.class::isInstance);
        assertThat(fakeRunner.runCount()).isEqualTo(2);
    }

    @Test
    void toolResultProcessingFailureRaisesToolResultProcessingError() throws InterruptedException {
        ToolCall call = new ToolCall("call-1",
                new com.agui.community.core.message.FunctionCall("backend", "{}"));
        AssistantMessage assistant = new AssistantMessage("assistant-call", null, null, List.of(call));
        ToolMessage result = new ToolMessage("tool-result", "{\"ok\":true}", "call-1");
        RunAgentInput input = createAgentInput(List.of(assistant, result), List.of(), Map.of());
        ResolvedSession resolved = resolvedSession(input, Set.of());
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolved));
        when(sessionManager.getProcessedMessageIds(resolved.session())).thenReturn(Single.just(Set.of()));
        when(sessionManager.processToolResults(any(), anyList(), any()))
                .thenReturn(Flowable.error(new IllegalStateException("tool result store unavailable")));
        stubNoOpMutationGuard();

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        // Python classifies a failure while handling a tool-result submission as
        // TOOL_RESULT_PROCESSING_ERROR, not as a generic persistence failure (parity F-05).
        assertThat(subscriber.events()).contains(new RunErrorEvent(
                "Failed to process tool results", "TOOL_RESULT_PROCESSING_ERROR", null, null));
    }

    @Test
    void publicRunFiltersProcessedLeadingAndIntermediateIdsBeforeChunking() throws InterruptedException {
        UserMessage leading = new UserMessage("processed-leading", "old leading");
        UserMessage unseen = new UserMessage("unseen", "expected unseen");
        UserMessage intermediate = new UserMessage("processed-intermediate", "stale intermediate");
        RunAgentInput input = createAgentInput(List.of(leading, unseen, intermediate), List.of(), Map.of());
        ResolvedSession resolved = resolvedSession(input, Set.of(leading.id(), intermediate.id()));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolved));
        when(sessionManager.getProcessedMessageIds(resolved.session()))
                .thenReturn(Single.just(Set.of(leading.id(), intermediate.id())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).noneMatch(RunErrorEvent.class::isInstance);
        assertThat(fakeRunner.runCount()).isEqualTo(1);
        assertThat(fakeRunner.lastContent().parts().orElseThrow())
                .extracting(part -> part.text().orElse(""))
                .containsExactly("expected unseen");
    }

    @Test
    void emitsRunErrorWhenUserIdExtractorReturnsBlank() throws InterruptedException {
        agent = createAgent(input -> "   ");

        RecordingSubscriber subscriber = subscribe(agent.run(createAgentInput(createUserMessage("1"))));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).startsWith(
                new RunStartedEvent("thread-1", "run-1"),
                new RunErrorEvent("Invalid run input", "INVALID_RUN_INPUT", null, null));
        verifyNoInteractions(sessionManager);
    }

    @Test
    void emitsRunErrorWhenUserIdExtractorReturnsNull() throws InterruptedException {
        agent = createAgent(input -> null);

        RecordingSubscriber subscriber = subscribe(agent.run(createAgentInput(createUserMessage("1"))));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).startsWith(
                new RunStartedEvent("thread-1", "run-1"),
                new RunErrorEvent("Invalid run input", "INVALID_RUN_INPUT", null, null));
        verifyNoInteractions(sessionManager);
    }

    @Test
    void emitsRunErrorWhenUserIdExtractorThrows() throws InterruptedException {
        agent = createAgent(input -> {
            throw new IllegalStateException("auth failed");
        });

        RecordingSubscriber subscriber = subscribe(agent.run(createAgentInput(createUserMessage("1"))));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).startsWith(
                new RunStartedEvent("thread-1", "run-1"),
                new RunErrorEvent("Invalid run input", "INVALID_RUN_INPUT", null, null));
        verifyNoInteractions(sessionManager);
    }

    @Test
    void resolvesUserIdOnlyWhenPublisherIsSubscribed() {
        AtomicBoolean extracted = new AtomicBoolean();
        agent = createAgent(input -> {
            extracted.set(true);
            return TEST_USER_ID;
        });
        Flow.Publisher<Event> publisher = agent.run(createAgentInput(createUserMessage("1")));

        assertThat(extracted).isFalse();

        publisher.subscribe(new CancellingSubscriber());
        assertThat(extracted).isTrue();
    }

    @Test
    void builderRejectsMissingUserIdExtractor() {
        assertThatThrownBy(() -> GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .build())
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("userIdExtractor must be configured");
    }

    @Test
    void publicRunRoutesStaticAndExtractedAppNamesWithPythonPrecedence() throws InterruptedException {
        agent = GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userId("static-user")
                .appNameExtractor(input -> "tenant-app-" + input.threadId())
                .eventEncoder(event -> new EncodedEvent(event, "{}"))
                .build();
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.error(new IllegalStateException("stop after identity capture")));

        RecordingSubscriber subscriber = subscribe(agent.run(createAgentInput(createUserMessage("1"))));

        assertThat(subscriber.await()).isTrue();
        org.mockito.ArgumentCaptor<AdkAgUiRunContext> context =
                org.mockito.ArgumentCaptor.forClass(AdkAgUiRunContext.class);
        org.mockito.Mockito.verify(sessionManager).resolveSession(context.capture());
        assertThat(context.getValue().userId()).isEqualTo("static-user");
        assertThat(context.getValue().appName()).isEqualTo("tenant-app-thread-1");
    }

    @Test
    void publicRunPrefersStaticAppNameAndFallsBackToRunnerAppName() throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.error(new IllegalStateException("stop after identity capture")));
        agent = GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> TEST_USER_ID)
                .appName("static-app")
                .eventEncoder(event -> new EncodedEvent(event, "{}"))
                .build();

        assertThat(subscribe(agent.run(input)).await()).isTrue();
        org.mockito.ArgumentCaptor<AdkAgUiRunContext> contexts =
                org.mockito.ArgumentCaptor.forClass(AdkAgUiRunContext.class);
        org.mockito.Mockito.verify(sessionManager).resolveSession(contexts.capture());
        assertThat(contexts.getValue().appName()).isEqualTo("static-app");

        clearInvocations(sessionManager);
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.error(new IllegalStateException("stop after identity capture")));
        agent = createAgent(ignored -> TEST_USER_ID);

        assertThat(subscribe(agent.run(input)).await()).isTrue();
        org.mockito.Mockito.verify(sessionManager).resolveSession(contexts.capture());
        assertThat(contexts.getValue().appName()).isEqualTo("test-app");
    }

    @Test
    void publicRunRejectsBlankOrFailingAppNameExtractorBeforeSessionResolution()
            throws InterruptedException {
        for (Function<RunAgentInput, String> extractor : List.<Function<RunAgentInput, String>>of(
                ignored -> "   ",
                ignored -> {
                    throw new IllegalStateException("routing failed");
                })) {
            agent = GoogleAdkAgent.builder()
                    .runner(fakeRunner)
                    .sessionManager(sessionManager)
                    .baseRunConfig(RunConfig.builder().build())
                    .configuredBackendToolNames(Set.of())
                    .userIdExtractor(ignored -> TEST_USER_ID)
                    .appNameExtractor(extractor)
                    .eventEncoder(event -> new EncodedEvent(event, "{}"))
                    .build();
            clearInvocations(sessionManager);

            RecordingSubscriber subscriber = subscribe(
                    agent.run(createAgentInput(createUserMessage("1"))));

            assertThat(subscriber.await()).isTrue();
            assertThat(subscriber.events()).startsWith(
                    new RunStartedEvent("thread-1", "run-1"),
                    new RunErrorEvent("Invalid run input", "INVALID_RUN_INPUT", null, null));
            verifyNoInteractions(sessionManager);
        }
    }

    @Test
    void builderRejectsConflictingStaticAndExtractedIdentities() {
        assertThatThrownBy(() -> GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .configuredBackendToolNames(Set.of())
                .userId("static-user")
                .userIdExtractor(ignored -> TEST_USER_ID)
                .build())
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Cannot specify both userId and userIdExtractor");
        assertThatThrownBy(() -> GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> TEST_USER_ID)
                .appName("static-app")
                .appNameExtractor(ignored -> "extracted-app")
                .build())
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Cannot specify both appName and appNameExtractor");
    }

    @Test
    void publicRunSurfacesToolArgumentSerializationFailureAsTerminalError()
            throws InterruptedException {
        Map<String, Object> unsupported = Map.of("value", new Object());
        fakeRunner.emit(com.google.adk.events.Event.builder().author("model")
                .content(Content.builder().role("model").parts(
                        com.google.genai.types.Part.builder().functionCall(
                                com.google.genai.types.FunctionCall.builder()
                                        .id("provider-1").name("weather")
                                        .args(unsupported).build()).build()).build())
                .build());
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).anySatisfy(event -> {
            assertThat(event).isInstanceOf(RunErrorEvent.class);
            assertThat(((RunErrorEvent) event).code()).isEqualTo("EXECUTION_ERROR");
        });
    }

    @Test
    void publicRunEmitsCaseExactPredictStateCustomEvent() throws InterruptedException {
        fakeRunner.emit(com.google.adk.events.Event.builder().author("model")
                .content(Content.builder().role("model").parts(
                        com.google.genai.types.Part.builder().functionCall(
                                com.google.genai.types.FunctionCall.builder()
                                        .id("provider-1").name("weather")
                                        .args(Map.of()).build()).build()).build())
                .build());
        agent = GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .configuredBackendToolNames(Set.of("weather"))
                .userIdExtractor(ignored -> TEST_USER_ID)
                .eventEncoder(event -> new EncodedEvent(event, "{}"))
                .eventTranslatorFactory((thread, run, outputSchemaAgentNames) -> com.agui.adk.translator.EventTranslatorFactory.INSTANCE.create(
                        thread, run, List.of(new com.agui.adk.translator.PredictStateMapping(
                                "weather", false, Map.of("status", "loading")))))
                .build();
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events()).filteredOn(CustomEvent.class::isInstance)
                .singleElement()
                .extracting(CustomEvent.class::cast)
                .extracting(CustomEvent::name)
                .isEqualTo("PredictState");
    }

    @Test
    void builderRejectsMissingAuthoritativeBackendToolNames() {
        assertThatThrownBy(() -> GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build())
                .userIdExtractor(input -> TEST_USER_ID)
                .build())
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("configuredBackendToolNames must be configured");
    }

    @Test
    void exposesRequestDefinedFrontendToolToAdk() throws InterruptedException {
        Tool tool = new Tool(
                "show_sports_list", "Shows the available sports", new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = createAgentInput(
                List.of(createUserMessage("1")),
                List.of(tool),
                Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of("rawToolSchemas", List.of(Map.of(
                        "position", 0,
                        "name", "show_sports_list",
                        "schema", Map.of("type", "object"))))));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events()).noneMatch(RunErrorEvent.class::isInstance);
        assertThat(fakeRunner.visibleToolNames()).containsExactly("show_sports_list");
        assertThat(fakeRunner.runCount()).isOne();
    }

    @Test
    void rejectsFrontendBackendToolNameCollisionBeforeTheLiveAdkInvocation() throws InterruptedException {
        agent = createAgent(
                input -> TEST_USER_ID, RunConfig.builder().build(), Set.of("show_sports_list"));
        Tool tool = new Tool(
                "show_sports_list",
                "Shows the available sports",
                new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = createAgentInput(
                List.of(createUserMessage("1")),
                List.of(tool),
                Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of("rawToolSchemas", List.of(Map.of(
                        "position", 0,
                        "name", "show_sports_list",
                        "schema", Map.of("type", "object"))))));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events()).startsWith(
                new RunStartedEvent("thread-1", "run-1"),
                new RunErrorEvent("Duplicate tool name", "DUPLICATE_TOOL_NAME", null, null));
        assertThat(fakeRunner.runCount()).isZero();
        verifyNoInteractions(sessionManager);
    }

    @Test
    void passesRequestSpecificContextToTheLiveAdkInvocation() throws InterruptedException {
        RunConfig baseConfig = RunConfig.builder()
                .customMetadata(Map.of("existingPluginKey", "value"))
                .build();
        agent = createAgent(input -> TEST_USER_ID, baseConfig);
        Tool tool = new Tool(
                "show_sports_list",
                "Shows the available sports",
                new ToolParameters(Map.of(), List.of()));
        Map<String, Object> wireExtensions = Map.of(
                "parentRunId", "parent-1",
                "rawToolSchemas", List.of(Map.of(
                        "position", 0,
                        "name", "show_sports_list",
                        "schema", Map.of("type", "object"))));
        RunAgentInput input = createAgentInput(
                List.of(createUserMessage("1")),
                List.of(tool),
                Map.of(
                        "tenant", "example",
                        AdkRunExtensions.FORWARDED_PROPS_KEY, wireExtensions));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(fakeRunner.runCount()).isOne();
        assertThat(fakeRunner.lastRunConfig()).isNotSameAs(baseConfig);
        assertThat(fakeRunner.lastRunConfig().customMetadata())
                .containsEntry("existingPluginKey", "value")
                .containsKey(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY);
        AdkAgUiRunContext context = AdkAgUiRunContext.from(fakeRunner.lastRunConfig()).orElseThrow();
        assertThat(context.parentRunId()).isEqualTo("parent-1");
        assertThat(context.input().forwardedProps()).isEqualTo(Map.of("tenant", "example"));
        assertThat(context.rawToolSchemas()).singleElement().satisfies(schema -> {
            assertThat(schema.position()).isZero();
            assertThat(schema.name()).isEqualTo("show_sports_list");
            assertThat(schema.schema().get("type").asText()).isEqualTo("object");
        });
        assertThat(baseConfig.customMetadata())
                .containsEntry("existingPluginKey", "value")
                .doesNotContainKey(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY);
        assertThat(fakeRunner.lastStateDelta()).isEmpty();
    }

    @Test
    void rejectsFrontendToolsWithoutEncoderBeforeSessionOrAdkInvocation() throws InterruptedException {
        agent = createAgentWithoutEncoder(input -> TEST_USER_ID);
        Tool frontendTool = new Tool(
                "request_location",
                "Requests the browser location",
                new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = createAgentInput(
                List.of(createUserMessage("1")),
                List.of(frontendTool),
                Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of(
                        "rawToolSchemas", List.of(Map.of(
                                "position", 0,
                                "name", "request_location",
                                "schema", Map.of("type", "object"))))));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events()).startsWith(
                new RunStartedEvent("thread-1", "run-1"),
                new RunErrorEvent("Event encoding failed", "ENCODING_ERROR", null, null));
        assertThat(fakeRunner.runCount()).isZero();
        verifyNoInteractions(sessionManager);
    }

    @Test
    void rejectsBlankRunIdBeforeTheLiveAdkInvocation() throws InterruptedException {
        RunAgentInput input = new RunAgentInput(
                "thread-1",
                " ",
                Map.of(),
                List.of(createUserMessage("1")),
                List.of(),
                List.of(),
                Map.of());
        assertInvalidRunBeforeAdk(input, "runId");
    }

    @Test
    void rejectsConflictingMessageIdsBeforeTheLiveAdkInvocation() throws InterruptedException {
        RunAgentInput input = createAgentInput(
                List.of(
                        new UserMessage("message-1", "first"),
                        new UserMessage("message-1", "second")),
                List.of(),
                Map.of());
        assertInvalidRunBeforeAdk(input, "duplicate message id");
    }

    @Test
    void rejectsMalformedWireExtensionsBeforeTheLiveAdkInvocation() throws InterruptedException {
        RunAgentInput input = createAgentInput(
                List.of(createUserMessage("1")),
                List.of(),
                Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY, "malformed"));
        assertInvalidRunBeforeAdk(input, AdkRunExtensions.FORWARDED_PROPS_KEY);
    }

    @Test
    void rejectsReservedRunConfigMetadataBeforeTheLiveAdkInvocation() throws InterruptedException {
        RunConfig baseConfig = RunConfig.builder()
                .customMetadata(Map.of(
                        AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY,
                        "caller-value"))
                .build();
        agent = createAgent(input -> TEST_USER_ID, baseConfig);
        RunAgentInput input = createAgentInput(createUserMessage("1"));
        assertInvalidRunBeforeAdk(input, AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY);
    }

    private void stubNoOpMutationGuard() {
        when(sessionManager.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
    }

    @Test
    void routesPartialLroThroughTextFirstDrainCapturesRemapAndHardStopsReprise() throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("lro-run"));
        com.google.adk.sessions.Session session = Session.builder(input.threadId())
                .appName("test-app").userId(TEST_USER_ID).state(Map.of()).build();
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(new ResolvedSession(
                session, new SessionMapping(new SessionMappingKey("test-app", TEST_USER_ID, input.threadId()),
                input.threadId()))));
        when(sessionManager.getAuthoritativeSession("test-app", TEST_USER_ID, input.threadId()))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(session));
        when(sessionManager.updateSessionState(any(), org.mockito.ArgumentMatchers.argThat(state ->
                state.containsKey("pendingToolCallIds")))).thenReturn(Completable.complete());
        when(sessionManager.setStateValue(any(), org.mockito.ArgumentMatchers.eq("lro_tool_call_id_remap"), any()))
                .thenReturn(Completable.complete());
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        fakeRunner.emit(
                lroEvent("partial-id", true, "Working", "confirm_action"),
                lroEvent("persisted-id", false, " persisted", "confirm_action"),
                lroEvent("reprise-id", false, "must not leak", "confirm_action"));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        List<Class<?>> visible = subscriber.events().stream()
                .filter(event -> !(event instanceof RunStartedEvent) && !(event instanceof RunFinishedEvent))
                .map(Object::getClass).toList();
        assertThat(visible).startsWith(
                com.agui.community.core.event.TextMessageStartEvent.class,
                com.agui.community.core.event.TextMessageContentEvent.class,
                com.agui.community.core.event.TextMessageEndEvent.class,
                com.agui.community.core.event.ToolCallStartEvent.class,
                com.agui.community.core.event.ToolCallArgsEvent.class);
        assertThat(subscriber.events().stream().filter(com.agui.community.core.event.TextMessageContentEvent.class::isInstance)
                .map(com.agui.community.core.event.TextMessageContentEvent.class::cast)
                .map(com.agui.community.core.event.TextMessageContentEvent::delta).toList())
                .contains("Working", " persisted").doesNotContain("must not leak");
        assertThat(subscriber.events()).filteredOn(com.agui.community.core.event.ToolCallEndEvent.class::isInstance)
                .containsExactly(new com.agui.community.core.event.ToolCallEndEvent("partial-id"));
        org.mockito.Mockito.verify(sessionManager).updateSessionState(any(),
                org.mockito.ArgumentMatchers.argThat(state -> Set.of("partial-id").equals(
                        state.get("pendingToolCallIds"))));
        assertThat(subscriber.events().stream().filter(com.agui.community.core.event.ToolCallStartEvent.class::isInstance)
                .map(com.agui.community.core.event.ToolCallStartEvent.class::cast)
                .map(com.agui.community.core.event.ToolCallStartEvent::toolCallId).toList())
                .containsExactly("partial-id");
        org.mockito.Mockito.verify(sessionManager).setStateValue(any(),
                org.mockito.ArgumentMatchers.eq("lro_tool_call_id_remap"),
                org.mockito.ArgumentMatchers.eq(Map.of("partial-id", "persisted-id")));
    }

    @Test
    void resumableLroDoesNotHardStopLaterProviderEvents() throws InterruptedException {
        agent = GoogleAdkAgent.builder().runner(fakeRunner).sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build()).configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> TEST_USER_ID).eventEncoder(event -> new EncodedEvent(event, "{}"))
                .adkResumable(true).build();
        clearInvocations(sessionManager);
        RunAgentInput input = createAgentInput(createUserMessage("resumable-lro"));
        ResolvedSession resolved = resolvedSession(input, Set.of());
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolved));
        when(sessionManager.getAuthoritativeSession("test-app", TEST_USER_ID, input.threadId()))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolved.session()));
        when(sessionManager.updateSessionState(any(), org.mockito.ArgumentMatchers.argThat(state ->
                state.containsKey("pendingToolCallIds")))).thenReturn(Completable.complete());
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        fakeRunner.emit(lroEvent("lro-id", false, "pause", "confirm_action"),
                com.google.adk.events.Event.builder().author("model").content(Content.builder().role("model")
                        .parts(com.google.genai.types.Part.fromText("continued")).build()).build());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events().stream().filter(com.agui.community.core.event.TextMessageContentEvent.class::isInstance)
                .map(com.agui.community.core.event.TextMessageContentEvent.class::cast)
                .map(com.agui.community.core.event.TextMessageContentEvent::delta).toList())
                .contains("pause", "continued");
    }

    @Test
    void ordinaryProviderEventsStillUseTheFullTranslator() throws InterruptedException {
        RunAgentInput input = createAgentInput(createUserMessage("ordinary"));
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        stubNoOpMutationGuard();
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        fakeRunner.emit(com.google.adk.events.Event.builder().author("model").content(Content.builder().role("model")
                .parts(com.google.genai.types.Part.builder().functionCall(com.google.genai.types.FunctionCall.builder()
                        .id("ordinary-id").name("backend_tool").args(Map.of("q", "1")).build()).build())
                .build()).build());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events().stream().filter(com.agui.community.core.event.ToolCallStartEvent.class::isInstance)
                .map(com.agui.community.core.event.ToolCallStartEvent.class::cast)
                .map(com.agui.community.core.event.ToolCallStartEvent::toolCallId).toList())
                .containsExactly("ordinary-id");
    }

    private static com.google.adk.events.Event lroEvent(
            String id, boolean partial, String text, String name) {
        return com.google.adk.events.Event.builder().author("model").partial(partial)
                .longRunningToolIds(Set.of(id)).content(Content.builder().role("model").parts(List.of(
                        com.google.genai.types.Part.fromText(text),
                        com.google.genai.types.Part.builder().functionCall(com.google.genai.types.FunctionCall.builder()
                                .id(id).name(name).args(Map.of("approved", true)).build()).build()))
                        .build()).build();
    }

    private GoogleAdkAgent createAgent(Function<RunAgentInput, String> userIdExtractor) {
        return createAgent(userIdExtractor, RunConfig.builder().build());
    }

    private GoogleAdkAgent createAgentWithoutEncoder(Function<RunAgentInput, String> userIdExtractor) {
        GoogleAdkAgent created = GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(userIdExtractor)
                .build();
        clearInvocations(sessionManager);
        return created;
    }

    private GoogleAdkAgent createAgent(
            Function<RunAgentInput, String> userIdExtractor,
            RunConfig baseConfig) {
        GoogleAdkAgent created = GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .baseRunConfig(baseConfig)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(userIdExtractor)
                .eventEncoder(event -> new EncodedEvent(event, "{}"))
                .build();
        clearInvocations(sessionManager);
        return created;
    }

    private GoogleAdkAgent createAgent(
            Function<RunAgentInput, String> userIdExtractor,
            RunConfig baseConfig,
            Set<String> backendToolNames) {
        GoogleAdkAgent created = GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .baseRunConfig(baseConfig)
                .configuredBackendToolNames(backendToolNames)
                .userIdExtractor(userIdExtractor)
                .eventEncoder(event -> new EncodedEvent(event, "{}"))
                .build();
        clearInvocations(sessionManager);
        return created;
    }

    private GoogleAdkAgent createAgent(
            Function<RunAgentInput, String> userIdExtractor,
            RunConfig baseConfig,
            MessageReservationStore reservationStore) {
        GoogleAdkAgent created = GoogleAdkAgent.builder()
                .runner(fakeRunner)
                .sessionManager(sessionManager)
                .baseRunConfig(baseConfig)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(userIdExtractor)
                .eventEncoder(event -> new EncodedEvent(event, "{}"))
                .messageReservationStore(reservationStore)
                .build();
        clearInvocations(sessionManager);
        return created;
    }

    private void assertInvalidRunBeforeAdk(
            RunAgentInput input,
            String detail) throws InterruptedException {
        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events()).startsWith(
                new RunStartedEvent(input.threadId(), input.runId()),
                new RunErrorEvent("Invalid run input", "INVALID_RUN_INPUT", null, null));
        assertThat(fakeRunner.runCount()).isZero();
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static UserMessage createUserMessage(String messageId) {
        return new UserMessage(messageId, "Hello");
    }

    private static RunAgentInput createAgentInput(UserMessage userMessage) {
        return createAgentInput(userMessage, List.of());
    }

    private static RunAgentInput createAgentInput(UserMessage userMessage, List<Tool> tools) {
        return createAgentInput(List.of(userMessage), tools, Map.of());
    }

    private static RunAgentInput createAgentInput(
            List<Message> messages,
            List<Tool> tools,
            Object forwardedProps) {
        return new RunAgentInput(
                "thread-1",
                "run-1",
                Map.of(),
                messages,
                tools,
                List.of(new Context("appName", "test-app")),
                forwardedProps);
    }

    private static ResolvedSession resolvedSession(RunAgentInput input, Set<String> processedIds) {
        Map<String, String> fingerprints = input.messages().stream()
                .filter(message -> processedIds.contains(message.id()))
                .collect(Collectors.toMap(
                        Message::id,
                        com.agui.adk.message.MessageFingerprint::of));
        Session session = Session.builder(input.threadId())
                .appName("test-app")
                .userId(TEST_USER_ID)
                .state(Map.of(
                        "processedMessageIds", processedIds,
                        "_ag_ui_message_fingerprints", fingerprints))
                .build();
        return new ResolvedSession(session, new SessionMapping(
                new SessionMappingKey("test-app", TEST_USER_ID, input.threadId()), input.threadId()));
    }

    private static final class ControllableReservationStore implements MessageReservationStore {
        private final Completable rollback;

        private ControllableReservationStore(Completable rollback) {
            this.rollback = rollback;
        }

        @Override
        public Single<MessageReservation> reserve(
                ResolvedSession session,
                List<Message> messages,
                String invocationId) {
            return Single.just(new MessageReservation(session, messages, invocationId));
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.complete();
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return rollback;
        }
    }

    private static final class FakeAdkRunnerClient implements AdkRunnerClient {
        private final CountDownLatch firstRun = new CountDownLatch(1);
        private int runCount;
        private String lastUserId;
        private String lastSessionId;
        private Content lastContent;
        private RunConfig lastRunConfig;
        private Map<String, Object> lastStateDelta = Map.of();
        private Throwable failure;
        private List<com.google.adk.events.Event> emittedEvents = List.of();
        private boolean neverCompletes;

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
            runCount++;
            firstRun.countDown();
            lastUserId = userId;
            lastSessionId = sessionId;
            lastContent = content;
            lastRunConfig = runConfig;
            lastStateDelta = Map.copyOf(stateDelta);
            if (neverCompletes) {
                return Flowable.never();
            }
            return failure == null ? Flowable.fromIterable(emittedEvents) : Flowable.error(failure);
        }

        int runCount() {
            return runCount;
        }

        boolean awaitFirstRun() throws InterruptedException {
            return firstRun.await(5, TimeUnit.SECONDS);
        }

        String lastUserId() {
            return lastUserId;
        }

        String lastSessionId() {
            return lastSessionId;
        }

        Content lastContent() {
            return lastContent;
        }

        RunConfig lastRunConfig() {
            return lastRunConfig;
        }

        Map<String, Object> lastStateDelta() {
            return lastStateDelta;
        }

        List<String> visibleToolNames() {
            return AdkAgUiRunContext.from(lastRunConfig).orElseThrow().input().tools().stream()
                    .map(Tool::name)
                    .toList();
        }

        void emit(com.google.adk.events.Event... events) {
            emittedEvents = List.of(events);
        }

        void failWith(Throwable value) {
            failure = value;
        }

        void clearFailure() {
            failure = null;
        }

        void neverComplete() {
            neverCompletes = true;
        }

        void completeNormally() {
            neverCompletes = false;
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private Throwable error;
        private Flow.Subscription subscription;

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

        List<Event> events() {
            return events;
        }

        Throwable error() {
            return error;
        }

        void cancel() {
            subscription.cancel();
        }
    }

    private static final class CancellingSubscriber implements Flow.Subscriber<Event> {
        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            subscription.cancel();
        }

        @Override
        public void onNext(Event item) {
        }

        @Override
        public void onError(Throwable throwable) {
        }

        @Override
        public void onComplete() {
        }
    }
}
